import TelegramBot from 'node-telegram-bot-api';
import WebSocket from 'ws';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { readJSON } from './storage.js';
import { applyPreset, allOn, allOff, turnOn, turnOff, blink, PRESETS, DEVICES, getAllStates, setDeviceColor, setBrightness } from './govee.js';
import { interpret } from './ollama.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER = Number(process.env.TELEGRAM_USER_ID);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

let bot = null;
let ws = null;
let lastState = null;
let wsReconnectTimer = null;

function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function stateEmoji(st) {
  if (st === 'running') return '\u{25B6}\u{FE0F}';
  if (st === 'paused') return '\u{23F8}\u{FE0F}';
  return '\u{23F9}\u{FE0F}';
}

function auth(msg) {
  return msg.from && msg.from.id === ALLOWED_USER;
}

function sendWsCommand(action, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type: 'command', action, payload }));
  return true;
}

function reply(chatId, text) {
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket('ws://127.0.0.1:8765');

  ws.on('open', () => {
    console.log('[Telegram] WebSocket conectado');
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'state') {
        lastState = msg.payload;
      }
      if (msg.type === 'session:complete' && ALLOWED_USER) {
        const s = msg.payload;
        const dur = s.durationSec ? fmtTime(s.durationSec) : `${s.durationMin}min`;
        let text = `\u{2705} *Sesion completada*\n\n` +
          `\u{1F3B9} Categoria: *${s.category}*\n` +
          `\u{23F1}\u{FE0F} Duracion: *${dur}*\n` +
          `\u{1F4C5} ${new Date(s.startISO).toLocaleString('es-ES')}`;
        if (s.sheetRow) text += `\n\u{1F4CA} Google Sheets: fila *${s.sheetRow}*`;
        bot.sendMessage(ALLOWED_USER, text, { parse_mode: 'Markdown' });
        try { await blink(); } catch {}
      }
    } catch {}
  });

  ws.on('close', () => {
    console.log('[Telegram] WebSocket desconectado, reconectando en 3s...');
    ws = null;
    lastState = null;
    if (!wsReconnectTimer) wsReconnectTimer = setTimeout(connectWs, 3000);
  });

  ws.on('error', () => {
    // close event will handle reconnection
  });
}

export function startTelegramBot() {
  if (!TOKEN) { console.log('[Telegram] TELEGRAM_BOT_TOKEN no configurado, bot desactivado'); return; }
  if (!ALLOWED_USER) { console.log('[Telegram] TELEGRAM_USER_ID no configurado, bot desactivado'); return; }

  bot = new TelegramBot(TOKEN, { polling: true });
  console.log(`[Telegram] Bot iniciado (user autorizado: ${ALLOWED_USER})`);

  connectWs();

  bot.setMyCommands([
    { command: '90min', description: 'Iniciar sesion + luces Focus' },
    { command: 'pause', description: 'Pausar el timer' },
    { command: 'resume', description: 'Reanudar el timer' },
    { command: 'stop', description: 'Finalizar la sesion actual' },
    { command: 'reset', description: 'Resetear el timer' },
    { command: 'status', description: 'Ver estado actual del timer' },
    { command: 'category', description: 'Cambiar categoria (ej: /category Bitwig)' },
    { command: 'duration', description: 'Cambiar duracion en min (ej: /duration 45)' },
    { command: 'stats', description: 'Ver estadisticas por categoria' },
    { command: 'sessions', description: 'Ver ultimas 5 sesiones' },
    { command: 'lights', description: 'Ver presets de luces' },
    { command: 'lightson', description: 'Encender todas las luces' },
    { command: 'lightsoff', description: 'Apagar todas las luces' },
    { command: 'estudioon', description: 'Encender luz Estudio' },
    { command: 'estudiooff', description: 'Apagar luz Estudio' },
    { command: 'salonon', description: 'Encender luz Salon' },
    { command: 'salonoff', description: 'Apagar luz Salon' },
    { command: 'dashboard', description: 'Abrir el dashboard en el navegador' },
    { command: 'aiload', description: 'Cargar IA en VRAM' },
    { command: 'aiunload', description: 'Descargar IA y liberar VRAM' },
    { command: 'restart', description: 'Reiniciar el servidor' },
    { command: 'kill', description: 'Apagar el servidor' },
  ]);

  // --- /90min ---
  bot.onText(/\/90min/, async (msg) => {
    if (!auth(msg)) return;
    if (sendWsCommand('start')) {
      reply(msg.chat.id, '\u{25B6}\u{FE0F} *Sesion de 90 minutos iniciada!*');
      try { await applyPreset('focus'); reply(msg.chat.id, '\u{1F4A1} Luces: *Focus* activado'); } catch {}
    } else {
      reply(msg.chat.id, '\u{26A0}\u{FE0F} No hay conexion con el servidor');
    }
  });

  // --- /pause ---
  bot.onText(/\/pause/, (msg) => {
    if (!auth(msg)) return;
    if (sendWsCommand('pause')) {
      reply(msg.chat.id, '\u{23F8}\u{FE0F} Timer *pausado*');
    } else {
      reply(msg.chat.id, '\u{26A0}\u{FE0F} No hay conexion con el servidor');
    }
  });

  // --- /resume ---
  bot.onText(/\/resume/, (msg) => {
    if (!auth(msg)) return;
    if (sendWsCommand('resume')) {
      reply(msg.chat.id, '\u{25B6}\u{FE0F} Timer *reanudado*');
    } else {
      reply(msg.chat.id, '\u{26A0}\u{FE0F} No hay conexion con el servidor');
    }
  });

  // --- /stop ---
  bot.onText(/\/stop/, async (msg) => {
    if (!auth(msg)) return;
    if (sendWsCommand('finish')) {
      reply(msg.chat.id, '\u{23F9}\u{FE0F} Sesion *finalizada*');
      try { await blink(); } catch {}
    } else {
      reply(msg.chat.id, '\u{26A0}\u{FE0F} No hay conexion con el servidor');
    }
  });

  // --- /reset ---
  bot.onText(/\/reset/, (msg) => {
    if (!auth(msg)) return;
    if (sendWsCommand('reset')) {
      reply(msg.chat.id, '\u{1F504} Timer *reseteado*');
    } else {
      reply(msg.chat.id, '\u{26A0}\u{FE0F} No hay conexion con el servidor');
    }
  });

  // --- /status ---
  bot.onText(/\/status/, async (msg) => {
    if (!auth(msg)) return;
    const text = await buildStatusText();
    reply(msg.chat.id, text);
  });

  // --- /category <nombre> ---
  bot.onText(/\/category(?:\s+(.+))?/, (msg, match) => {
    if (!auth(msg)) return;
    const cat = match[1]?.trim();
    if (!cat) { reply(msg.chat.id, '\u{2139}\u{FE0F} Uso: `/category nombre`'); return; }
    if (sendWsCommand('setCategory', cat)) {
      reply(msg.chat.id, `\u{1F3B9} Categoria cambiada a: *${cat}*`);
    } else {
      reply(msg.chat.id, '\u{26A0}\u{FE0F} No hay conexion con el servidor');
    }
  });

  // --- /duration <minutos> ---
  bot.onText(/\/duration(?:\s+(\d+))?/, (msg, match) => {
    if (!auth(msg)) return;
    const min = parseInt(match[1], 10);
    if (!min || min < 1) { reply(msg.chat.id, '\u{2139}\u{FE0F} Uso: `/duration 45`'); return; }
    if (sendWsCommand('setDurationSec', min * 60)) {
      reply(msg.chat.id, `\u{23F1}\u{FE0F} Duracion cambiada a: *${min} minutos*`);
    } else {
      reply(msg.chat.id, '\u{26A0}\u{FE0F} No hay conexion con el servidor');
    }
  });

  // --- /stats ---
  bot.onText(/\/stats/, async (msg) => {
    if (!auth(msg)) return;
    try {
      const sessions = await readJSON('sessions.json', []);
      if (sessions.length === 0) { reply(msg.chat.id, '\u{1F4CA} No hay sesiones registradas'); return; }

      const byCat = {};
      for (const s of sessions) {
        const min = s.durationSec ? s.durationSec / 60 : (s.durationMin || 0);
        byCat[s.category] = (byCat[s.category] || 0) + min;
      }

      let text = '\u{1F4CA} *Estadisticas*\n\n';
      const sorted = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
      for (const [cat, min] of sorted) {
        const hrs = (min / 60).toFixed(1);
        text += `\u{1F3B5} *${cat}*: ${hrs}h\n`;
      }
      const totalMin = Object.values(byCat).reduce((a, b) => a + b, 0);
      text += `\n\u{23F0} *Total*: ${(totalMin / 60).toFixed(1)}h (${sessions.length} sesiones)`;
      reply(msg.chat.id, text);
    } catch {
      reply(msg.chat.id, '\u{26A0}\u{FE0F} Error al leer estadisticas');
    }
  });

  // --- /sessions ---
  bot.onText(/\/sessions/, async (msg) => {
    if (!auth(msg)) return;
    try {
      const sessions = await readJSON('sessions.json', []);
      if (sessions.length === 0) { reply(msg.chat.id, '\u{1F4CB} No hay sesiones registradas'); return; }

      const last5 = sessions.slice(-5).reverse();
      let text = '\u{1F4CB} *Ultimas sesiones*\n\n';
      for (const s of last5) {
        const dur = s.durationSec ? fmtTime(s.durationSec) : `${s.durationMin}min`;
        const date = new Date(s.startISO).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
        text += `\u{1F4C5} ${date} | *${s.category}* | ${dur}\n`;
      }
      reply(msg.chat.id, text);
    } catch {
      reply(msg.chat.id, '\u{26A0}\u{FE0F} Error al leer sesiones');
    }
  });

  // --- /lights (inline keyboard) ---
  bot.onText(/\/lights?$/, (msg) => {
    if (!auth(msg)) return;
    const presetButtons = Object.entries(PRESETS).map(([key, p]) => (
      { text: `${p.emoji} ${p.name}`, callback_data: `light:preset:${key}` }
    ));
    bot.sendMessage(msg.chat.id, '\u{1F4A1} *Control de luces*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        // Row 1: on/off all
        [
          { text: '\u{1F7E2} Todo On', callback_data: 'light:all_on' },
          { text: '\u{1F534} Todo Off', callback_data: 'light:all_off' },
        ],
        // Row 2: estudio
        [
          { text: '\u{1F7E2} Estudio On', callback_data: 'light:estudio_on' },
          { text: '\u{1F534} Estudio Off', callback_data: 'light:estudio_off' },
        ],
        // Row 3: salon
        [
          { text: '\u{1F7E2} Salon On', callback_data: 'light:salon_on' },
          { text: '\u{1F534} Salon Off', callback_data: 'light:salon_off' },
        ],
        // Row 4+: presets (2 per row)
        ...chunk(presetButtons, 2),
      ]},
    });
  });

  // --- Callback handler for light buttons ---
  bot.on('callback_query', async (query) => {
    if (!query.data?.startsWith('light:')) return;
    if (!query.from || query.from.id !== ALLOWED_USER) return;

    const cmd = query.data.slice('light:'.length);
    let feedback = '';
    try {
      if (cmd === 'all_on')       { await allOn();                    feedback = '\u{1F7E2} Todas encendidas'; }
      else if (cmd === 'all_off') { await allOff();                   feedback = '\u{1F534} Todas apagadas'; }
      else if (cmd === 'estudio_on')  { await turnOn(DEVICES.estudio);  feedback = '\u{1F7E2} Estudio on'; }
      else if (cmd === 'estudio_off') { await turnOff(DEVICES.estudio); feedback = '\u{1F534} Estudio off'; }
      else if (cmd === 'salon_on')    { await turnOn(DEVICES.salon);    feedback = '\u{1F7E2} Salon on'; }
      else if (cmd === 'salon_off')   { await turnOff(DEVICES.salon);   feedback = '\u{1F534} Salon off'; }
      else if (cmd.startsWith('preset:')) {
        const key = cmd.split(':')[1];
        const p = PRESETS[key];
        if (p) { await applyPreset(key); feedback = `${p.emoji} ${p.name} activado`; }
        else feedback = '\u{26A0}\u{FE0F} Preset no encontrado';
      }
    } catch (e) {
      feedback = `\u{26A0}\u{FE0F} ${e.message}`;
    }
    bot.answerCallbackQuery(query.id, { text: feedback, show_alert: false });
    bot.editMessageText(`\u{1F4A1} ${feedback}`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' });
  });

  // --- /lightson ---
  bot.onText(/\/lightson/, async (msg) => {
    if (!auth(msg)) return;
    try { await allOn(); reply(msg.chat.id, '\u{1F7E2} *Todas las luces encendidas*'); }
    catch (e) { reply(msg.chat.id, `\u{26A0}\u{FE0F} Error Govee: ${e.message}`); }
  });

  // --- /lightsoff ---
  bot.onText(/\/lightsoff/, async (msg) => {
    if (!auth(msg)) return;
    try { await allOff(); reply(msg.chat.id, '\u{1F534} *Todas las luces apagadas*'); }
    catch (e) { reply(msg.chat.id, `\u{26A0}\u{FE0F} Error Govee: ${e.message}`); }
  });

  // --- /estudioon ---
  bot.onText(/\/estudioon/, async (msg) => {
    if (!auth(msg)) return;
    try { await turnOn(DEVICES.estudio); reply(msg.chat.id, '\u{1F7E2} *Estudio encendido*'); }
    catch (e) { reply(msg.chat.id, `\u{26A0}\u{FE0F} Error Govee: ${e.message}`); }
  });

  // --- /estudiooff ---
  bot.onText(/\/estudiooff/, async (msg) => {
    if (!auth(msg)) return;
    try { await turnOff(DEVICES.estudio); reply(msg.chat.id, '\u{1F534} *Estudio apagado*'); }
    catch (e) { reply(msg.chat.id, `\u{26A0}\u{FE0F} Error Govee: ${e.message}`); }
  });

  // --- /salonon ---
  bot.onText(/\/salonon/, async (msg) => {
    if (!auth(msg)) return;
    try { await turnOn(DEVICES.salon); reply(msg.chat.id, '\u{1F7E2} *Salon encendido*'); }
    catch (e) { reply(msg.chat.id, `\u{26A0}\u{FE0F} Error Govee: ${e.message}`); }
  });

  // --- /salonoff ---
  bot.onText(/\/salonoff/, async (msg) => {
    if (!auth(msg)) return;
    try { await turnOff(DEVICES.salon); reply(msg.chat.id, '\u{1F534} *Salon apagado*'); }
    catch (e) { reply(msg.chat.id, `\u{26A0}\u{FE0F} Error Govee: ${e.message}`); }
  });

  // --- /dashboard ---
  bot.onText(/\/dashboard/, (msg) => {
    if (!auth(msg)) return;
    const url = process.env.BASE_URL || 'http://127.0.0.1:5173';
    reply(msg.chat.id, `\u{1F4BB} [Abrir Dashboard](${url}/dashboard/index.html)`);
  });

  // --- /restart ---
  bot.onText(/\/restart/, async (msg) => {
    if (!auth(msg)) return;
    await bot.sendMessage(msg.chat.id, '\u{1F504} *Reiniciando servidor...*', { parse_mode: 'Markdown' });
    const serverScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
    const child = spawn(process.execPath, [serverScript], {
      detached: true,
      stdio: 'ignore',
      cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
      env: { ...process.env }
    });
    child.unref();
    setTimeout(() => process.exit(0), 500);
  });

  // --- /kill ---
  bot.onText(/\/kill/, async (msg) => {
    if (!auth(msg)) return;
    await bot.sendMessage(msg.chat.id, '\u{1F6D1} *Servidor apagado*', { parse_mode: 'Markdown' });
    setTimeout(() => process.exit(0), 500);
  });

  // --- /aiload ---
  bot.onText(/\/aiload/, async (msg) => {
    if (!auth(msg)) return;
    reply(msg.chat.id, '\u{1F9E0} Cargando modelo en VRAM...');
    try {
      const res = await fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama3.2:3b', prompt: '', keep_alive: -1 }),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}`);
      reply(msg.chat.id, '\u{2705} *llama3.2:3b* cargado en VRAM');
    } catch (e) {
      reply(msg.chat.id, `\u{26A0}\u{FE0F} Error: ${e.message}`);
    }
  });

  // --- /aiunload ---
  bot.onText(/\/aiunload/, async (msg) => {
    if (!auth(msg)) return;
    try {
      const res = await fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama3.2:3b', prompt: '', keep_alive: 0 }),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}`);
      reply(msg.chat.id, '\u{1F4A4} *llama3.2:3b* descargado — VRAM libre');
    } catch (e) {
      reply(msg.chat.id, `\u{26A0}\u{FE0F} Error: ${e.message}`);
    }
  });

  // --- Natural language via Ollama (catch-all for non-command text) ---
  bot.on('message', async (msg) => {
    if (!auth(msg)) return;
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    try {
      // Build live context for the AI
      const cfg = await readJSON('config.json', {});
      const context = {
        timerState: lastState,
        categories: cfg.categories || [],
      };

      const result = await interpret(msg.text, context);
      console.log(`[Ollama] "${msg.text}" -> ${JSON.stringify(result)}`);

      // Execute any actions the AI decided on
      const errors = [];
      for (const act of result.actions) {
        try {
          await executeAction(act);
        } catch (e) {
          errors.push(e.message);
        }
      }

      // Send the AI's reply
      let text = result.reply || (result.actions.length ? 'Hecho' : '...');
      if (errors.length) text += `\n\u{26A0}\u{FE0F} ${errors.join(', ')}`;
      reply(chatId, text);
    } catch (e) {
      console.error('[Ollama] Error:', e.message);
      reply(chatId, `\u{26A0}\u{FE0F} Error de IA: ${e.message}`);
    }
  });

  async function executeAction({ action, value }) {
    switch (action) {
      case 'lights_all_on':  await allOn(); break;
      case 'lights_all_off': await allOff(); break;
      case 'lights_estudio_on':  await turnOn(DEVICES.estudio); break;
      case 'lights_estudio_off': await turnOff(DEVICES.estudio); break;
      case 'lights_salon_on':    await turnOn(DEVICES.salon); break;
      case 'lights_salon_off':   await turnOff(DEVICES.salon); break;
      case 'color': {
        // value format: "device:color" e.g. "estudio:azul" or "all:rojo"
        const [devKey, colorName] = (value || '').split(':');
        if (!devKey || !colorName) throw new Error('Formato color inválido');
        if (devKey === 'all' || devKey === 'todas' || devKey === 'todo') {
          await setDeviceColor('estudio', colorName);
          await setDeviceColor('salon', colorName);
        } else {
          await setDeviceColor(devKey, colorName);
        }
        break;
      }
      case 'brightness': {
        // value format: "device:percentage" e.g. "estudio:50" or "all:30"
        const [bDevKey, bVal] = (value || '').split(':');
        const pct = parseInt(bVal, 10);
        if (!bDevKey || isNaN(pct)) throw new Error('Formato brillo inválido');
        if (bDevKey === 'all' || bDevKey === 'todas' || bDevKey === 'todo') {
          await setBrightness(DEVICES.estudio, pct);
          await setBrightness(DEVICES.salon, pct);
        } else {
          const dev = DEVICES[bDevKey];
          if (!dev) throw new Error(`Dispositivo "${bDevKey}" no existe`);
          await setBrightness(dev, pct);
        }
        break;
      }
      case 'preset': {
        const key = (value || '').toLowerCase();
        if (!PRESETS[key]) throw new Error(`Preset "${value}" no existe`);
        await applyPreset(key);
        break;
      }
      case 'start':    if (!sendWsCommand('start'))  throw new Error('Sin conexión al servidor'); break;
      case 'pause':    if (!sendWsCommand('pause'))  throw new Error('Sin conexión al servidor'); break;
      case 'resume':   if (!sendWsCommand('resume')) throw new Error('Sin conexión al servidor'); break;
      case 'stop':     if (!sendWsCommand('finish')) throw new Error('Sin conexión al servidor'); break;
      case 'reset':    if (!sendWsCommand('reset'))  throw new Error('Sin conexión al servidor'); break;
      case 'category': {
        if (!value) break;
        if (!sendWsCommand('setCategory', value)) throw new Error('Sin conexión al servidor');
        break;
      }
      case 'duration': {
        const min = parseInt(value, 10);
        if (min > 0 && !sendWsCommand('setDurationSec', min * 60)) throw new Error('Sin conexión al servidor');
        break;
      }
      case 'stats': {
        // AI already knows context, this is a no-op — reply handles it
        break;
      }
      case 'sessions': break;
      case 'status': break;
      default: break;
    }
  }

  bot.on('polling_error', (err) => {
    console.error('[Telegram] Polling error:', err.message);
  });
}

async function buildStatusText() {
  let text = '\u{1F4CB} *Estado del sistema*\n';

  // Timer
  text += '\n\u{23F1}\u{FE0F} *Timer*\n';
  if (lastState) {
    const s = lastState;
    const remaining = fmtTime(s.remainingSec);
    const total = fmtTime(s.durationSec);
    const pct = s.durationSec > 0 ? Math.round((1 - s.remainingSec / s.durationSec) * 100) : 0;
    text += `${stateEmoji(s.state)} ${s.state} — *${remaining}* / ${total} (${pct}%)\n`;
    text += `\u{1F3B9} ${s.category || '—'}`;
    if (s.sessionName && s.sessionName !== s.category) text += ` \u{2022} ${s.sessionName}`;
    text += '\n';
  } else {
    text += '\u{26A0}\u{FE0F} Sin conexión\n';
  }

  // Lights
  text += '\n\u{1F4A1} *Luces*\n';
  try {
    const lights = await getAllStates();
    for (const [key, dev] of Object.entries(lights)) {
      if (!dev) { text += `\u{2753} ${key}: sin respuesta\n`; continue; }
      const icon = dev.power === 'on' ? '\u{1F7E2}' : '\u{26AB}';
      let line = `${icon} *${dev.name}*: ${dev.power}`;
      if (dev.power === 'on' && dev.brightness !== undefined) line += ` \u{2022} ${dev.brightness}%`;
      if (dev.power === 'on' && dev.color) line += ` \u{2022} rgb(${dev.color.r},${dev.color.g},${dev.color.b})`;
      text += line + '\n';
    }
  } catch {
    text += '\u{26A0}\u{FE0F} Error al consultar Govee\n';
  }

  // AI
  text += '\n\u{1F916} *IA (Ollama)*\n';
  try {
    const res = await fetch('http://127.0.0.1:11434/api/ps');
    if (!res.ok) throw new Error();
    const data = await res.json();
    const model = (data.models || []).find(m => m.name === 'llama3.2:3b');
    if (model) {
      const vram = (model.size_vram / 1e9).toFixed(1);
      text += `\u{1F7E2} *llama3.2:3b* cargado (${vram} GB VRAM)\n`;
    } else {
      text += '\u{26AB} Modelo no cargado en VRAM\n';
    }
  } catch {
    text += '\u{26A0}\u{FE0F} Ollama no disponible\n';
  }

  return text;
}

export async function sendStatus() {
  if (!bot || !ALLOWED_USER) return false;
  const text = await buildStatusText();
  await bot.sendMessage(ALLOWED_USER, text, { parse_mode: 'Markdown' });
  return true;
}
