import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import {
  rootDir, dataDir, dbPath, pidFile, port, wsPort, host, authToken, iconPath,
  isLoopback, assertNetworkConfig,
} from './config.js';
import {
  db, getSettings, setSettings, DEFAULT_SETTINGS,
  listTopics, getTopic, createTopic, updateTopic, deleteTopic, mergeTopics,
  listSessions, getSession, updateSession, createManualSession, deleteSession, deleteSessions,
  countSessions, statsByTopic, dailyTotals, todaySeconds, transaction,
} from './db.js';
import { timer } from './timer.js';

assertNetworkConfig();

await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(pidFile, String(process.pid), 'utf-8');

function notify(title, body) {
  execFile('notify-send', ['-i', iconPath, String(title), String(body)], () => { });
}

function fmtDuration(sec) {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// --- WebSocket ---------------------------------------------------------------

const clients = new Set();
function broadcast(obj) {
  const raw = JSON.stringify(obj);
  for (const c of clients) { try { c.send(raw); } catch { } }
}

timer.on('state', (payload) => broadcast({ type: 'state', payload }));
timer.on('complete', (session) => {
  broadcast({ type: 'session:complete', payload: session });
  notify('90 Minutos — Sesión guardada', `${session.topic} · ${fmtDuration(session.durationSec)}`);
});
timer.on('started', ({ session }) => {
  const target = session.mode === 'sprint' ? ` · objetivo ${fmtDuration(session.plannedSec)}` : ' · modo abierto';
  notify('90 Minutos — Contando', `${session.topic}${target}`);
});
timer.on('sprint:end', (state) => {
  broadcast({ type: 'alarm', payload: state });
  notify('90 Minutos — Objetivo alcanzado', `${state.topic} · sigue contando en prórroga`);
});
timer.on('discarded', (session) => notify('90 Minutos — Sesión descartada', `${session.topic} · no se ha guardado`));

// --- Servidor HTTP -----------------------------------------------------------

const app = express();
app.use(express.json({ limit: '10mb' }));

const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${port}`, `http://localhost:${port}`,
  ...(isLoopback ? [] : [`http://${host}:${port}`]),
]);
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Confirm-Delete,X-Auth-Token');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Token solo cuando está configurado (en loopback no hace falta). El navegador no
// puede poner cabeceras al cargar el dashboard, así que se acepta ?token= una vez
// y se recuerda en una cookie.
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
if (authToken) {
  app.use((req, res, next) => {
    const supplied = req.headers['x-auth-token'] || req.query.token || readCookie(req, 'token');
    if (supplied === authToken) {
      if (req.query.token) {
        res.setHeader('Set-Cookie', `token=${encodeURIComponent(authToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
      }
      return next();
    }
    res.status(401).json({ error: 'Token inválido o ausente' });
  });
}

app.use('/overlay', express.static(path.join(rootDir, 'overlay')));
app.use('/dashboard', express.static(path.join(rootDir, 'dashboard')));

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
};

// --- Ajustes -----------------------------------------------------------------

app.get('/api/settings', (req, res) => res.json(getSettings()));
app.post('/api/settings', wrap(async (req, res) => {
  const saved = setSettings(req.body || {});
  res.json(saved);
  broadcast({ type: 'settings:update', payload: saved });
  timer.emit('state', timer.snapshot());
}));

// --- Temas -------------------------------------------------------------------

app.get('/api/topics', (req, res) => {
  res.json(listTopics({ includeArchived: req.query.all === 'true' }));
});
app.post('/api/topics', wrap(async (req, res) => {
  res.json(createTopic(req.body || {}));
  broadcast({ type: 'topics:update' });
}));
app.patch('/api/topics/:id', wrap(async (req, res) => {
  const topic = updateTopic(req.params.id, req.body || {});
  if (!topic) return res.status(404).json({ error: 'Tema no encontrado' });
  res.json(topic);
  broadcast({ type: 'topics:update' });
  timer.emit('state', timer.snapshot());
}));
app.delete('/api/topics/:id', wrap(async (req, res) => {
  const result = deleteTopic(req.params.id);
  if (!result.ok && result.reason === 'not_found') return res.status(404).json({ error: 'Tema no encontrado' });
  if (!result.ok && result.reason === 'has_sessions') {
    return res.status(409).json({
      error: `El tema tiene ${result.sessionCount} sesiones. Archívalo o fusiónalo con otro para no perder historial.`,
      sessionCount: result.sessionCount,
    });
  }
  res.json(result);
  broadcast({ type: 'topics:update' });
}));
app.post('/api/topics/:id/merge', wrap(async (req, res) => {
  const result = mergeTopics(req.params.id, (req.body || {}).targetId);
  res.json(result);
  broadcast({ type: 'topics:update' });
}));

// --- Timer -------------------------------------------------------------------

app.get('/api/state', (req, res) => res.json(timer.snapshot()));

app.post('/api/timer/start', wrap(async (req, res) => {
  const body = req.body || {};
  // Aceptamos nombre de tema además de id: es lo cómodo desde el CLI.
  let topicId = body.topicId;
  if (!topicId && body.topic) {
    const found = listTopics({ includeArchived: true }).find(t => t.name.toLowerCase() === String(body.topic).toLowerCase());
    if (!found) throw new Error(`No existe el tema "${body.topic}"`);
    topicId = found.id;
  }
  const plannedSec = body.plannedSec ?? (body.plannedMin ? Number(body.plannedMin) * 60 : undefined);
  const { session, previous } = timer.start({ ...body, topicId, plannedSec });
  res.json({ ok: true, session, previous, state: timer.snapshot() });
}));
app.post('/api/timer/pause', wrap(async (req, res) => res.json({ ok: true, state: timer.pause() })));
app.post('/api/timer/resume', wrap(async (req, res) => res.json({ ok: true, state: timer.resume() })));
app.post('/api/timer/stop', wrap(async (req, res) => {
  const session = timer.stop();
  res.json({ ok: true, session, state: timer.snapshot() });
}));
app.post('/api/timer/discard', wrap(async (req, res) => {
  const session = timer.discard();
  res.json({ ok: true, session, state: timer.snapshot() });
}));
app.post('/api/timer/extend', wrap(async (req, res) => {
  const body = req.body || {};
  const sec = body.sec ?? (body.min ? Number(body.min) * 60 : 0);
  res.json({ ok: true, state: timer.extend(sec) });
}));
app.post('/api/timer/mode', wrap(async (req, res) => {
  const body = req.body || {};
  const plannedSec = body.plannedSec ?? (body.plannedMin ? Number(body.plannedMin) * 60 : undefined);
  res.json({ ok: true, state: timer.setMode(body.mode, plannedSec) });
}));
app.post('/api/timer/meta', wrap(async (req, res) => res.json({ ok: true, state: timer.setMeta(req.body || {}) })));

// --- Sesiones ----------------------------------------------------------------

app.get('/api/sessions', (req, res) => {
  const { from, to, topicId, limit, offset } = req.query;
  res.json(listSessions({ from, to, topicId, limit, offset }));
});
app.post('/api/sessions', wrap(async (req, res) => res.json(createManualSession(req.body || {}))));
app.patch('/api/sessions/:id', wrap(async (req, res) => {
  const session = updateSession(req.params.id, req.body || {});
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  res.json(session);
}));
app.delete('/api/sessions/:id', wrap(async (req, res) => {
  res.json({ ok: true, removed: deleteSession(req.params.id) });
}));
app.post('/api/sessions/bulk-delete', wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  res.json({ ok: true, removed: ids.length ? deleteSessions(ids) : 0 });
}));
app.delete('/api/sessions', wrap(async (req, res) => {
  if (req.headers['x-confirm-delete'] !== 'true') {
    return res.status(400).json({ error: 'Requiere cabecera X-Confirm-Delete: true' });
  }
  const removed = db.prepare(`DELETE FROM sessions`).run().changes;
  res.json({ ok: true, removed });
}));

// --- Estadísticas ------------------------------------------------------------

app.get('/api/stats', (req, res) => {
  const { from, to } = req.query;
  res.json({
    byTopic: statsByTopic({ from, to }),
    daily: dailyTotals({ from, to }),
    todaySec: todaySeconds(),
    count: countSessions(),
  });
});

app.get('/api/export.csv', (req, res) => {
  const { from, to, topicId } = req.query;
  const rows = listSessions({ from, to, topicId, includeActive: false });
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = 'Tema,Inicio,Fin,DuracionMin,DuracionHHMMSS,Modo,Idioma,Tipo,URL,Notas';
  const body = rows.map(s => {
    const sec = s.durationSec;
    const hhmmss = [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60]
      .map(n => String(n).padStart(2, '0')).join(':');
    return [
      esc(s.topic), esc(s.startISO), esc(s.endISO), s.durationMin.toFixed(2), hhmmss,
      esc(s.mode), esc(s.language), esc(s.sessionType), esc(s.url), esc(s.notes),
    ].join(',');
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="90minutos_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send([header, ...body].join('\n'));
});

// --- Backup / Restore --------------------------------------------------------

app.get('/api/backup', (req, res) => {
  res.json({
    version: 2,
    exportedAt: new Date().toISOString(),
    settings: getSettings(),
    topics: listTopics({ includeArchived: true }),
    sessions: listSessions({ includeActive: false }),
  });
});

app.post('/api/restore', wrap(async (req, res) => {
  const { settings, topics, sessions, version } = req.body || {};
  if (!Array.isArray(sessions) || !Array.isArray(topics)) {
    return res.status(400).json({ error: 'Formato de backup inválido (se esperan topics y sessions)' });
  }
  if (Number(version) !== 2) {
    return res.status(400).json({ error: `Backup versión ${version}: usa migrate/json-to-sqlite.mjs para formatos antiguos` });
  }

  let restored = 0;
  transaction(() => {
    db.prepare(`DELETE FROM sessions`).run();
    db.prepare(`DELETE FROM topics`).run();

    const byName = new Map();
    for (const t of topics) {
      const info = db.prepare(`INSERT INTO topics (name, color, archived, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(t.name, t.color || null, t.archived ? 1 : 0, Number(t.sortOrder) || 0, new Date().toISOString());
      byName.set(t.name, info.lastInsertRowid);
    }
    const insertSession = db.prepare(`
      INSERT INTO sessions (topic_id, mode, planned_sec, started_at, ended_at, heartbeat_at,
                            notes, url, language, session_type, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSegment = db.prepare(`INSERT INTO segments (session_id, started_at, ended_at) VALUES (?, ?, ?)`);
    for (const s of sessions) {
      const topicId = byName.get(s.topic);
      if (!topicId) continue;
      const end = s.endISO || new Date(new Date(s.startISO).getTime() + (s.durationSec || 0) * 1000).toISOString();
      const id = insertSession.run(
        topicId, s.mode === 'sprint' ? 'sprint' : 'open', s.plannedSec ?? null,
        s.startISO, end, end, s.notes || null, s.url || null, s.language || null,
        s.sessionType || null, ['timer', 'import', 'manual'].includes(s.source) ? s.source : 'manual',
      ).lastInsertRowid;
      insertSegment.run(id, s.startISO, end);
      restored++;
    }
  });
  if (settings) setSettings(settings);
  res.json({ ok: true, sessions: restored, topics: topics.length });
  broadcast({ type: 'topics:update' });
}));

// --- Salud -------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  const state = timer.snapshot();
  res.json({
    ok: true,
    pid: process.pid,
    uptime: fmtDuration(process.uptime()),
    db: dbPath,
    sessions: countSessions(),
    wsClients: clients.size,
    wsPort,
    timer: {
      state: state.state,
      mode: state.mode,
      topic: state.topic,
      elapsed: fmtDuration(state.elapsedSec),
      remaining: state.remainingSec == null ? null : fmtDuration(state.remainingSec),
      today: fmtDuration(state.todaySec),
    },
  });
});

app.get('/', (req, res) => res.redirect('/dashboard/index.html'));

// --- Arranque ----------------------------------------------------------------

const httpServer = app.listen(port, host, () => {
  console.log(`[90Minutos] HTTP    http://${host}:${port}`);
  console.log(`[90Minutos] Datos   ${dbPath}`);
  if (!isLoopback) console.log('[90Minutos] Accesible en la red — protegido con AUTH_TOKEN');
});

const wss = new WebSocketServer({ port: wsPort, host });
wss.on('connection', (ws, req) => {
  if (authToken) {
    const url = new URL(req.url || '/', `http://${host}`);
    const supplied = url.searchParams.get('token') || readCookie(req, 'token');
    if (supplied !== authToken) { ws.close(4401, 'Token inválido'); return; }
  }
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'state', payload: timer.snapshot() }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// Al arrancar, cerrar lo que quedó a medias por un corte y retomar lo que seguía vivo.
const recovered = timer.recover();
if (recovered?.interrupted) {
  const s = recovered.session;
  console.log(`[90Minutos] Recuperada sesión interrumpida: ${s.topic} · ${fmtDuration(s.durationSec)} (en pausa)`);
  notify('90 Minutos — Sesión recuperada', `${s.topic} · ${fmtDuration(s.durationSec)} · en pausa`);
}
timer.resumeTickingIfRunning();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[90Minutos] ${signal} — apagando…`);
  timer.shutdown();
  wss.close();
  httpServer.close();
  fs.unlink(pidFile).catch(() => { });
  try { db.close(); } catch { }
  setTimeout(() => process.exit(0), 150);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
