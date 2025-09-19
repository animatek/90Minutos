// Helpers
async function loadConfig(){ const r = await fetch('/api/config'); return await r.json(); }
async function saveConfig(cfg){ const r = await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)}); return await r.json(); }
async function loadSessions(){ const r = await fetch('/api/sessions'); return await r.json(); }
async function loadStats(){ const r = await fetch('/api/stats'); return await r.json(); }
async function getSheetId(){ const r = await fetch('/api/sheet/id'); return (await r.json()).sheetId || ''; }

function renderConfig(cfg){
  document.getElementById('cfgDuration').value = cfg.defaultDurationMin || 90;
  const op = cfg.opacity ?? 0.85;
  const range = document.getElementById('cfgOpacity'); range.value = op;
  document.getElementById('opacityVal').textContent = (+op).toFixed(2);
  const ul = document.getElementById('catList'); ul.innerHTML = '';
  for (const c of cfg.categories || []){
    const li = document.createElement('li'); li.textContent = c + ' ';
    const btn = document.createElement('button'); btn.textContent = 'Eliminar';
    btn.onclick = ()=>{ cfg.categories = (cfg.categories || []).filter(x => x !== c); renderConfig(cfg); };
    li.appendChild(btn); ul.appendChild(li);
  }
  document.getElementById('addCat').onclick = ()=>{
    const v = document.getElementById('newCat').value.trim(); if (!v) return;
    const set = new Set([...(cfg.categories||[]), v]); cfg.categories = Array.from(set);
    document.getElementById('newCat').value=''; renderConfig(cfg);
  };
  range.oninput = ()=> document.getElementById('opacityVal').textContent = (+range.value).toFixed(2);
  document.getElementById('saveCfg').onclick = async ()=>{
    const newCfg = { ...cfg, defaultDurationMin: parseInt(document.getElementById('cfgDuration').value, 10)||90, opacity: +document.getElementById('cfgOpacity').value };
    const saved = await saveConfig(newCfg);
    alert('Configuración guardada');
    populateCategorySelect(saved);
  };
}

function renderStats(stats){
  const tbody = document.querySelector('#totals tbody'); tbody.innerHTML = '';
  const entries = Object.entries(stats.totalsHours || {});
  for (const [cat, hrs] of entries){
    const tr = document.createElement('tr'); tr.innerHTML = `<td>${cat}</td><td>${hrs.toFixed(2)}</td>`; tbody.appendChild(tr);
  }
}
function renderSessions(sessions){
  const tbody = document.querySelector('#sessions tbody'); tbody.innerHTML = '';
  for (const s of sessions){
    const minExact = ((s.durationSec ? s.durationSec/60 : s.durationMin)||0);
    const minText = Number(minExact).toFixed(2);
    const fechas = `${s.startISO} — ${s.endISO}`;
    const link = s.calendarEventId ? `Google` : (s.icsPath ? `<a href="${s.icsPath.replace(/^.*\/sessions\//,'/sessions/')}">ICS</a>` : '-');
    const urlCell = s.url ? `<a href="${s.url}" target="_blank">Abrir</a>` : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${minText}</td>
      <td>${s.category}</td>
      <td>${s.sessionType||''}</td>
      <td>${fechas}</td>
      <td>${link}</td>
      <td>${urlCell}</td>
      <td><button data-del="${s.id||''}">🗑</button></td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('button[data-del]').forEach(btn=>{
    btn.onclick = async ()=>{
      const id = btn.getAttribute('data-del');
      if (!confirm('¿Borrar esta sesión (no borra Sheets en esta versión)?')) return;
      await fetch(`/api/sessions/${id}`, { method:'DELETE' });
      await refreshAll();
    };
  });
}

let ws;
function connectBus(){
  try {
    ws = new WebSocket('ws://127.0.0.1:8765');
    ws.onmessage = async (ev)=>{
      try{ const msg = JSON.parse(ev.data); if (msg.type === 'session:complete'){ await refreshAll(); } }catch(_){}
    };
  } catch {}
}
function sendCmd(action, payload){ if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type:'command', action, payload })); }
function populateCategorySelect(cfg){
  const sel = document.getElementById('rcCategory'); if (!sel) return; sel.innerHTML = '';
  for (const c of (cfg.categories || [])){ const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); }
}
async function setOpenSheetLink(){
  const id = await getSheetId();
  const a = document.getElementById('openSheet');
  a.href = id ? ('https://docs.google.com/spreadsheets/d/'+id+'/edit') : '#';
}

async function refreshAll(){
  const stats = await loadStats(); renderStats(stats);
  const sessions = await loadSessions(); renderSessions(sessions);
}

async function main(){
  document.getElementById('btnAuth').onclick = ()=> window.open('/api/google/auth','_blank');
  const cfg = await loadConfig();
  renderConfig(cfg);
  populateCategorySelect(cfg);

  await setOpenSheetLink();
  await refreshAll();

  document.getElementById('rcStart').onclick  = ()=> sendCmd('start');
  document.getElementById('rcPause').onclick  = ()=> sendCmd('pause');
  document.getElementById('rcResume').onclick = ()=> sendCmd('resume');
  document.getElementById('rcReset').onclick  = ()=> sendCmd('reset');
  document.getElementById('rcAdd1').onclick   = ()=> sendCmd('add', 60);
  document.getElementById('rcAdd5').onclick   = ()=> sendCmd('add', 300);
  document.getElementById('rcAdd10').onclick  = ()=> sendCmd('add', 600);
  document.getElementById('rcFinish').onclick = ()=> sendCmd('finish');

  const rcCat = document.getElementById('rcCategory');
  if (rcCat){ rcCat.onchange = ()=>{ const v = rcCat.value; sendCmd('setCategory', v); sendCmd('setSessionName', v); }; }
  const rcType = document.getElementById('rcSessionType');
  if (rcType){ rcType.onchange = ()=> sendCmd('setSessionType', rcType.value); }

  // Import from Sheets
  document.getElementById('importSheets').onclick = async ()=>{
    const id = await getSheetId();
    if (!id){ alert('Configura SHEET_ID en .env y conecta Google.'); return; }
    const resp = await fetch('/api/sessions/importFromSheets', { method:'POST' });
    const data = await resp.json();
    if (resp.ok){ alert('Importadas '+data.imported+' sesiones desde Sheets.'); await refreshAll(); }
    else { alert('Error: '+(data.error||'desconocido')); }
  };

  setInterval(refreshAll, 20000);
  connectBus();
}
main();
