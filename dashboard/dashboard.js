// Helpers
async function loadConfig() { const r = await fetch('/api/config'); return await r.json(); }
async function saveConfig(cfg) { const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }); return await r.json(); }
async function loadSessions() { const r = await fetch('/api/sessions'); return await r.json(); }
async function loadStats() { const r = await fetch('/api/stats'); return await r.json(); }
async function getSheetId() { const r = await fetch('/api/sheet/id'); return (await r.json()).sheetId || ''; }

function renderConfig(cfg) {
  // Duration Slider
  const durationInput = document.getElementById('cfgDuration');
  const durationVal = document.getElementById('durationVal');
  const duration = cfg.defaultDurationMin || 90;
  durationInput.value = duration;
  if (durationVal) durationVal.textContent = `${duration} min`;

  durationInput.oninput = () => {
    if (durationVal) durationVal.textContent = `${durationInput.value} min`;
    // Optional: live update remote timer duration if desired, or wait for save
    // For now, let's keep the behavior of just updating the UI until save, 
    // BUT the original code sent 'setDurationSec' on input. Let's keep that if it was useful.
    const minutes = Number(durationInput.value) || 90;
    const seconds = Math.max(60, Math.round(minutes) * 60);
    sendCmd('setDurationSec', seconds);
  };

  // Opacity Slider
  const op = cfg.opacity ?? 0.85;
  const opacityInput = document.getElementById('cfgOpacity');
  const opacityVal = document.getElementById('opacityVal');
  opacityInput.value = op;
  if (opacityVal) opacityVal.textContent = (+op).toFixed(2);

  opacityInput.oninput = () => {
    if (opacityVal) opacityVal.textContent = (+opacityInput.value).toFixed(2);
  };

  // Categories
  configCategories = [...(cfg.categories || [])];
  categoryColors = { ...(cfg.categoryColors || {}) };
  assignCategoryColors();
  renderCategoryGrid(cfg);

  // Add Category Logic
  document.getElementById('addCat').onclick = () => {
    const input = document.getElementById('newCat');
    const v = input.value.trim();
    if (!v) return;
    if ((cfg.categories || []).includes(v)) { alert('La categoría ya existe'); return; }

    cfg.categories = [...(cfg.categories || []), v];
    ensureCategoryColor(v);
    cfg.categoryColors = { ...categoryColors };

    input.value = '';
    renderCategoryGrid(cfg);
    populateCategorySelect(cfg);
    populateCategoryFilter(allSessions);
  };

  // Save Logic
  document.getElementById('saveCfg').onclick = async () => {
    const newCfg = {
      ...cfg,
      categories: [...(cfg.categories || [])],
      categoryColors: { ...categoryColors },
      defaultDurationMin: parseInt(document.getElementById('cfgDuration').value, 10) || 90,
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

function renderCategoryGrid(cfg) {
  const grid = document.getElementById('catList');
  grid.innerHTML = '';

  for (const c of cfg.categories || []) {
    const card = document.createElement('div');
    card.className = 'category-card';
    const color = ensureCategoryColor(c);
    card.style.setProperty('--cat-color', color);

    // Color Picker
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'cat-color-picker';
    colorInput.value = color;
    colorInput.title = 'Cambiar color';
    colorInput.oninput = (ev) => {
      const newColor = ev.target.value;
      categoryColors[c] = newColor;
      card.style.setProperty('--cat-color', newColor);
      cfg.categoryColors = { ...categoryColors };
      assignCategoryColors();
      populateCategorySelect(cfg);
      populateCategoryFilter(allSessions);
    };

    // Name Input
    const nameInput = document.createElement('input');
    nameInput.value = c;
    nameInput.className = 'cat-name-edit';
    nameInput.onchange = () => {
      const newName = nameInput.value.trim();
      if (!newName) { nameInput.value = c; return; }
      if (newName === c) return;
      if ((cfg.categories || []).includes(newName)) { alert('La categoría ya existe'); nameInput.value = c; return; }

      // Update name in list
      cfg.categories = (cfg.categories || []).map(cat => cat === c ? newName : cat);
      // Move color to new name
      categoryColors[newName] = categoryColors[c];
      delete categoryColors[c];
      cfg.categoryColors = { ...categoryColors };

      renderCategoryGrid(cfg);
      populateCategorySelect(cfg);
      populateCategoryFilter(allSessions);
      refreshBadgeColors();
    };

    // Delete Button
    const btnDel = document.createElement('button');
    btnDel.className = 'btn-delete-cat';
    btnDel.innerHTML = '✕';
    btnDel.title = 'Eliminar categoría';
    btnDel.onclick = () => {
      if (!confirm(`¿Eliminar categoría "${c}"?`)) return;
      cfg.categories = (cfg.categories || []).filter(x => x !== c);
      delete categoryColors[c];
      cfg.categoryColors = { ...categoryColors };
      renderCategoryGrid(cfg);
      populateCategorySelect(cfg);
      populateCategoryFilter(allSessions);
      refreshBadgeColors();
    };

    card.appendChild(colorInput);
    card.appendChild(nameInput);
    card.appendChild(btnDel);
    grid.appendChild(card);
  }
}

let totalsSortState = 'none'; // none | desc | asc
let latestStats = null;

function renderLeader(stats) {
  const card = document.getElementById('leaderCard');
  const nameEl = document.getElementById('leaderCatName');
  const hoursEl = document.getElementById('leaderCatHours');
  if (!card || !nameEl || !hoursEl) return;
  const entries = Object.entries((stats && stats.totalsHours) || {});
  if (!entries.length) {
    nameEl.textContent = '—';
    nameEl.style.color = '#c0caf5';
    hoursEl.textContent = '0 h';
    card.classList.add('empty');
    return;
  }
  card.classList.remove('empty');
  entries.sort((a, b) => b[1] - a[1]);
  const [cat, hrs] = entries[0];
  const color = getCategoryColor(cat);
  nameEl.textContent = cat || '—';
  nameEl.style.color = color;
  hoursEl.textContent = `${hrs.toFixed(2)} h`;
}

let chartDonutInstance = null;
let chartBarInstance = null;

function calculateGamification(sessions) {
  // 1. XP & Level
  // Formula: Level N requires 100 * N^1.5 XP total? Or simple: 100 XP per level for now.
  // Let's do: 1 minute = 1 XP.
  // Level 1: 0-600 XP (0-10h)
  // Level 2: 600-1500 XP...
  // Simple linear for MVP: Level = floor(TotalMinutes / 600) + 1. (Every 10 hours = 1 level up)

  let totalMinutes = 0;
  const uniqueDates = new Set();

  (sessions || []).forEach(s => {
    const min = (s.durationSec ? s.durationSec / 60 : s.durationMin) || 0;
    totalMinutes += min;
    if (s.startISO) uniqueDates.add(s.startISO.split('T')[0]);
  });

  const xpPerLevel = 600; // 10 hours
  const currentLevel = Math.floor(totalMinutes / xpPerLevel) + 1;
  const currentLevelXP = Math.floor(totalMinutes % xpPerLevel);
  const nextLevelXP = xpPerLevel;
  const progressPct = (currentLevelXP / nextLevelXP) * 100;

  // Render Level
  const levelEl = document.getElementById('userLevel');
  const fillEl = document.getElementById('xpBarFill');
  const currXPEl = document.getElementById('currentXP');
  const nextXPEl = document.getElementById('nextLevelXP');

  if (levelEl) levelEl.textContent = currentLevel;
  if (fillEl) fillEl.style.width = `${progressPct}%`;
  if (currXPEl) currXPEl.textContent = Math.floor(currentLevelXP);
  if (nextXPEl) nextXPEl.textContent = nextLevelXP;

  // 2. Streaks
  // Sort dates desc
  const sortedDates = Array.from(uniqueDates).sort().reverse();
  let streak = 0;
  if (sortedDates.length > 0) {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    // Check if most recent is today or yesterday
    const last = sortedDates[0];
    if (last === today || last === yesterday) {
      streak = 1;
      let checkDate = new Date(last);
      for (let i = 1; i < sortedDates.length; i++) {
        checkDate.setDate(checkDate.getDate() - 1);
        const expected = checkDate.toISOString().split('T')[0];
        if (sortedDates[i] === expected) {
          streak++;
        } else {
          break;
        }
      }
    }
  }

  const streakEl = document.getElementById('streakDays');
  if (streakEl) streakEl.textContent = streak;
}

function renderStats(stats) {
  latestStats = stats;

  // Update Leader Card (existing logic)
  renderLeader(stats);

  // Calculate Gamification
  calculateGamification(allSessions);


  // Prepare Data
  const entries = Object.entries((stats && stats.totalsHours) || {});
  // Sort by hours desc
  entries.sort((a, b) => b[1] - a[1]);

  const labels = entries.map(e => e[0]);
  const dataHours = entries.map(e => e[1]);
  const colors = labels.map(cat => getCategoryColor(cat));

  // --- Donut Chart (Distribution) ---
  const ctxDonut = document.getElementById('chartDonut');
  if (ctxDonut) {
    if (chartDonutInstance) chartDonutInstance.destroy();
    chartDonutInstance = new Chart(ctxDonut, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: dataHours,
          backgroundColor: colors,
          borderColor: '#1a1b26',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'right', labels: { color: '#9aa5ce', font: { family: 'JetBrains Mono' } } }
        }
      }
    });
  }

  // --- Bar Chart (Last 7 Days) ---
  // We need to calculate daily totals from allSessions
  const dailyTotals = {}; // { 'YYYY-MM-DD': hours }
  const today = new Date();
  const last7Days = [];

  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(today.getDate() - i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const key = `${yyyy}-${mm}-${dd}`;
    last7Days.push(key);
    dailyTotals[key] = 0;
  }

  (allSessions || []).forEach(s => {
    if (!s.startISO) return;
    const dateKey = s.startISO.split('T')[0];
    if (dailyTotals.hasOwnProperty(dateKey)) {
      const hrs = (s.durationSec ? s.durationSec / 3600 : (s.durationMin || 0) / 60);
      dailyTotals[dateKey] += hrs;
    }
  });

  const barData = last7Days.map(k => dailyTotals[k]);
  const barLabels = last7Days.map(k => k.slice(5)); // MM-DD

  const ctxBar = document.getElementById('chartBar');
  if (ctxBar) {
    if (chartBarInstance) chartBarInstance.destroy();
    chartBarInstance = new Chart(ctxBar, {
      type: 'bar',
      data: {
        labels: barLabels,
        datasets: [{
          label: 'Horas diarias',
          data: barData,
          backgroundColor: '#7aa2f7',
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        scales: {
          y: { beginAtZero: true, grid: { color: '#2d2f40' }, ticks: { color: '#9aa5ce' } },
          x: { grid: { display: false }, ticks: { color: '#9aa5ce' } }
        },
        plugins: {
          legend: { display: false }
        }
      }
    });
  }
}
function formatDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return typeof iso === 'string' ? iso : '—';
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function sortSessionsByStart(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  arr.sort((a, b) => {
    const aTime = Date.parse(a?.startISO || '');
    const bTime = Date.parse(b?.startISO || '');
    const aFallback = Number(a?.id || 0);
    const bFallback = Number(b?.id || 0);
    const aVal = Number.isNaN(aTime) ? aFallback : aTime;
    const bVal = Number.isNaN(bTime) ? bFallback : bTime;
    return bVal - aVal;
  });
  return arr;
}
function renderSessions(sessions) {
  const ordered = sortSessionsByStart(sessions || []);
  const tbody = document.querySelector('#sessions tbody'); tbody.innerHTML = '';
  for (const s of ordered) {
    const minExact = ((s.durationSec ? s.durationSec / 60 : s.durationMin) || 0);
    const minText = Number(minExact).toFixed(2) + ' min';
    const fechas = formatDateShort(s.startISO);
    const urlCell = s.url ? `<a href="${s.url}" target="_blank" title="${s.url}">🔗 Link</a>` : '—';
    const safeCat = (s.category || '').replace(/"/g, '&quot;');
    const catBadge = s.category ? `<span class="cat-badge" data-cat="${safeCat}" style="--cat-color:${getCategoryColor(s.category)}">${s.category}</span>` : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${minText}</td>
      <td>${catBadge}</td>
      <td style="text-transform:capitalize">${s.sessionType || '—'}</td>
      <td>${fechas}</td>
      <td>${urlCell}</td>
      <td><button class="btn-trash" data-del="${s.id || ''}" title="Borrar sesión">🗑</button></td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('button[data-del]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-del');
      if (!confirm('¿Borrar esta sesión (no borra Sheets en esta versión)?')) return;
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      await refreshAll();
    };
  });
}

function monthKeyFromDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function describeMonth(key) {
  if (!key) return '';
  const [year, month] = key.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, 1);
  return date.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
}
function populateMonthFilter(sessions) {
  const select = document.getElementById('filterMonth');
  if (!select) return;
  const monthSet = new Set();
  for (const s of sessions) {
    const key = monthKeyFromDate(s.startISO);
    if (key) monthSet.add(key);
  }
  const options = Array.from(monthSet).sort().reverse();
  select.innerHTML = '<option value="all">Todos</option>' + options.map(k => `<option value="${k}">${describeMonth(k)}</option>`).join('');
}
function applySessionFilters() {
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
  return allSessions.filter(s => {
    const matchesMonth = monthVal === 'all' || monthKeyFromDate(s.startISO) === monthVal;
    const matchesType = typeVal === 'all' || (s.sessionType || '').toLowerCase() === typeVal;
    const matchesYear = yearVal === 'all' || yearFromDate(s.startISO) === yearVal;
    const matchesCat = catVal === 'all' || (s.category || '') === catVal;
    const hasUrl = !!(s.url && s.url.trim());
    const matchesUrl = urlVal === 'all' || (urlVal === 'with' ? hasUrl : !hasUrl);
    return matchesMonth && matchesType && matchesYear && matchesCat && matchesUrl;
  });
}
function yearFromDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return String(d.getFullYear());
}
function populateYearFilter(sessions) {
  const select = document.getElementById('filterYear');
  if (!select) return;
  const years = new Set();
  for (const s of sessions) {
    const y = yearFromDate(s.startISO);
    if (y) years.add(y);
  }
  const options = Array.from(years).sort().reverse();
  select.innerHTML = '<option value="all">Todos</option>' + options.map(y => `<option value="${y}">${y}</option>`).join('');
}
function populateCategoryFilter(sessions) {
  const select = document.getElementById('filterCategory');
  if (!select) return;
  const catSet = new Set(configCategories || []);
  for (const s of sessions || []) { if (s.category) catSet.add(s.category); }
  const cats = Array.from(catSet).sort();
  select.innerHTML = '<option value="all">Todas</option>' + cats.map(c => `<option value="${c}">${c}</option>`).join('');
  applyCategoryColor(select);
}

const categoryPalette = ['#7aa2f7', '#f7768e', '#bb9af7', '#0db9d7', '#9ece6a', '#e0af68', '#ff9e64', '#c0caf5', '#565f89'];
let categoryColorMap = new Map();
let categoryColors = {};
let configCategories = [];
let ws;
let rcUrlInput;
let allSessions = [];
let remoteState = { state: 'idle', durationSec: 5400, remainingSec: 5400, category: '', sessionName: '', sessionType: 'privada' };
function collectAllCategories(extra = []) {
  const set = new Set();
  (configCategories || []).forEach(c => c && set.add(c));
  (allSessions || []).forEach(s => { if (s && s.category) set.add(s.category); });
  (extra || []).forEach(c => c && set.add(c));
  return Array.from(set).sort();
}
function getRandomPaletteColor(used = []) {
  const palette = categoryPalette;
  const available = palette.filter(c => !used.includes(c));
  const source = available.length ? available : palette;
  return source[Math.floor(Math.random() * source.length)];
}
function ensureCategoryColor(name) {
  if (!name) return categoryPalette[0];
  if (!categoryColors[name]) {
    categoryColors[name] = getRandomPaletteColor(Object.values(categoryColors));
  }
  return categoryColors[name];
}
function assignCategoryColors(extra = []) {
  const categories = collectAllCategories(extra);
  categoryColorMap = new Map();
  categories.forEach(cat => {
    const color = ensureCategoryColor(cat);
    categoryColorMap.set(cat, color);
  });
  refreshBadgeColors();
}
function getCategoryColor(cat) {
  if (!cat) return categoryPalette[0];
  if (categoryColorMap.has(cat)) return categoryColorMap.get(cat);
  const color = ensureCategoryColor(cat);
  categoryColorMap.set(cat, color);
  return color;
}
function applyCategoryColor(select) {
  if (!select) return;
  const value = select.value;
  if (!value || value === 'all') {
    select.classList.remove('colorized-select');
    select.style.removeProperty('--cat-color');
    select.style.removeProperty('color');
    select.style.removeProperty('border-color');
    return;
  }
  const color = getCategoryColor(value);
  if (!color) {
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
function refreshBadgeColors() {
  document.querySelectorAll('.cat-badge[data-cat]').forEach(el => {
    const cat = el.getAttribute('data-cat');
    if (!cat) return;
    const color = getCategoryColor(cat);
    if (color) el.style.setProperty('--cat-color', color);
  });
}
function formatClock(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function renderRemoteTimer() {
  const valEl = document.getElementById('rcTimerValue');
  const stateEl = document.getElementById('rcTimerState');
  const elapsedEl = document.getElementById('rcTimerElapsed');
  const barEl = document.getElementById('rcTimerProgress');
  if (!valEl || !stateEl || !elapsedEl) return;
  const duration = Math.max(1, Number(remoteState.durationSec) || 1);
  const remaining = Math.max(0, Math.min(duration, Number(remoteState.remainingSec) || 0));
  const elapsed = Math.max(0, duration - remaining);
  valEl.textContent = formatClock(remaining);
  const stateMap = { running: 'En curso', paused: 'En pausa', idle: 'En espera' };
  const catLabel = remoteState.sessionName || remoteState.category || 'Sin categoría';
  stateEl.textContent = `${stateMap[remoteState.state] || '—'} — ${catLabel}`;
  elapsedEl.textContent = `Transcurrido ${formatClock(elapsed)} / ${formatClock(duration)}`;
  if (barEl) {
    const pct = Math.max(0, Math.min(100, (elapsed / duration) * 100));
    barEl.style.width = `${pct}%`;
  }
}
function updateRemoteState(next = {}) {
  remoteState = { ...remoteState, ...next };
  renderRemoteTimer();
}
async function fetchRemoteState() {
  try {
    const resp = await fetch('/api/state');
    if (!resp.ok) return;
    const data = await resp.json();
    updateRemoteState(data);
    updateUrlInput(data.sessionUrl || '');
  } catch (_) { }
}

function updateUrlInput(value) {
  if (!rcUrlInput) return;
  const next = value || '';
  if (rcUrlInput.value !== next) rcUrlInput.value = next;
}
function connectBus() {
  try {
    ws = new WebSocket('ws://127.0.0.1:8765');
    ws.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'session:complete') { await refreshAll(); updateUrlInput(''); }
        if (msg.type === 'state' && msg.payload) {
          updateRemoteState(msg.payload);
          updateUrlInput(msg.payload.sessionUrl || '');
        }
      } catch (_) { }
    };
    ws.onclose = () => {
      ws = null;
      setTimeout(connectBus, 2000);
    };
  } catch { }
}
function sendCmd(action, payload) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'command', action, payload })); }
function populateCategorySelect(cfg) {
  const sel = document.getElementById('rcCategory'); if (!sel) return; sel.innerHTML = '';
  for (const c of (cfg.categories || [])) { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); }
  applyCategoryColor(sel);
}
async function setOpenSheetLink() {
  const id = await getSheetId();
  const a = document.getElementById('openSheet');
  a.href = id ? ('https://docs.google.com/spreadsheets/d/' + id + '/edit') : '#';
}

async function refreshAll() {
  const [stats, sessions] = await Promise.all([loadStats(), loadSessions()]);
  allSessions = sortSessionsByStart(sessions || []);
  assignCategoryColors();
  applyCategoryColor(document.getElementById('rcCategory'));
  renderStats(stats);
  populateMonthFilter(allSessions);
  populateYearFilter(allSessions);
  populateCategoryFilter(allSessions);
  renderSessions(applySessionFilters());
}

async function main() {
  // Planning Logic
  const taskInput = document.getElementById('currentTask');
  if (taskInput) {
    // Sync with remote state
    taskInput.onchange = () => {
      sendCmd('setSessionName', taskInput.value.trim()); // Using sessionName as "Task" for now
    };
  }

  // To-Do List Logic
  const todoList = document.getElementById('todoList');
  const newTodoInput = document.getElementById('newTodo');
  const addTodoBtn = document.getElementById('addTodo');

  let todos = JSON.parse(localStorage.getItem('animatek-todos') || '[]');

  function renderTodos() {
    if (!todoList) return;
    todoList.innerHTML = '';
    todos.forEach((todo, idx) => {
      const li = document.createElement('li');
      li.className = `todo-item ${todo.done ? 'done' : ''}`;
      li.innerHTML = `
        <input type="checkbox" class="todo-checkbox" ${todo.done ? 'checked' : ''}>
        <span class="todo-text">${todo.text}</span>
        <button class="btn-del-todo">✕</button>
      `;

      const checkbox = li.querySelector('.todo-checkbox');
      checkbox.onchange = () => {
        todos[idx].done = checkbox.checked;
        saveTodos();
        renderTodos();
      };

      const delBtn = li.querySelector('.btn-del-todo');
      delBtn.onclick = () => {
        todos.splice(idx, 1);
        saveTodos();
        renderTodos();
      };

      todoList.appendChild(li);
    });
  }

  function saveTodos() {
    localStorage.setItem('animatek-todos', JSON.stringify(todos));
  }

  if (addTodoBtn && newTodoInput) {
    const addTodo = () => {
      const text = newTodoInput.value.trim();
      if (!text) return;
      todos.push({ text, done: false });
      saveTodos();
      renderTodos();
      newTodoInput.value = '';
    };
    addTodoBtn.onclick = addTodo;
    newTodoInput.onkeydown = (e) => { if (e.key === 'Enter') addTodo(); };
  }

  renderTodos();

  // Update task input when remote state changes
  const originalUpdateRemoteState = updateRemoteState;
  updateRemoteState = (next = {}) => {
    originalUpdateRemoteState(next); // Call original
    // Update task input if it's different and not focused (to avoid overwriting user typing)
    if (taskInput && document.activeElement !== taskInput) {
      const val = next.sessionName || '';
      if (taskInput.value !== val) taskInput.value = val;
    }
  };

  document.getElementById('btnAuth').onclick = () => window.open('/api/google/auth', '_blank');
  const cfg = await loadConfig();
  renderConfig(cfg);
  populateCategorySelect(cfg);

  await setOpenSheetLink();
  await refreshAll();

  document.getElementById('rcStart').onclick = () => sendCmd('start');
  document.getElementById('rcPause').onclick = () => sendCmd('pause');
  document.getElementById('rcResume').onclick = () => sendCmd('resume');
  document.getElementById('rcReset').onclick = () => sendCmd('reset');
  document.getElementById('rcFinish').onclick = () => sendCmd('finish');

  const rcCat = document.getElementById('rcCategory');
  if (rcCat) {
    rcCat.onchange = () => {
      applyCategoryColor(rcCat);
      const v = rcCat.value;
      sendCmd('setCategory', v);
    };
    applyCategoryColor(rcCat);
  }
  const rcType = document.getElementById('rcSessionType');
  if (rcType) { rcType.onchange = () => sendCmd('setSessionType', rcType.value); }
  rcUrlInput = document.getElementById('rcUrl');
  if (rcUrlInput) {
    rcUrlInput.onchange = () => sendCmd('setSessionUrl', rcUrlInput.value.trim());
  }
  renderRemoteTimer();
  await fetchRemoteState();
  const monthSel = document.getElementById('filterMonth');
  const typeSel = document.getElementById('filterType');
  const yearSel = document.getElementById('filterYear');
  const catSel = document.getElementById('filterCategory');
  const urlSel = document.getElementById('filterUrl');
  const clearFiltersBtn = document.getElementById('clearFilters');
  if (monthSel) { monthSel.onchange = () => renderSessions(applySessionFilters()); }
  if (typeSel) { typeSel.onchange = () => renderSessions(applySessionFilters()); }
  if (yearSel) { yearSel.onchange = () => renderSessions(applySessionFilters()); }
  if (catSel) { catSel.onchange = () => { applyCategoryColor(catSel); renderSessions(applySessionFilters()); }; }
  if (urlSel) { urlSel.onchange = () => renderSessions(applySessionFilters()); }
  if (clearFiltersBtn) {
    clearFiltersBtn.onclick = () => {
      if (monthSel) monthSel.value = 'all';
      if (typeSel) typeSel.value = 'all';
      if (yearSel) yearSel.value = 'all';
      if (catSel) { catSel.value = 'all'; applyCategoryColor(catSel); }
      if (urlSel) urlSel.value = 'all';
      renderSessions(applySessionFilters());
    };
  }
  const totalsHeader = document.getElementById('totalsHoursHeader');
  if (totalsHeader) {
    totalsHeader.onclick = () => {
      totalsSortState = totalsSortState === 'none' ? 'desc' : totalsSortState === 'desc' ? 'asc' : 'none';
      renderStats(latestStats || {});
      const label = totalsSortState === 'desc' ? 'Horas ↓' : totalsSortState === 'asc' ? 'Horas ↑' : 'Horas';
      totalsHeader.textContent = label;
    };
  }

  // Import from Sheets
  document.getElementById('importSheets').onclick = async () => {
    const id = await getSheetId();
    if (!id) { alert('Configura SHEET_ID en .env y conecta Google.'); return; }
    const resp = await fetch('/api/sessions/importFromSheets', { method: 'POST' });
    const data = await resp.json();
    if (resp.ok) { alert('Importadas ' + data.imported + ' sesiones desde Sheets.'); await refreshAll(); }
    else { alert('Error: ' + (data.error || 'desconocido')); }
  };

  // Lights control
  async function lightAction(url) {
    try {
      const r = await fetch(url, { method: 'POST' });
      if (!r.ok) { const e = await r.json(); alert('Error: ' + (e.error || r.status)); }
    } catch (e) { alert('Error de conexión: ' + e.message); }
  }

  document.getElementById('lightsAllOn').onclick = () => lightAction('/api/lights/on');
  document.getElementById('lightsAllOff').onclick = () => lightAction('/api/lights/off');
  document.getElementById('lightsEstudioOn').onclick = () => lightAction('/api/lights/estudio/on');
  document.getElementById('lightsEstudioOff').onclick = () => lightAction('/api/lights/estudio/off');
  document.getElementById('lightsSalonOn').onclick = () => lightAction('/api/lights/salon/on');
  document.getElementById('lightsSalonOff').onclick = () => lightAction('/api/lights/salon/off');

  // Load presets
  try {
    const presetsResp = await fetch('/api/lights/presets');
    const presets = await presetsResp.json();
    const container = document.getElementById('lightsPresets');
    for (const [key, p] of Object.entries(presets)) {
      const btn = document.createElement('button');
      btn.className = 'btn-light btn-light-preset';
      btn.textContent = `${p.emoji} ${p.name}`;
      btn.title = p.desc;
      btn.onclick = () => lightAction(`/api/lights/preset/${key}`);
      container.appendChild(btn);
    }
  } catch (_) {}

  setInterval(refreshAll, 20000);
  connectBus();
  initTheme();
}

function initTheme() {
  const btn = document.getElementById('themeToggle');
  const body = document.body;
  const saved = localStorage.getItem('animatek-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  // Default to dark if no preference, or respect system pref if not set
  let isLight = saved === 'light';
  if (!saved && !prefersDark) isLight = true; // If system is light, default to light? Or default to dark as per original design?
  // Original design was dark. Let's stick to dark default unless explicitly light.

  if (saved === 'light') {
    body.classList.add('light-mode');
    if (btn) btn.textContent = '☀️';
  } else {
    body.classList.remove('light-mode');
    if (btn) btn.textContent = '🌙';
  }

  if (btn) {
    btn.onclick = () => {
      const isNowLight = body.classList.toggle('light-mode');
      localStorage.setItem('animatek-theme', isNowLight ? 'light' : 'dark');
      btn.textContent = isNowLight ? '☀️' : '🌙';
    };
  }
}

main();
