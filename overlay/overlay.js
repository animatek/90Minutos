const alarmEl = document.getElementById('alarm');
const container = document.getElementById('container');
const timerEl = document.getElementById('timer');
const statusEl = document.getElementById('status');
const titleEl = document.getElementById('sessionTitle');

const dial = document.querySelector('.progress');
const dot = document.querySelector('.dot');
const CIRC = 339.292;

let ws;
let current = { state:'idle', durationSec:5400, remainingSec:5400, category:'', sessionName:'', language:'ES', sessionType:'privada', startedAtISO:null };

function mmss(sec){ const s=Math.max(0, Math.floor(sec)); const m=Math.floor(s/60); const r=s%60; return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`; }

function render(){
  timerEl.textContent = mmss(current.remainingSec);
  const stText = current.state === 'running' ? 'En marcha…' : current.state === 'paused' ? 'En pausa' : 'En espera…';
  statusEl.textContent = stText;
  titleEl.textContent = (current.sessionName || current.category || 'SESIÓN DE INSTRUMENTO').toUpperCase();
  const p = 1 - (current.remainingSec / (current.durationSec || 1));
  const offset = (1 - p) * CIRC; dial.style.strokeDashoffset = String(offset);
  const deg = p * 360; dot.style.transform = `rotate(${deg}deg) translateZ(0)`;
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
      }catch(_){}
    };
    ws.onclose = () => setTimeout(connectWS, 1000);
  } catch(e){ setTimeout(connectWS, 1000); }
}

render(); connectWS();
