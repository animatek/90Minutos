const alarmEl = document.getElementById('alarm');
const container = document.getElementById('container');
const timerEl = document.getElementById('timer');
const titleEl = document.getElementById('sessionTitle');

const dial = document.querySelector('.progress');
const dot = document.querySelector('.dot');
const CIRC = 339.292;
const categoryColors = new Map();
const TOKYO_COLORS = ['#7aa2f7','#f7768e','#bb9af7','#0db9d7','#9ece6a','#e0af68','#ff9e64','#c0caf5','#565f89'];
function getCategoryColor(cat){
  if (!cat) return TOKYO_COLORS[0];
  if (categoryColors.has(cat)) return categoryColors.get(cat);
  const idx = categoryColors.size % TOKYO_COLORS.length;
  const color = TOKYO_COLORS[idx];
  categoryColors.set(cat, color);
  return color;
}

let ws;
let current = { state:'idle', durationSec:5400, remainingSec:5400, category:'', sessionName:'', language:'ES', sessionType:'privada', startedAtISO:null };

function setOverlayOpacity(val){
  const op = Math.min(0.98, Math.max(0.3, Number(val)||0.85));
  document.documentElement.style.setProperty('--opacity', op);
}
async function syncConfig(){
  try{
    const resp = await fetch('/api/config');
    if (!resp.ok) return;
    const cfg = await resp.json();
    if (cfg && typeof cfg.opacity !== 'undefined') setOverlayOpacity(cfg.opacity);
  }catch{}
}
function mmss(sec){ const s=Math.max(0, Math.floor(sec)); const m=Math.floor(s/60); const r=s%60; return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`; }

function render(){
  timerEl.textContent = mmss(current.remainingSec);
  const categoryLabel = current.sessionName || current.category || 'SESIÓN DE INSTRUMENTO';
  const color = getCategoryColor(current.category || categoryLabel);
  titleEl.textContent = categoryLabel.toUpperCase();
  titleEl.style.color = color;
  titleEl.style.textShadow = `0 0 24px ${color}55`;
  const p = 1 - (current.remainingSec / (current.durationSec || 1));
  const offset = (1 - p) * CIRC; dial.style.strokeDashoffset = String(offset);
  const deg = p * 360; dot.style.transform = `rotate(${deg}deg) translateZ(0)`;
  dial.style.stroke = color;
  dot.style.fill = color;
}

function connectWS(){
  try {
    ws = new WebSocket('ws://127.0.0.1:8765');
    ws.onopen = () => {
      const params = new URLSearchParams(location.search);
      if (params.get('autostart') === '1') ws.send(JSON.stringify({type:'command', action:'start'}));
    };
    ws.onmessage = (ev) => {
      try{
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state'){ current = { ...current, ...msg.payload }; render(); }
        else if (msg.type === 'session:complete'){ container.classList.add('flash'); alarmEl.currentTime=0; alarmEl.play().catch(()=>{}); setTimeout(()=>container.classList.remove('flash'), 3000); }
        else if (msg.type === 'config:update' && msg.payload){ setOverlayOpacity(msg.payload.opacity); }
      }catch(_){}
    };
    ws.onclose = () => setTimeout(connectWS, 1000);
  } catch(e){ setTimeout(connectWS, 1000); }
}

syncConfig();
render(); connectWS();
