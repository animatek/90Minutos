// Helpers
async function loadConfig(){ const r = await fetch('/api/config'); return await r.json(); }
async function saveConfig(cfg){ const r = await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)}); return await r.json(); }
async function loadSessions(){ const r = await fetch('/api/sessions'); return await r.json(); }
async function loadStats(){ const r = await fetch('/api/stats'); return await r.json(); }
async function getSheetId(){ const r = await fetch('/api/sheet/id'); return (await r.json()).sheetId || ''; }

function renderConfig(cfg){
  const durationInput = document.getElementById('cfgDuration');
  const durationVal = document.getElementById('durationVal');
  const duration = cfg.defaultDurationMin || 90;
  durationInput.value = duration;
  if (durationVal) durationVal.textContent = `${duration} min`;
  durationInput.oninput = ()=>{
    if (durationVal) durationVal.textContent = `${durationInput.value} min`;
    const minutes = Number(durationInput.value) || 90;
    const seconds = Math.max(60, Math.round(minutes) * 60);
    sendCmd('setDurationSec', seconds);
  };
  const op = cfg.opacity ?? 0.85;
  const range = document.getElementById('cfgOpacity'); range.value = op;
  document.getElementById('opacityVal').textContent = (+op).toFixed(2);
  configCategories = [...(cfg.categories || [])];
  categoryColors = { ...(cfg.categoryColors || {}) };
  assignCategoryColors();
  const ul = document.getElementById('catList'); ul.innerHTML = '';
  for (const c of cfg.categories || []){
    const li = document.createElement('li');
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'cat-color-input';
    colorInput.value = ensureCategoryColor(c);
    colorInput.oninput = (ev)=>{
      categoryColors[c] = ev.target.value;
      nameInput.style.color = ev.target.value;
      nameInput.style.borderColor = ev.target.value;
      cfg.categoryColors = { ...categoryColors };
      assignCategoryColors();
      populateCategorySelect(cfg);
      populateCategoryFilter(allSessions);
    };
    const nameInput = document.createElement('input');
    nameInput.value = c;
    nameInput.className = 'cat-name-input';
    const currentColor = ensureCategoryColor(c);
    nameInput.style.color = currentColor;
    nameInput.style.borderColor = currentColor;
    nameInput.onchange = ()=>{
      const newName = nameInput.value.trim();
      if (!newName){ nameInput.value = c; return; }
      if (newName === c) return;
      if ((cfg.categories || []).includes(newName)){ alert('La categoría ya existe'); nameInput.value = c; return; }
      cfg.categories = (cfg.categories || []).map(cat => cat === c ? newName : cat);
      categoryColors[newName] = categoryColors[c];
      delete categoryColors[c];
      cfg.categoryColors = { ...categoryColors };
      renderConfig(cfg);
      populateCategorySelect(cfg);
      populateCategoryFilter(allSessions);
      refreshBadgeColors();
    };
    const btn = document.createElement('button'); btn.textContent = 'Eliminar';
    btn.onclick = ()=>{
      cfg.categories = (cfg.categories || []).filter(x => x !== c);
      delete categoryColors[c];
      cfg.categoryColors = { ...categoryColors };
      renderConfig(cfg);
      populateCategorySelect(cfg);
      populateCategoryFilter(allSessions);
      refreshBadgeColors();
    };
    li.appendChild(colorInput);
    li.appendChild(nameInput);
    li.appendChild(btn);
    ul.appendChild(li);
  }
  const summary = document.querySelector('#catDropdown summary');
  if (summary){
    const count = (cfg.categories || []).length;
    summary.textContent = count ? `Ver categorías (${count})` : 'Sin categorías';
  }
  document.getElementById('addCat').onclick = ()=>{
    const v = document.getElementById('newCat').value.trim(); if (!v) return;
    if ((cfg.categories || []).includes(v)){ alert('La categoría ya existe'); return; }
    const set = new Set([...(cfg.categories||[]), v]); cfg.categories = Array.from(set);
    ensureCategoryColor(v);
    cfg.categoryColors = { ...categoryColors };
    document.getElementById('newCat').value=''; renderConfig(cfg);
    populateCategorySelect(cfg);
    populateCategoryFilter(allSessions);
  };
  range.oninput = ()=> document.getElementById('opacityVal').textContent = (+range.value).toFixed(2);
  document.getElementById('saveCfg').onclick = async ()=>{
    const newCfg = {
      ...cfg,
      categories: [...(cfg.categories || [])],
      categoryColors: { ...categoryColors },
      defaultDurationMin: parseInt(document.getElementById('cfgDuration').value, 10)||90,
      opacity: +document.getElementById('cfgOpacity').value
    };
    const saved = await saveConfig(newCfg);
    configCategories = [...(saved.categories || [])];
    categoryColors = { ...(saved.categoryColors || categoryColors) };
    assignCategoryColors();
    alert('Configuración guardada');
    populateCategorySelect(saved);
    populateCategoryFilter(allSessions);
  };
}

let totalsSortState = 'none'; // none | desc | asc
let latestStats = null;

function renderLeader(stats){
  const card = document.getElementById('leaderCard');
  const nameEl = document.getElementById('leaderCatName');
  const hoursEl = document.getElementById('leaderCatHours');
  if (!card || !nameEl || !hoursEl) return;
  const entries = Object.entries((stats && stats.totalsHours) || {});
  if (!entries.length){
    nameEl.textContent = '—';
    nameEl.style.color = '#c0caf5';
    hoursEl.textContent = '0 h';
    card.classList.add('empty');
    return;
  }
  card.classList.remove('empty');
  entries.sort((a,b)=> b[1] - a[1]);
  const [cat, hrs] = entries[0];
  const color = getCategoryColor(cat);
  nameEl.textContent = cat || '—';
  nameEl.style.color = color;
  hoursEl.textContent = `${hrs.toFixed(2)} h`;
}

function renderStats(stats){
  latestStats = stats;
  const tbody = document.querySelector('#totals tbody'); tbody.innerHTML = '';
  const entries = Object.entries((stats && stats.totalsHours) || {});
  let sorted = entries.slice();
  if (totalsSortState === 'desc'){ sorted.sort((a,b)=> b[1] - a[1]); }
  else if (totalsSortState === 'asc'){ sorted.sort((a,b)=> a[1] - b[1]); }
  for (const [cat, hrs] of sorted){
    const badge = `<span class="cat-badge" data-cat="${(cat||'').replace(/"/g,'&quot;')}" style="--cat-color:${getCategoryColor(cat)}">${cat}</span>`;
    const tr = document.createElement('tr'); tr.innerHTML = `<td>${badge}</td><td>${hrs.toFixed(2)}</td>`; tbody.appendChild(tr);
  }
  renderLeader(stats);
  const header = document.getElementById('totalsHoursHeader');
  if (header){
    header.textContent = totalsSortState === 'desc' ? 'Horas ↓' : totalsSortState === 'asc' ? 'Horas ↑' : 'Horas';
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
    const safeCat = (s.category || '').replace(/"/g,'&quot;');
    const catBadge = s.category ? `<span class="cat-badge" data-cat="${safeCat}" style="--cat-color:${getCategoryColor(s.category)}">${s.category}</span>` : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${minText}</td>
      <td>${catBadge}</td>
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

function monthKeyFromDate(iso){
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function describeMonth(key){
  if (!key) return '';
  const [year, month] = key.split('-').map(Number);
  const date = new Date(year, (month||1)-1, 1);
  return date.toLocaleDateString('es-ES', { month:'long', year:'numeric' });
}
function populateMonthFilter(sessions){
  const select = document.getElementById('filterMonth');
  if (!select) return;
  const monthSet = new Set();
  for (const s of sessions){
    const key = monthKeyFromDate(s.startISO);
    if (key) monthSet.add(key);
  }
  const options = Array.from(monthSet).sort().reverse();
  select.innerHTML = '<option value="all">Todos</option>' + options.map(k=>`<option value="${k}">${describeMonth(k)}</option>`).join('');
}
function applySessionFilters(){
  const monthSel = document.getElementById('filterMonth');
  const typeSel = document.getElementById('filterType');
  const yearSel = document.getElementById('filterYear');
  const catSel = document.getElementById('filterCategory');
  const urlSel = document.getElementById('filterUrl');
  const monthVal = monthSel ? monthSel.value : 'all';
  const typeVal = typeSel ? typeSel.value : 'all';
  const yearVal = yearSel ? yearSel.value : 'all';
  const catVal = catSel ? catSel.value : 'all';
  const urlVal = urlSel ? urlSel.value : 'all';
  return allSessions.filter(s=>{
    const matchesMonth = monthVal === 'all' || monthKeyFromDate(s.startISO) === monthVal;
    const matchesType = typeVal === 'all' || (s.sessionType || '').toLowerCase() === typeVal;
    const matchesYear = yearVal === 'all' || yearFromDate(s.startISO) === yearVal;
    const matchesCat = catVal === 'all' || (s.category || '') === catVal;
    const hasUrl = !!(s.url && s.url.trim());
    const matchesUrl = urlVal === 'all' || (urlVal === 'with' ? hasUrl : !hasUrl);
    return matchesMonth && matchesType && matchesYear && matchesCat && matchesUrl;
  });
}
function yearFromDate(iso){
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return String(d.getFullYear());
}
function populateYearFilter(sessions){
  const select = document.getElementById('filterYear');
  if (!select) return;
  const years = new Set();
  for (const s of sessions){
    const y = yearFromDate(s.startISO);
    if (y) years.add(y);
  }
  const options = Array.from(years).sort().reverse();
  select.innerHTML = '<option value="all">Todos</option>' + options.map(y=>`<option value="${y}">${y}</option>`).join('');
}
function populateCategoryFilter(sessions){
  const select = document.getElementById('filterCategory');
  if (!select) return;
  const catSet = new Set(configCategories || []);
  for (const s of sessions || []){ if (s.category) catSet.add(s.category); }
  const cats = Array.from(catSet).sort();
  select.innerHTML = '<option value="all">Todas</option>' + cats.map(c=>`<option value="${c}">${c}</option>`).join('');
  applyCategoryColor(select);
}

const categoryPalette = ['#7aa2f7','#f7768e','#bb9af7','#0db9d7','#9ece6a','#e0af68','#ff9e64','#c0caf5','#565f89'];
let categoryColorMap = new Map();
let categoryColors = {};
let configCategories = [];
let ws;
let rcUrlInput;
let allSessions = [];
function collectAllCategories(extra = []){
  const set = new Set();
  (configCategories || []).forEach(c => c && set.add(c));
  (allSessions || []).forEach(s => { if (s && s.category) set.add(s.category); });
  (extra || []).forEach(c => c && set.add(c));
  return Array.from(set).sort();
}
function getRandomPaletteColor(used = []){
  const palette = categoryPalette;
  const available = palette.filter(c => !used.includes(c));
  const source = available.length ? available : palette;
  return source[Math.floor(Math.random()*source.length)];
}
function ensureCategoryColor(name){
  if (!name) return categoryPalette[0];
  if (!categoryColors[name]){
    categoryColors[name] = getRandomPaletteColor(Object.values(categoryColors));
  }
  return categoryColors[name];
}
function assignCategoryColors(extra = []){
  const categories = collectAllCategories(extra);
  categoryColorMap = new Map();
  categories.forEach(cat=>{
    const color = ensureCategoryColor(cat);
    categoryColorMap.set(cat, color);
  });
  refreshBadgeColors();
}
function getCategoryColor(cat){
  if (!cat) return categoryPalette[0];
  if (categoryColorMap.has(cat)) return categoryColorMap.get(cat);
  const color = ensureCategoryColor(cat);
  categoryColorMap.set(cat, color);
  return color;
}
function applyCategoryColor(select){
  if (!select) return;
  const value = select.value;
  if (!value || value === 'all'){
    select.classList.remove('colorized-select');
    select.style.removeProperty('--cat-color');
    select.style.removeProperty('color');
    select.style.removeProperty('border-color');
    return;
  }
  const color = getCategoryColor(value);
  if (!color){
    select.classList.remove('colorized-select');
    select.style.removeProperty('--cat-color');
    select.style.removeProperty('color');
    select.style.removeProperty('border-color');
    return;
  }
  select.classList.add('colorized-select');
  select.style.setProperty('--cat-color', color);
  select.style.color = color;
  select.style.borderColor = color;
}
function refreshBadgeColors(){
  document.querySelectorAll('.cat-badge[data-cat]').forEach(el=>{
    const cat = el.getAttribute('data-cat');
    if (!cat) return;
    const color = getCategoryColor(cat);
    if (color) el.style.setProperty('--cat-color', color);
  });
}

function updateUrlInput(value){
  if (!rcUrlInput) return;
  const next = value || '';
  if (rcUrlInput.value !== next) rcUrlInput.value = next;
}
function connectBus(){
  try {
    ws = new WebSocket('ws://127.0.0.1:8765');
    ws.onmessage = async (ev)=>{
      try{
        const msg = JSON.parse(ev.data);
        if (msg.type === 'session:complete'){ await refreshAll(); updateUrlInput(''); }
        if (msg.type === 'state' && msg.payload){ updateUrlInput(msg.payload.sessionUrl || ''); }
      }catch(_){}
    };
  } catch {}
}
function sendCmd(action, payload){ if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type:'command', action, payload })); }
function populateCategorySelect(cfg){
  const sel = document.getElementById('rcCategory'); if (!sel) return; sel.innerHTML = '';
  for (const c of (cfg.categories || [])){ const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); }
  applyCategoryColor(sel);
}
async function setOpenSheetLink(){
  const id = await getSheetId();
  const a = document.getElementById('openSheet');
  a.href = id ? ('https://docs.google.com/spreadsheets/d/'+id+'/edit') : '#';
}

async function refreshAll(){
  const [stats, sessions] = await Promise.all([loadStats(), loadSessions()]);
  allSessions = sessions;
  assignCategoryColors();
  applyCategoryColor(document.getElementById('rcCategory'));
  renderStats(stats);
  populateMonthFilter(sessions);
  populateYearFilter(sessions);
  populateCategoryFilter(sessions);
  renderSessions(applySessionFilters());
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
  document.getElementById('rcFinish').onclick = ()=> sendCmd('finish');

  const rcCat = document.getElementById('rcCategory');
  if (rcCat){
    rcCat.onchange = ()=>{
      applyCategoryColor(rcCat);
      const v = rcCat.value;
      sendCmd('setCategory', v);
      sendCmd('setSessionName', v);
    };
    applyCategoryColor(rcCat);
  }
  const rcType = document.getElementById('rcSessionType');
  if (rcType){ rcType.onchange = ()=> sendCmd('setSessionType', rcType.value); }
  rcUrlInput = document.getElementById('rcUrl');
  if (rcUrlInput){
    rcUrlInput.onchange = ()=> sendCmd('setSessionUrl', rcUrlInput.value.trim());
  }
  const monthSel = document.getElementById('filterMonth');
  const typeSel = document.getElementById('filterType');
  const yearSel = document.getElementById('filterYear');
  const catSel = document.getElementById('filterCategory');
  const urlSel = document.getElementById('filterUrl');
  const clearFiltersBtn = document.getElementById('clearFilters');
  if (monthSel){ monthSel.onchange = ()=> renderSessions(applySessionFilters()); }
  if (typeSel){ typeSel.onchange = ()=> renderSessions(applySessionFilters()); }
  if (yearSel){ yearSel.onchange = ()=> renderSessions(applySessionFilters()); }
  if (catSel){ catSel.onchange = ()=>{ applyCategoryColor(catSel); renderSessions(applySessionFilters()); }; }
  if (urlSel){ urlSel.onchange = ()=> renderSessions(applySessionFilters()); }
  if (clearFiltersBtn){
    clearFiltersBtn.onclick = ()=>{
      if (monthSel) monthSel.value = 'all';
      if (typeSel) typeSel.value = 'all';
      if (yearSel) yearSel.value = 'all';
      if (catSel){ catSel.value = 'all'; applyCategoryColor(catSel); }
      if (urlSel) urlSel.value = 'all';
      renderSessions(applySessionFilters());
    };
  }
  const totalsHeader = document.getElementById('totalsHoursHeader');
  if (totalsHeader){
    totalsHeader.onclick = ()=>{
      totalsSortState = totalsSortState === 'none' ? 'desc' : totalsSortState === 'desc' ? 'asc' : 'none';
      renderStats(latestStats || {});
      const label = totalsSortState === 'desc' ? 'Horas ↓' : totalsSortState === 'asc' ? 'Horas ↑' : 'Horas';
      totalsHeader.textContent = label;
    };
  }

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
