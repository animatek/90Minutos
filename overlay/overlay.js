const alarmEl   = document.getElementById('alarm');
const widget    = document.getElementById('widget');
const catEl     = document.getElementById('catLabel');
const timerEl   = document.getElementById('timerLabel');
const pauseTag  = document.getElementById('pauseTag');

const TOKYO_COLORS = ['#7aa2f7','#f7768e','#bb9af7','#0db9d7','#9ece6a','#e0af68','#ff9e64','#c0caf5'];
const categoryColors = new Map();
function getCategoryColor(cat) {
  if (!cat) return TOKYO_COLORS[0];
  if (categoryColors.has(cat)) return categoryColors.get(cat);
  const color = TOKYO_COLORS[categoryColors.size % TOKYO_COLORS.length];
  categoryColors.set(cat, color);
  return color;
}

let current = { state: 'idle', durationSec: 5400, remainingSec: 5400, category: '', sessionName: '' };
let ws;

function mmss(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function render() {
  const { state, remainingSec, category, sessionName } = current;
  const active = state === 'running' || state === 'paused';

  widget.classList.toggle('hidden', !active);
  widget.classList.toggle('paused', state === 'paused');

  const label = sessionName || category || '';
  const color = getCategoryColor(category || label);

  catEl.textContent  = label.toUpperCase();
  catEl.style.color  = color;
  catEl.style.textShadow = `0 0 16px ${color}88`;
  timerEl.textContent = mmss(remainingSec);
  pauseTag.style.display = state === 'paused' ? 'inline-block' : 'none';
}

function connectWS() {
  try {
    ws = new WebSocket('ws://127.0.0.1:8765');
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state') { current = { ...current, ...msg.payload }; render(); }
        else if (msg.type === 'session:complete') {
          widget.classList.add('flash');
          alarmEl.currentTime = 0; alarmEl.play().catch(() => {});
          setTimeout(() => widget.classList.remove('flash'), 3000);
        }
      } catch (_) {}
    };
    ws.onclose = () => { ws = null; setTimeout(connectWS, 2000); };
    ws.onerror = () => {};
  } catch (_) { setTimeout(connectWS, 2000); }
}

render();
connectWS();
