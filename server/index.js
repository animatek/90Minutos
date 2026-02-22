import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import dotenv from 'dotenv';
import { readJSON, writeJSON, paths } from './storage.js';
import { beginAuth, handleCallback, createCalendarEvent, generateICS, hasGoogleAuth, appendToSheet, listSheetRows } from './google.js';
import { startTelegramBot, sendStatus } from './telegram.js';
import { DEVICES, PRESETS, turnOn, turnOff, allOn, allOff, applyPreset } from './govee.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const pidFile = path.join(rootDir, '.server.pid');

// Write PID file for stop script
await fs.writeFile(pidFile, String(process.pid), 'utf-8');

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[90Minutos] ${signal} recibido — apagando servidor…`);
  if (tickTimer) clearInterval(tickTimer);
  wss.close();
  fs.unlink(pidFile).catch(() => { });
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const defaultConfig = {
  defaultDurationMin: 90,
  categories: ["Octatrack", "Digitakt", "Oxi One", "Bitwig"],
  categoryColors: {},
  theme: "auto",
  opacity: 0.85,
  timezone: "Europe/Madrid",
  languages: ["ES", "EN"],
  defaultLanguage: "ES",
  defaultSessionType: "privada"
};

async function ensureInitialFiles() {
  await fs.mkdir(paths.dataDir, { recursive: true });
  try { await fs.access(paths.sessionsFile); } catch { await writeJSON('sessions.json', []); }
  try { await fs.access(paths.configFile); } catch { await writeJSON('config.json', defaultConfig); }
  await fs.mkdir(paths.sessionsOutDir, { recursive: true });
}
await ensureInitialFiles();

let state = 'idle';
let cfg = await readJSON('config.json', defaultConfig);
let durationSec = cfg.defaultDurationMin * 60;
let remainingSec = durationSec;
let startedAt = null;
let category = cfg.categories?.[0] || 'General';
let sessionName = category;
let language = cfg.defaultLanguage || 'ES';
let sessionType = cfg.defaultSessionType || 'privada';
let sessionUrl = '';

// Pomodoro
let pomodoroEnabled = false;
let pomodoroWorkMin = 25;
let pomodoroBreakMin = 5;
let pomodoroRounds = 4;
let pomodoroCurrentRound = 0;
let pomodoroPhase = 'work'; // 'work' | 'break'

let tickTimer = null;

function now() { return new Date(); }

const clients = new Set();
function broadcast(obj) { const raw = JSON.stringify(obj); for (const c of clients) { try { c.send(raw); } catch { } } }
function pushState() {
  broadcast({
    type: 'state', payload: {
      state, durationSec, remainingSec, category, sessionName, language, sessionType, sessionUrl,
      startedAtISO: startedAt ? startedAt.toISOString() : null,
      pomodoro: pomodoroEnabled ? { enabled: true, phase: pomodoroPhase, round: pomodoroCurrentRound, totalRounds: pomodoroRounds, workMin: pomodoroWorkMin, breakMin: pomodoroBreakMin } : { enabled: false }
    }
  });
}

const iconPath = path.join(rootDir, 'icon', '90.png');
function notify(title, body) {
  execFile('notify-send', ['-i', iconPath, String(title), String(body)], () => { });
}

function startTimer() {
  if (state === 'running') return;
  const fresh = state === 'idle';
  if (fresh) { remainingSec = durationSec; startedAt = now(); }
  state = 'running';
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    remainingSec = Math.max(0, remainingSec - 1);
    if (remainingSec <= 0) { clearInterval(tickTimer); tickTimer = null; completeSession(); }
    pushState();
  }, 1000);
  pushState();
  if (fresh) {
    const min = Math.round(durationSec / 60);
    notify('90 Minutos — Sesión iniciada', `${category} · ${min} min`);
    // Auto-lights: apply preset mapped to category
    autoLightsForCategory(category);
  }
}
function pauseTimer() { if (state !== 'running') return; state = 'paused'; if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } pushState(); }
function resumeTimer() {
  if (state !== 'paused') return; state = 'running';
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    remainingSec = Math.max(0, remainingSec - 1);
    if (remainingSec <= 0) { clearInterval(tickTimer); tickTimer = null; completeSession(); }
    pushState();
  }, 1000);
  pushState();
}
function resetTimer() { state = 'idle'; if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } remainingSec = durationSec; startedAt = null; pushState(); }
function addSeconds(s) { const add = Number(s) || 0; remainingSec = Math.max(0, remainingSec + add); pushState(); }
function setCategoryValue(cat) { if (!cat) return; category = String(cat); sessionName = category; pushState(); }
function setSessionNameValue(name) { if (typeof name === 'undefined' || name === null) return; sessionName = String(name); pushState(); }
function setLanguageValue(lang) { if (!lang) return; language = String(lang); pushState(); }
function setSessionTypeValue(t) { if (!t) return; sessionType = String(t); pushState(); }
function setSessionUrlValue(url) { sessionUrl = (url ?? '').toString(); pushState(); }
function setDurationSeconds(sec) { const s = Math.max(1, Number(sec) || 5400); durationSec = s; if (state === 'idle') remainingSec = durationSec; pushState(); }

async function autoLightsForCategory(cat) {
  try {
    const currentCfg = await readJSON('config.json', defaultConfig);
    const mapping = currentCfg.categoryLightPresets || {};
    const presetName = mapping[cat];
    if (presetName && PRESETS[presetName]) {
      await applyPreset(presetName);
      console.log(`[AutoLights] Categoria "${cat}" -> preset "${presetName}"`);
    }
  } catch (e) { console.warn('[AutoLights] Error:', e.message); }
}

async function appendCSV(session) {
  const hdr = 'Categoria,DuracionMin,Lenguaje,Fecha,Sesion,DuracionHHMMSS\n';
  const startDate = new Date(session.startISO);
  const yyyy = startDate.getFullYear(); const mm = String(startDate.getMonth() + 1).padStart(2, '0'); const dd = String(startDate.getDate()).padStart(2, '0');
  const fecha = `${yyyy}-${mm}-${dd}`;

  const sec = session.durationSec || (session.durationMin * 60);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const hhmmss = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  const csvLine = `"${(session.category || '').replace(/"/g, '""')}",` +
    `"${session.durationMin || ''}",` +
    `"${(session.language || '').replace(/"/g, '""')}",` +
    `"${fecha}",` +
    `"${(session.sessionType || '').replace(/"/g, '""')}",` +
    `"${hhmmss}"\n`;
  const outPath = path.join(paths.sessionsOutDir, 'sessions_log.csv');
  try { await fs.access(outPath); } catch { await fs.writeFile(outPath, hdr, 'utf-8'); }
  await fs.appendFile(outPath, csvLine, 'utf-8');
}

async function completeSession() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  const end = now();
  const start = startedAt || end;

  const totalSec = Math.max(1, Math.round((end - start) / 1000));
  const durationMin = Math.round(totalSec / 60);

  const session = {
    id: Date.now(),
    startISO: start.toISOString(), endISO: end.toISOString(),
    durationMin, durationSec: totalSec,
    category, language, sessionType, sessionName, url: sessionUrl
  };
  try {
    if (await hasGoogleAuth()) { const id = await createCalendarEvent(session); session.calendarEventId = id; }
    else { const icsPath = await generateICS(session); session.icsPath = icsPath; }
  } catch (e) { const icsPath = await generateICS(session); session.icsPath = icsPath; }

  const sessions = await readJSON('sessions.json', []); sessions.push(session); await writeJSON('sessions.json', sessions);

  try { const sheetRow = await appendToSheet(session); if (typeof sheetRow === 'number') session.sheetRow = sheetRow; } catch (e) { await appendCSV(session); }

  broadcast({ type: 'session:complete', payload: session });
  notify('90 Minutos — Sesión completada', `${session.category} · ${session.durationMin} min`);

  // Pomodoro: auto-transition
  if (pomodoroEnabled) {
    if (pomodoroPhase === 'work') {
      pomodoroCurrentRound++;
      if (pomodoroCurrentRound >= pomodoroRounds) {
        // All rounds done
        pomodoroPhase = 'work'; pomodoroCurrentRound = 0;
        state = 'idle'; remainingSec = durationSec; startedAt = null; sessionUrl = '';
        notify('Pomodoro completo', `${pomodoroRounds} rounds finalizados`);
        pushState();
      } else {
        // Start break
        pomodoroPhase = 'break';
        durationSec = pomodoroBreakMin * 60;
        remainingSec = durationSec; startedAt = now();
        state = 'running';
        tickTimer = setInterval(() => {
          remainingSec = Math.max(0, remainingSec - 1);
          if (remainingSec <= 0) { clearInterval(tickTimer); tickTimer = null; pomodoroBreakDone(); }
          pushState();
        }, 1000);
        notify('Pomodoro — Descanso', `${pomodoroBreakMin} min de break (round ${pomodoroCurrentRound}/${pomodoroRounds})`);
        pushState();
      }
    } else {
      // Break just ended, handled by pomodoroBreakDone
      pomodoroBreakDone();
    }
    return;
  }

  state = 'idle'; remainingSec = durationSec; startedAt = null; sessionUrl = ''; pushState();
}

function pomodoroBreakDone() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  pomodoroPhase = 'work';
  durationSec = pomodoroWorkMin * 60;
  remainingSec = durationSec; startedAt = now();
  state = 'running';
  tickTimer = setInterval(() => {
    remainingSec = Math.max(0, remainingSec - 1);
    if (remainingSec <= 0) { clearInterval(tickTimer); tickTimer = null; completeSession(); }
    pushState();
  }, 1000);
  notify('Pomodoro — A trabajar', `Round ${pomodoroCurrentRound + 1}/${pomodoroRounds}`);
  pushState();
}

const port = process.env.PORT || 5173;
const app = express(); app.use(express.json());
const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
]);
app.use((req, res, next) => {
  const o = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Confirm-Delete');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/overlay', express.static(path.join(rootDir, 'overlay')));
app.use('/dashboard', express.static(path.join(rootDir, 'dashboard')));
app.use('/sessions', express.static(path.join(rootDir, 'sessions')));

app.get('/api/config', async (req, res) => { const cfg = await readJSON('config.json', defaultConfig); res.json(cfg); });
const CONFIG_ALLOWED_KEYS = ['defaultDurationMin', 'categories', 'categoryColors', 'theme', 'opacity', 'timezone', 'languages', 'defaultLanguage', 'defaultSessionType', 'templates', 'categoryLightPresets'];
app.post('/api/config', async (req, res) => {
  const current = await readJSON('config.json', defaultConfig);
  const body = req.body || {};
  const filtered = {};
  for (const k of CONFIG_ALLOWED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) filtered[k] = body[k];
  }
  const merged = { ...current, ...filtered };
  await writeJSON('config.json', merged);
  if (typeof merged.defaultDurationMin === 'number') { setDurationSeconds(Math.max(60, Math.round(merged.defaultDurationMin) * 60)); }
  res.json(merged); broadcast({ type: 'config:update', payload: merged });
});
app.get('/api/sessions', async (req, res) => { const sessions = await readJSON('sessions.json', []); res.json(sessions); });

app.delete('/api/sessions', async (req, res) => {
  if (req.headers['x-confirm-delete'] !== 'true') {
    return res.status(400).json({ error: 'Requiere header X-Confirm-Delete: true' });
  }
  await writeJSON('sessions.json', []);
  res.json({ ok: true });
});
app.delete('/api/sessions/:id', async (req, res) => {
  const id = Number(req.params.id);
  let sessions = await readJSON('sessions.json', []);
  const before = sessions.length;
  sessions = sessions.filter(s => Number(s.id) !== id);
  await writeJSON('sessions.json', sessions);
  res.json({ ok: true, removed: before - sessions.length });
});


app.put('/api/sessions/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    let sessions = await readJSON('sessions.json', []);
    const i = sessions.findIndex(s => Number(s.id) === id);
    if (i === -1) { res.status(404).json({ error: 'not found' }); return; }
    const allowed = ['url', 'sessionName', 'category', 'language', 'sessionType', 'durationMin', 'durationSec', 'startISO', 'endISO', 'notes'];
    const body = req.body || {};
    const update = {};
    for (const k of allowed) { if (Object.prototype.hasOwnProperty.call(body, k)) update[k] = body[k]; }
    sessions[i] = { ...sessions[i], ...update };
    await writeJSON('sessions.json', sessions);
    res.json(sessions[i]);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.post('/api/sessions/bulk-delete', async (req, res) => {
  try {
    const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
    if (!ids.length) return res.json({ ok: true, removed: 0 });
    let sessions = await readJSON('sessions.json', []);
    const idSet = new Set(ids);
    const before = sessions.length;
    sessions = sessions.filter(s => !idSet.has(Number(s.id)));
    await writeJSON('sessions.json', sessions);
    res.json({ ok: true, removed: before - sessions.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Duplicate session
app.post('/api/sessions', async (req, res) => {
  try {
    const body = req.body || {};
    const allowed = ['url', 'sessionName', 'category', 'language', 'sessionType', 'durationMin', 'durationSec', 'startISO', 'endISO', 'notes'];
    const session = { id: Date.now() };
    for (const k of allowed) { if (Object.prototype.hasOwnProperty.call(body, k)) session[k] = body[k]; }
    if (!session.startISO) session.startISO = new Date().toISOString();
    if (!session.endISO) {
      const dur = (session.durationSec || (session.durationMin || 0) * 60) * 1000;
      session.endISO = new Date(new Date(session.startISO).getTime() + dur).toISOString();
    }
    const sessions = await readJSON('sessions.json', []);
    sessions.push(session);
    await writeJSON('sessions.json', sessions);
    res.json(session);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Backup & Restore
app.get('/api/backup', async (req, res) => {
  const config = await readJSON('config.json', defaultConfig);
  const sessions = await readJSON('sessions.json', []);
  res.json({ version: 1, exportedAt: new Date().toISOString(), config, sessions });
});
app.post('/api/restore', async (req, res) => {
  try {
    const { config, sessions } = req.body || {};
    if (!config || !Array.isArray(sessions)) return res.status(400).json({ error: 'Formato de backup invalido' });
    const filtered = {};
    for (const k of CONFIG_ALLOWED_KEYS) { if (Object.prototype.hasOwnProperty.call(config, k)) filtered[k] = config[k]; }
    const current = await readJSON('config.json', defaultConfig);
    await writeJSON('config.json', { ...current, ...filtered });
    await writeJSON('sessions.json', sessions);
    res.json({ ok: true, sessions: sessions.length });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/stats', async (req, res) => {
  const sessions = await readJSON('sessions.json', []);
  const byCatMin = {};
  for (const s of sessions) {
    const min = (s.durationSec ? s.durationSec / 60 : s.durationMin || 0);
    byCatMin[s.category] = (byCatMin[s.category] || 0) + min;
  }
  const totalHours = Object.fromEntries(Object.entries(byCatMin).map(([k, v]) => [k, +(v / 60).toFixed(2)]));
  res.json({ totalsMin: byCatMin, totalsHours: totalHours, count: sessions.length });
});
app.get('/api/state', (req, res) => { res.json({ state, durationSec, remainingSec, category, sessionName, language, sessionType, sessionUrl, startedAtISO: startedAt ? startedAt.toISOString() : null, pomodoro: pomodoroEnabled ? { enabled: true, phase: pomodoroPhase, round: pomodoroCurrentRound, totalRounds: pomodoroRounds, workMin: pomodoroWorkMin, breakMin: pomodoroBreakMin } : { enabled: false } }); });

app.get('/api/health', (req, res) => {
  const uptimeSec = Math.floor(process.uptime());
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const uptime = h > 0 ? `${h}h ${m}m` : `${m}m`;
  const remaining = (() => {
    const rm = Math.floor(remainingSec / 60);
    const rs = remainingSec % 60;
    return `${rm}m ${String(rs).padStart(2, '0')}s`;
  })();
  res.json({
    ok: true, pid: process.pid, uptime,
    timer: { state, remaining, category, sessionName },
    wsClients: clients.size
  });
});

app.post('/api/telegram/status', async (req, res) => {
  try {
    const sent = await sendStatus();
    res.json({ ok: sent });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Google & Sheets
app.get('/api/google/auth', beginAuth);
app.get('/api/google/callback', handleCallback);
app.get('/api/sheet/id', (req, res) => {
  const id = process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID || null;
  res.json({ sheetId: id });
});
app.post('/api/sessions/importFromSheets', async (req, res) => {
  // Reconstruye sessions.json a partir de las filas del Sheet
  try {
    const rows = await listSheetRows(); // [{categoria,duracion,lenguaje,fecha,sesion}]
    const sessions = [];
    for (const r of rows) {
      if (!r.fecha) continue; // saltar filas vacías
      // fecha en YYYY-MM-DD
      const startLocal = new Date(r.fecha + 'T12:00:00'); // medio día local
      if (isNaN(startLocal.getTime())) continue; // saltar fechas inválidas
      const endLocal = new Date(startLocal.getTime() + (r.duracion || 0) * 60 * 1000);
      sessions.push({
        id: startLocal.getTime(),
        startISO: startLocal.toISOString(),
        endISO: endLocal.toISOString(),
        durationMin: Math.round((r.duracion || 0)),
        durationSec: (r.duracion || 0) * 60,
        category: r.categoria || '',
        language: r.lenguaje || '',
        sessionType: r.sesion || '',
        sessionName: r.categoria || '',
        url: r.url || ''
      });
    }
    await writeJSON('sessions.json', sessions);
    res.json({ ok: true, imported: sessions.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Govee Lights API
app.get('/api/lights/devices', (req, res) => res.json(DEVICES));
app.get('/api/lights/presets', (req, res) => res.json(PRESETS));

app.post('/api/lights/on', async (req, res) => {
  try { await allOn(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/lights/off', async (req, res) => {
  try { await allOff(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/lights/:device/on', async (req, res) => {
  const dev = DEVICES[req.params.device];
  if (!dev) return res.status(404).json({ error: 'dispositivo no encontrado' });
  try { await turnOn(dev); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/lights/:device/off', async (req, res) => {
  const dev = DEVICES[req.params.device];
  if (!dev) return res.status(404).json({ error: 'dispositivo no encontrado' });
  try { await turnOff(dev); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/lights/preset/:name', async (req, res) => {
  const name = req.params.name;
  if (!PRESETS[name]) return res.status(404).json({ error: 'preset no encontrado' });
  try { await applyPreset(name); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.redirect('/dashboard/index.html'));

app.listen(port, '127.0.0.1', () => console.log(`[Animatek Timer] HTTP en http://127.0.0.1:${port}`));

const wss = new WebSocketServer({ port: 8765, host: '127.0.0.1' });
wss.on('connection', (ws) => {
  clients.add(ws); pushState();
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg && msg.type === 'command') {
        const a = msg.action; const p = msg.payload;
        switch (a) {
          case 'start': startTimer(); break;
          case 'pause': pauseTimer(); break;
          case 'resume': resumeTimer(); break;
          case 'reset': resetTimer(); break;
          case 'finish': if (state !== 'idle') completeSession(); break;
          case 'add': addSeconds(p || 0); break;
          case 'setCategory': setCategoryValue(p); break;
          case 'setSessionName': setSessionNameValue(p); break;
          case 'setDurationSec': setDurationSeconds(p); break;
          case 'setLanguage': setLanguageValue(p); break;
          case 'setSessionType': setSessionTypeValue(p); break;
          case 'setSessionUrl': setSessionUrlValue(p); break;
          case 'setPomodoroEnabled': pomodoroEnabled = !!p; if (!pomodoroEnabled) { pomodoroPhase = 'work'; pomodoroCurrentRound = 0; } pushState(); break;
          case 'setPomodoroWork': pomodoroWorkMin = Math.max(1, Number(p) || 25); pushState(); break;
          case 'setPomodoroBreak': pomodoroBreakMin = Math.max(1, Number(p) || 5); pushState(); break;
          case 'setPomodoroRounds': pomodoroRounds = Math.max(1, Number(p) || 4); pushState(); break;
        }
      }
    } catch { }
  });
  ws.on('close', () => clients.delete(ws));
});

startTelegramBot();
