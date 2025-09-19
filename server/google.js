import path from 'path';
import { google } from 'googleapis';
import { promises as fs } from 'fs';
import { readJSON, writeJSON, paths } from './storage.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  dotenv.config({ path: path.join(__dirname, '.env') });
}

const SCOPES = ['https://www.googleapis.com/auth/calendar.events','https://www.googleapis.com/auth/spreadsheets'];

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = (process.env.BASE_URL || 'http://localhost:5173') + '/api/google/callback';
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export async function hasGoogleAuth() {
  try { const tokens = await readJSON('tokens.json', null); return !!(tokens && tokens.access_token); }
  catch { return false; }
}

export async function beginAuth(req, res) {
  const oAuth2Client = getOAuth2Client();
  if (!oAuth2Client) { res.status(500).json({ error: 'Faltan GOOGLE_CLIENT_ID/SECRET' }); return; }
  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.redirect(authUrl);
}

export async function handleCallback(req, res) {
  const code = req.query.code;
  const oAuth2Client = getOAuth2Client();
  if (!oAuth2Client) { res.status(500).send('Config OAuth incompleta'); return; }
  const { tokens } = await oAuth2Client.getToken(code);
  await writeJSON('tokens.json', tokens);
  res.send('<h1>Google conectado ✅</h1><p>Ya puedes cerrar esta pestaña.</p>');
}

export async function createCalendarEvent(session) {
  const oAuth2Client = getOAuth2Client();
  if (!oAuth2Client) throw new Error('OAuth no configurado');
  let tokens; try { tokens = await readJSON('tokens.json', null); } catch {}
  if (!tokens) throw new Error('Sin tokens');
  oAuth2Client.setCredentials(tokens);

  const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

  const mins = Math.round((session.durationSec || (session.durationMin*60 || 0)) / 60);
  const title = `Sesión ${session.category} ${mins} minutos`;
  const description = `Registrada automáticamente por Animatek Timer. Duración: ${mins} min.`;

  const event = {
    summary: title,
    description,
    start: { dateTime: session.startISO },
    end:   { dateTime: session.endISO },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 1 }] },
  };
  const resp = await calendar.events.insert({ calendarId: 'primary', requestBody: event });
  return resp.data.id;
}

export async function generateICS(session) {
  const outDir = paths.sessionsOutDir;
  await fs.mkdir(outDir, { recursive: true });

  function toCalDT(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    const y = d.getFullYear();
    const m = pad(d.getMonth()+1);
    const day = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    return `${y}${m}${day}T${hh}${mm}${ss}`;
  }

  const dtStart = toCalDT(session.startISO);
  const dtEnd   = toCalDT(session.endISO);
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@animatek.timer`;
  const mins = Math.round((session.durationSec || (session.durationMin*60 || 0)) / 60);
  const summary = `Sesión ${session.category} ${mins} minutos`;
  const desc = `Duración: ${mins} min`;

  const lines = [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Animatek Timer//ES','CALSCALE:GREGORIAN','METHOD:PUBLISH','BEGIN:VEVENT',
    `UID:${uid}`,`DTSTAMP:${dtStart}Z`,`DTSTART;TZID=Europe/Madrid:${dtStart}`,`DTEND;TZID=Europe/Madrid:${dtEnd}`,
    `SUMMARY:${summary}`,`DESCRIPTION:${desc}`,'END:VEVENT','END:VCALENDAR'
  ];
  const ics = lines.join('\r\n');

  const safeCat = (session.category || 'Categoria').replace(/[^a-z0-9-_]/gi, '_');
  const base = session.startISO.replace(/[:]/g,'').replace(/[-]/g,'').replace('T','_').slice(0,15);
  const fileName = `${base}_${safeCat}.ics`;
  const outPath = path.join(outDir, fileName);
  await fs.writeFile(outPath, ics, 'utf-8');
  return outPath;
}

function getSheetsClient(){
  const oAuth2Client = getOAuth2Client();
  if (!oAuth2Client) throw new Error('OAuth no configurado');
  return oAuth2Client;
}

export async function listSheetRows(){
  const sheetId = process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID;
  if (!sheetId) throw new Error('SHEET_ID no configurado');
  const auth = getSheetsClient();
  let tokens; try { tokens = await readJSON('tokens.json', null); } catch {}
  if (!tokens) throw new Error('Sin tokens');
  auth.setCredentials(tokens);
  const sheets = google.sheets({ version: 'v4', auth });
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'A2:F' });
  const rows = (resp.data.values || []).map(r => ({
    categoria: r[0] || '',
    duracion: Number(r[1] || 0),
    lenguaje: r[2] || '',
    fecha: r[3] || '',
    sesion: r[4] || '',
    url: r[5] || ''
  }));
  return rows;
}

export async function appendToSheet(session){
  const sheetId = process.env.SHEET_ID || process.env.GOOGLE_SHEETS_ID;
  if (!sheetId) throw new Error('SHEET_ID no configurado');
  const oAuth2Client = getOAuth2Client();
  if (!oAuth2Client) throw new Error('OAuth no configurado');
  let tokens; try { tokens = await readJSON('tokens.json', null); } catch {}
  if (!tokens) throw new Error('Sin tokens');
  oAuth2Client.setCredentials(tokens);

  const sheets = google.sheets({ version: 'v4', auth: oAuth2Client });
  const startDate = new Date(session.startISO);
  const yyyy = startDate.getFullYear();
  const mm = String(startDate.getMonth()+1).padStart(2,'0');
  const dd = String(startDate.getDate()).padStart(2,'0');
  const fecha = `${yyyy}-${mm}-${dd}`;

  const row = [
    session.category || '',
    String(session.durationMin || ''),
    session.language || '',
    fecha,
    session.sessionType || '',
    session.url || ''
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'A:F',
    valueInputOption: 'RAW',
    requestBody: { values: [row] }
  });
  return true;
}
