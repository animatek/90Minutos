import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import dotenv from 'dotenv';
import { readJSON, writeJSON, paths } from './storage.js';
import { beginAuth, handleCallback, createCalendarEvent, generateICS, hasGoogleAuth, appendToSheet, listSheetRows } from './google.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultConfig = {
  defaultDurationMin: 90,
  categories: ["Octatrack","Digitakt","Oxi One","Bitwig"],
  theme: "auto",
  opacity: 0.85,
  timezone: "Europe/Madrid",
  languages: ["ES","EN"],
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

let tickTimer = null;

function now(){ return new Date(); }

const clients = new Set();
function broadcast(obj) { const raw = JSON.stringify(obj); for (const c of clients) { try { c.send(raw); } catch {} } }
function pushState(){
  broadcast({ type: 'state', payload: {
    state, durationSec, remainingSec, category, sessionName, language, sessionType,
    startedAtISO: startedAt ? startedAt.toISOString() : null
  }});
}

function startTimer(){
  if (state === 'running') return;
  if (state === 'idle') { remainingSec = durationSec; startedAt = now(); }
  state = 'running';
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(()=>{
    remainingSec = Math.max(0, remainingSec - 1);
    if (remainingSec <= 0){ clearInterval(tickTimer); tickTimer = null; completeSession(); }
    pushState();
  }, 1000);
  pushState();
}
function pauseTimer(){ if (state !== 'running') return; state = 'paused'; if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } pushState(); }
function resumeTimer(){
  if (state !== 'paused') return; state = 'running';
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(()=>{
    remainingSec = Math.max(0, remainingSec - 1);
    if (remainingSec <= 0){ clearInterval(tickTimer); tickTimer = null; completeSession(); }
    pushState();
  }, 1000);
  pushState();
}
function resetTimer(){ state='idle'; if (tickTimer) { clearInterval(tickTimer); tickTimer=null; } remainingSec = durationSec; startedAt=null; pushState(); }
function addSeconds(s){ const add = Number(s)||0; remainingSec = Math.max(0, remainingSec + add); pushState(); }
function setCategoryValue(cat){ if (!cat) return; category=String(cat); sessionName=category; pushState(); }
function setSessionNameValue(name){ if (!name) return; sessionName=String(name); pushState(); }
function setLanguageValue(lang){ if (!lang) return; language=String(lang); pushState(); }
function setSessionTypeValue(t){ if (!t) return; sessionType=String(t); pushState(); }
function setDurationSeconds(sec){ const s = Math.max(1, Number(sec)||5400); durationSec = s; if (state==='idle') remainingSec=durationSec; pushState(); }

async function appendCSV(session){
  const hdr = 'Categoria,DuracionMin,Lenguaje,Fecha,Sesion,DuracionHHMMSS\n';
  const startDate = new Date(session.startISO);
  const yyyy = startDate.getFullYear(); const mm = String(startDate.getMonth()+1).padStart(2,'0'); const dd = String(startDate.getDate()).padStart(2,'0');
  const fecha = `${yyyy}-${mm}-${dd}`;

  const sec = session.durationSec || (session.durationMin * 60);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const hhmmss = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

  const csvLine = `"${(session.category||'').replace(/"/g,'""')}",`+
                  `"${session.durationMin||''}",`+
                  `"${(session.language||'').replace(/"/g,'""')}",`+
                  `"${fecha}",`+
                  `"${(session.sessionType||'').replace(/"/g,'""')}",`+
                  `"${hhmmss}"\n`;
  const outPath = path.join(paths.sessionsOutDir, 'sessions_log.csv');
  try { await fs.access(outPath); } catch { await fs.writeFile(outPath, hdr, 'utf-8'); }
  await fs.appendFile(outPath, csvLine, 'utf-8');
}

async function completeSession(){
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  const end = now();
  const start = startedAt || end;

  const totalSec = Math.max(1, Math.round((end - start) / 1000));
  const durationMin = Math.round(totalSec / 60);

  const session = { id: Date.now(),
    startISO: start.toISOString(), endISO: end.toISOString(),
    durationMin, durationSec: totalSec,
    category, language, sessionType, sessionName
  };
  try {
    if (await hasGoogleAuth()) { const id = await createCalendarEvent(session); session.calendarEventId = id; }
    else { const icsPath = await generateICS(session); session.icsPath = icsPath; }
  } catch (e) { const icsPath = await generateICS(session); session.icsPath = icsPath; }

  const sessions = await readJSON('sessions.json', []); sessions.push(session); await writeJSON('sessions.json', sessions);

  try { await appendToSheet(session); } catch (e) { await appendCSV(session); }

  state='idle'; remainingSec = durationSec; startedAt = null; pushState();
  broadcast({ type: 'session:complete', payload: session });
}

const app = express(); app.use(express.json());
app.use((req,res,next)=>{
  const o=req.headers.origin||'';
  if (o.includes('localhost')||o.includes('127.0.0.1')){
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
  }
  if (req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

const rootDir = path.join(__dirname, '..');
app.use('/overlay', express.static(path.join(rootDir, 'overlay')));
app.use('/dashboard', express.static(path.join(rootDir, 'dashboard')));
app.use('/sessions', express.static(path.join(rootDir, 'sessions')));

app.get('/api/config', async (req,res)=>{ const cfg = await readJSON('config.json', defaultConfig); res.json(cfg); });
app.post('/api/config', async (req,res)=>{
  const current = await readJSON('config.json', defaultConfig);
  const merged = { ...current, ...req.body };
  await writeJSON('config.json', merged);
  if (typeof merged.defaultDurationMin === 'number'){ setDurationSeconds(Math.max(60, Math.round(merged.defaultDurationMin) * 60)); }
  res.json(merged); broadcast({ type:'config:update', payload: merged });
});
app.get('/api/sessions', async (req,res)=>{ const sessions = await readJSON('sessions.json', []); res.json(sessions); });

app.delete('/api/sessions', async (req,res)=>{
  await writeJSON('sessions.json', []);
  res.json({ ok: true });
});
app.delete('/api/sessions/:id', async (req,res)=>{
  const id = Number(req.params.id);
  let sessions = await readJSON('sessions.json', []);
  const before = sessions.length;
  sessions = sessions.filter(s => Number(s.id) !== id);
  await writeJSON('sessions.json', sessions);
  res.json({ ok: true, removed: before - sessions.length });
});


app.put('/api/sessions/:id', async (req,res)=>{
  try{
    const id = Number(req.params.id);
    let sessions = await readJSON('sessions.json', []);
    const i = sessions.findIndex(s => Number(s.id) === id);
    if (i === -1) { res.status(404).json({ error: 'not found' }); return; }
    const allowed = ['url','sessionName','category','language','sessionType','durationMin','durationSec','startISO','endISO'];
    const body = req.body || {};
    const update = {};
    for (const k of allowed){ if (Object.prototype.hasOwnProperty.call(body,k)) update[k] = body[k]; }
    sessions[i] = { ...sessions[i], ...update };
    await writeJSON('sessions.json', sessions);
    res.json(sessions[i]);
  }catch(e){
    res.status(500).json({ error: String(e.message||e) });
  }
});
app.get('/api/stats', async (req,res)=>{
  const sessions = await readJSON('sessions.json', []);
  const byCatMin = {};
  for (const s of sessions) {
    const min = (s.durationSec ? s.durationSec/60 : s.durationMin||0);
    byCatMin[s.category] = (byCatMin[s.category]||0) + min;
  }
  const totalHours = Object.fromEntries(Object.entries(byCatMin).map(([k,v])=>[k, +(v/60).toFixed(2)]));
  res.json({ totalsMin: byCatMin, totalsHours: totalHours, count: sessions.length });
});
app.get('/api/state', (req,res)=>{ res.json({ state, durationSec, remainingSec, category, sessionName, language, sessionType, startedAtISO: startedAt? startedAt.toISOString(): null }); });

// Google & Sheets
app.get('/api/google/auth', beginAuth);
app.get('/api/google/callback', handleCallback);
app.get('/api/sheet/id', (req,res)=>{
  const id = process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID || null;
  res.json({ sheetId: id });
});
app.post('/api/sessions/importFromSheets', async (req,res)=>{
  // Reconstruye sessions.json a partir de las filas del Sheet
  try {
    const rows = await listSheetRows(); // [{categoria,duracion,lenguaje,fecha,sesion}]
    const sessions = [];
    for (const r of rows){
      // fecha en YYYY-MM-DD
      const startLocal = new Date(r.fecha + 'T12:00:00'); // medio día local
      const endLocal = new Date(startLocal.getTime() + (r.duracion||0)*60*1000);
      sessions.push({
        id: startLocal.getTime(),
        startISO: startLocal.toISOString(),
        endISO: endLocal.toISOString(),
        durationMin: Math.round((r.duracion||0)),
        durationSec: (r.duracion||0)*60,
        category: r.categoria || '',
        language: r.lenguaje || '',
        sessionType: r.sesion || '',
        sessionName: r.categoria || '',
        url: r.url || ''
      });
    }
    await writeJSON('sessions.json', sessions);
    res.json({ ok: true, imported: sessions.length });
  } catch(e){
    res.status(500).json({ error: String(e.message||e) });
  }
});

app.get('/', (req,res)=> res.redirect('/dashboard/index.html'));

const port = 5173;
app.listen(port, '127.0.0.1', ()=> console.log(`[Animatek Timer] HTTP en http://127.0.0.1:${port}`));

const wss = new WebSocketServer({ port: 8765, host: '127.0.0.1' });
wss.on('connection', (ws)=>{
  clients.add(ws); pushState();
  ws.on('message', (raw)=>{
    try{
      const msg = JSON.parse(raw.toString());
      if (msg && msg.type === 'command'){
        const a = msg.action; const p = msg.payload;
        switch (a){
          case 'start': startTimer(); break;
          case 'pause': pauseTimer(); break;
          case 'resume': resumeTimer(); break;
          case 'reset': resetTimer(); break;
          case 'finish': if (state!=='idle') completeSession(); break;
          case 'add': addSeconds(p||0); break;
          case 'setCategory': setCategoryValue(p); break;
          case 'setSessionName': setSessionNameValue(p); break;
          case 'setDurationSec': setDurationSeconds(p); break;
          case 'setLanguage': setLanguageValue(p); break;
          case 'setSessionType': setSessionTypeValue(p); break;
        }
      }
    }catch{}
  });
  ws.on('close', ()=> clients.delete(ws));
});
