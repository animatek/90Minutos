// Browser source para OBS. Solo escucha: el servidor manda el estado y aquí se
// pinta. Muestra la cuenta atrás en modo sprint y el tiempo acumulado en abierto.
const alarmEl = document.getElementById('alarm');
const widget = document.getElementById('widget');
const catEl = document.getElementById('catLabel');
const timerEl = document.getElementById('timerLabel');
const pauseTag = document.getElementById('pauseTag');

const FALLBACK_COLOR = '#7aa2f7';

let current = { state: 'idle', mode: 'open', elapsedSec: 0, remainingSec: null, topic: '' };
let ws;
let runtimeWsPort = 8765;

function clock(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function render() {
  const { state, mode, elapsedSec, remainingSec, overtimeSec, topic, topicColor } = current;
  const active = state === 'running' || state === 'paused';

  widget.classList.toggle('hidden', !active);
  widget.classList.toggle('paused', state === 'paused');

  const label = topic || current.category || '';
  const color = topicColor || FALLBACK_COLOR;

  catEl.textContent = label.toUpperCase();
  catEl.style.color = color;
  catEl.style.textShadow = `0 0 16px ${color}88`;

  // En sprint se enseña lo que queda (o la prórroga); en abierto, lo acumulado.
  const isSprint = mode === 'sprint' && remainingSec != null;
  if (isSprint && overtimeSec > 0) {
    timerEl.textContent = `+${clock(overtimeSec)}`;
    widget.classList.add('overtime');
  } else {
    timerEl.textContent = clock(isSprint ? remainingSec : elapsedSec);
    widget.classList.remove('overtime');
  }

  pauseTag.style.display = state === 'paused' ? 'inline-block' : 'none';
}

function flashAlarm() {
  widget.classList.add('flash');
  alarmEl.currentTime = 0;
  alarmEl.play().catch(() => { });
  setTimeout(() => widget.classList.remove('flash'), 3000);
}

function connectWS() {
  try {
    // El runtime HTTP publica el puerto real: evita conectar con otra instancia
    // si WS_PORT se cambia para desarrollo o al ejecutar varias copias.
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${scheme}://${location.hostname || '127.0.0.1'}:${runtimeWsPort}`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state') { current = { ...current, ...msg.payload }; render(); }
        else if (msg.type === 'session:complete' || msg.type === 'alarm') flashAlarm();
      } catch { /* mensaje ilegible: se ignora */ }
    };
    ws.onclose = () => { ws = null; setTimeout(connectWS, 2000); };
    ws.onerror = () => { };
  } catch { setTimeout(connectWS, 2000); }
}

async function boot() {
  render();
  try {
    const [healthRes, stateRes] = await Promise.all([
      fetch('/api/health'),
      fetch('/api/state'),
    ]);
    if (healthRes.ok) {
      const health = await healthRes.json();
      runtimeWsPort = Number(health.wsPort) || runtimeWsPort;
    }
    if (stateRes.ok) {
      current = { ...current, ...await stateRes.json() };
      render();
    }
  } catch { /* el WebSocket reintentará hasta que el servidor esté disponible */ }
  connectWS();
}

boot();
