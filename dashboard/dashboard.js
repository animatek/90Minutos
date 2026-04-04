// --- Utilities ---
function escapeHTML(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str ?? '')));
  return div.innerHTML;
}

function sanitizeUrl(url) {
  if (!url) return '';
  const s = String(url).trim();
  try {
    const parsed = new URL(s);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return s;
  } catch {}
  return '';
}

function toast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-visible'));
  setTimeout(() => {
    el.classList.remove('toast-visible');
    el.addEventListener('transitionend', () => el.remove());
  }, duration);
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

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

  const sendDuration = debounce(() => {
    const minutes = Number(durationInput.value) || 90;
    sendCmd('setDurationSec', Math.max(60, Math.round(minutes) * 60));
  }, 400);
  durationInput.oninput = () => {
    if (durationVal) durationVal.textContent = `${durationInput.value} min`;
    sendDuration();
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
    if ((cfg.categories || []).includes(v)) { toast('La categoría ya existe', 'warning'); return; }

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
    toast('Configuración guardada', 'success');
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
      if ((cfg.categories || []).includes(newName)) { toast('La categoría ya existe', 'warning'); nameInput.value = c; return; }

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

let chartDonutInstance = null;
let chartBarInstance = null;
let selectedSessionIds = new Set();
let currentPage = 1;
const PAGE_SIZE = 20;
let currentSearchQuery = '';
let lastFilteredSessions = [];


function renderKPIs(sessions) {
  const totalHoursEl = document.getElementById('kpiTotalHours');
  const weekSessionsEl = document.getElementById('kpiWeekSessions');
  const avgDurationEl = document.getElementById('kpiAvgDuration');
  const bestDayEl = document.getElementById('kpiBestDay');

  let totalMin = 0;
  const dailyMin = {};
  const now = new Date();
  const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
  let weekCount = 0;

  (sessions || []).forEach(s => {
    const min = (s.durationSec ? s.durationSec / 60 : s.durationMin) || 0;
    totalMin += min;
    if (s.startISO) {
      const dateKey = s.startISO.split('T')[0];
      dailyMin[dateKey] = (dailyMin[dateKey] || 0) + min;
      if (new Date(s.startISO) >= weekAgo) weekCount++;
    }
  });

  const totalHours = totalMin / 60;
  const avgMin = sessions.length ? totalMin / sessions.length : 0;

  // Best day of week
  const dayOfWeekMin = [0, 0, 0, 0, 0, 0, 0]; // Sun-Sat
  Object.entries(dailyMin).forEach(([dateStr, mins]) => {
    const dow = new Date(dateStr).getDay();
    dayOfWeekMin[dow] += mins;
  });
  const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  let bestDowIdx = 0;
  dayOfWeekMin.forEach((v, i) => { if (v > dayOfWeekMin[bestDowIdx]) bestDowIdx = i; });
  const bestDay = dayOfWeekMin[bestDowIdx] > 0 ? dayNames[bestDowIdx] : '—';

  if (totalHoursEl) totalHoursEl.textContent = totalHours.toFixed(1);
  if (weekSessionsEl) weekSessionsEl.textContent = weekCount;
  if (avgDurationEl) avgDurationEl.textContent = avgMin.toFixed(0);
  if (bestDayEl) bestDayEl.textContent = bestDay;

  // Week comparison
  const twoWeeksAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 14);
  let thisWeekHrs = 0, lastWeekHrs = 0, thisWeekCount = 0, lastWeekCount = 0;
  (sessions || []).forEach(s => {
    if (!s.startISO) return;
    const d = new Date(s.startISO);
    const hrs = (s.durationSec ? s.durationSec / 3600 : (s.durationMin || 0) / 60);
    if (d >= weekAgo) { thisWeekHrs += hrs; thisWeekCount++; }
    else if (d >= twoWeeksAgo) { lastWeekHrs += hrs; lastWeekCount++; }
  });

  function deltaText(curr, prev) {
    if (prev === 0 && curr === 0) return { text: '=', cls: 'flat' };
    if (prev === 0) return { text: '+100%', cls: 'up' };
    const pct = Math.round(((curr - prev) / prev) * 100);
    if (pct > 0) return { text: `+${pct}%`, cls: 'up' };
    if (pct < 0) return { text: `${pct}%`, cls: 'down' };
    return { text: '=', cls: 'flat' };
  }

  const wcHoursThis = document.getElementById('wcHoursThis');
  const wcHoursDelta = document.getElementById('wcHoursDelta');
  const wcSessionsThis = document.getElementById('wcSessionsThis');
  const wcSessionsDelta = document.getElementById('wcSessionsDelta');

  if (wcHoursThis) wcHoursThis.textContent = thisWeekHrs.toFixed(1) + 'h';
  if (wcHoursDelta) {
    const d = deltaText(thisWeekHrs, lastWeekHrs);
    wcHoursDelta.textContent = d.text;
    wcHoursDelta.className = `week-compare-delta ${d.cls}`;
  }
  if (wcSessionsThis) wcSessionsThis.textContent = thisWeekCount;
  if (wcSessionsDelta) {
    const d = deltaText(thisWeekCount, lastWeekCount);
    wcSessionsDelta.textContent = d.text;
    wcSessionsDelta.className = `week-compare-delta ${d.cls}`;
  }
}

function renderHeatmap(sessions) {
  const grid = document.getElementById('heatmapGrid');
  if (!grid) return;
  grid.innerHTML = '';

  // Build daily hours map
  const dailyHours = {};
  (sessions || []).forEach(s => {
    if (!s.startISO) return;
    const key = s.startISO.split('T')[0];
    const hrs = (s.durationSec ? s.durationSec / 3600 : (s.durationMin || 0) / 60);
    dailyHours[key] = (dailyHours[key] || 0) + hrs;
  });

  // Last ~26 weeks (6 months)
  const today = new Date();
  const totalWeeks = 26;
  // Find the start: go back totalWeeks*7 days, align to Sunday
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - (totalWeeks * 7) - today.getDay());

  // Find max for scaling
  const allVals = Object.values(dailyHours);
  const maxHours = allVals.length ? Math.max(...allVals) : 1;

  function getLevel(hrs) {
    if (!hrs || hrs <= 0) return 0;
    const ratio = hrs / maxHours;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  }

  const dayNames = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

  // Build weeks
  const cursor = new Date(startDate);
  while (cursor <= today) {
    const weekCol = document.createElement('div');
    weekCol.className = 'heatmap-week';

    for (let d = 0; d < 7; d++) {
      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';
      const dateStr = cursor.toISOString().split('T')[0];

      if (cursor <= today) {
        const hrs = dailyHours[dateStr] || 0;
        const level = getLevel(hrs);
        if (level > 0) cell.setAttribute('data-level', level);
        cell.title = `${dateStr}: ${hrs.toFixed(1)}h`;
      } else {
        cell.style.visibility = 'hidden';
      }

      weekCol.appendChild(cell);
      cursor.setDate(cursor.getDate() + 1);
    }

    grid.appendChild(weekCol);
  }
}

// Calendar
let calendarMonth = new Date().getMonth();
let calendarYear = new Date().getFullYear();

function renderCalendar(sessions) {
  const grid = document.getElementById('calendarGrid');
  const title = document.getElementById('calTitle');
  if (!grid || !title) return;

  const monthDate = new Date(calendarYear, calendarMonth, 1);
  title.textContent = monthDate.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

  // Build daily data
  const dailyData = {}; // dateKey -> { hours, categories: Set }
  (sessions || []).forEach(s => {
    if (!s.startISO) return;
    const key = s.startISO.split('T')[0];
    if (!dailyData[key]) dailyData[key] = { hours: 0, categories: new Set() };
    const hrs = (s.durationSec ? s.durationSec / 3600 : (s.durationMin || 0) / 60);
    dailyData[key].hours += hrs;
    if (s.category) dailyData[key].categories.add(s.category);
  });

  grid.innerHTML = '';
  const dayHeaders = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  for (const dh of dayHeaders) {
    const hdr = document.createElement('div');
    hdr.className = 'calendar-day-header';
    hdr.textContent = dh;
    grid.appendChild(hdr);
  }

  const firstDay = new Date(calendarYear, calendarMonth, 1);
  const lastDay = new Date(calendarYear, calendarMonth + 1, 0);
  // Monday = 0 in our grid
  let startDow = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6;

  const todayStr = new Date().toISOString().split('T')[0];

  // Empty cells before
  for (let i = 0; i < startDow; i++) {
    const empty = document.createElement('div');
    empty.className = 'calendar-day empty';
    grid.appendChild(empty);
  }

  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const data = dailyData[dateStr];
    const cell = document.createElement('div');
    cell.className = 'calendar-day' + (dateStr === todayStr ? ' today' : '');

    const num = document.createElement('span');
    num.className = 'calendar-day-num';
    num.textContent = d;
    cell.appendChild(num);

    if (data && data.hours > 0) {
      const hrs = document.createElement('span');
      hrs.className = 'calendar-day-hours';
      hrs.textContent = data.hours.toFixed(1) + 'h';
      cell.appendChild(hrs);

      if (data.categories.size > 0) {
        const dots = document.createElement('div');
        dots.className = 'calendar-day-dots';
        for (const cat of data.categories) {
          const dot = document.createElement('div');
          dot.className = 'calendar-cat-dot';
          dot.style.background = getCategoryColor(cat);
          dot.title = cat;
          dots.appendChild(dot);
        }
        cell.appendChild(dots);
      }
    }

    cell.title = dateStr + (data ? ` — ${data.hours.toFixed(1)}h` : '');
    grid.appendChild(cell);
  }
}

function renderStats(stats) {
  latestStats = stats;


  // KPI Cards
  renderKPIs(allSessions);

  // Heatmap
  renderHeatmap(allSessions);

  // Calendar
  renderCalendar(allSessions);

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
          borderColor: cssVar('--bg-body'),
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'right', labels: { color: cssVar('--text-muted'), font: { family: 'JetBrains Mono' } } }
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
          backgroundColor: cssVar('--accent-color'),
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        scales: {
          y: { beginAtZero: true, grid: { color: cssVar('--border-color') }, ticks: { color: cssVar('--text-muted') } },
          x: { grid: { display: false }, ticks: { color: cssVar('--text-muted') } }
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
function updateBulkBar() {
  const bar = document.getElementById('bulkBar');
  const countEl = document.getElementById('bulkCount');
  if (!bar) return;
  if (selectedSessionIds.size > 0) {
    bar.style.display = 'flex';
    if (countEl) countEl.textContent = `${selectedSessionIds.size} seleccionada${selectedSessionIds.size > 1 ? 's' : ''}`;
  } else {
    bar.style.display = 'none';
  }
}

function applySearch(sessions) {
  if (!currentSearchQuery) return sessions;
  const q = currentSearchQuery.toLowerCase();
  return sessions.filter(s => {
    const cat = (s.category || '').toLowerCase();
    const notes = (s.notes || '').toLowerCase();
    const url = (s.url || '').toLowerCase();
    const name = (s.sessionName || '').toLowerCase();
    return cat.includes(q) || notes.includes(q) || url.includes(q) || name.includes(q);
  });
}

function renderPagination(totalItems) {
  const container = document.getElementById('pagination');
  if (!container) return;
  container.innerHTML = '';
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  if (totalPages <= 1) return;

  // Prev button
  const prevBtn = document.createElement('button');
  prevBtn.textContent = '‹';
  prevBtn.disabled = currentPage <= 1;
  prevBtn.onclick = () => { currentPage--; renderSessions(lastFilteredSessions); };
  container.appendChild(prevBtn);

  // Page buttons (show max 7 pages with ellipsis)
  const maxVisible = 7;
  let start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  let end = Math.min(totalPages, start + maxVisible - 1);
  if (end - start < maxVisible - 1) start = Math.max(1, end - maxVisible + 1);

  if (start > 1) {
    const btn = document.createElement('button');
    btn.textContent = '1';
    btn.onclick = () => { currentPage = 1; renderSessions(lastFilteredSessions); };
    container.appendChild(btn);
    if (start > 2) {
      const dots = document.createElement('span');
      dots.textContent = '…';
      dots.className = 'pagination-info';
      container.appendChild(dots);
    }
  }

  for (let i = start; i <= end; i++) {
    const btn = document.createElement('button');
    btn.textContent = i;
    if (i === currentPage) btn.classList.add('active');
    btn.onclick = () => { currentPage = i; renderSessions(lastFilteredSessions); };
    container.appendChild(btn);
  }

  if (end < totalPages) {
    if (end < totalPages - 1) {
      const dots = document.createElement('span');
      dots.textContent = '…';
      dots.className = 'pagination-info';
      container.appendChild(dots);
    }
    const btn = document.createElement('button');
    btn.textContent = totalPages;
    btn.onclick = () => { currentPage = totalPages; renderSessions(lastFilteredSessions); };
    container.appendChild(btn);
  }

  // Next button
  const nextBtn = document.createElement('button');
  nextBtn.textContent = '›';
  nextBtn.disabled = currentPage >= totalPages;
  nextBtn.onclick = () => { currentPage++; renderSessions(lastFilteredSessions); };
  container.appendChild(nextBtn);

  // Info
  const info = document.createElement('span');
  info.className = 'pagination-info';
  const from = (currentPage - 1) * PAGE_SIZE + 1;
  const to = Math.min(currentPage * PAGE_SIZE, totalItems);
  info.textContent = `${from}–${to} de ${totalItems}`;
  container.appendChild(info);
}

function renderSessions(sessions) {
  selectedSessionIds.clear();
  updateBulkBar();
  const ordered = sortSessionsByStart(sessions || []);
  const searched = applySearch(ordered);
  lastFilteredSessions = sessions;

  // Pagination
  const totalPages = Math.max(1, Math.ceil(searched.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const paged = searched.slice(startIdx, startIdx + PAGE_SIZE);

  const tbody = document.querySelector('#sessions tbody'); tbody.innerHTML = '';
  const selectAllEl = document.getElementById('selectAll');
  if (selectAllEl) selectAllEl.checked = false;

  for (const s of paged) {
    const minExact = ((s.durationSec ? s.durationSec / 60 : s.durationMin) || 0);
    const minText = Number(minExact).toFixed(2) + ' min';
    const fechas = formatDateShort(s.startISO);
    const safeUrl = sanitizeUrl(s.url);
    const urlCell = safeUrl ? `<a href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener" title="${escapeHTML(safeUrl)}">🔗 Link</a>` : '—';
    const safeCat = escapeHTML(s.category || '');
    const catColor = getCategoryColor(s.category);
    const catBadge = s.category ? `<span class="cat-badge" data-cat="${safeCat}" style="--cat-color:${catColor}">${safeCat}</span>` : '—';
    const noteIcon = s.notes ? '📋' : '📝';
    const noteClass = s.notes ? 'btn-notes has-notes' : 'btn-notes';
    const safeId = Number(s.id) || 0;
    const safeType = escapeHTML(s.sessionType || '—');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="session-check" data-sid="${safeId}"></td>
      <td>${minText}</td>
      <td>${catBadge}</td>
      <td style="text-transform:capitalize">${safeType}</td>
      <td>${fechas}</td>
      <td>${urlCell}</td>
      <td><button class="${noteClass}" data-note-id="${safeId}" title="Notas">${noteIcon}</button></td>
      <td><button class="btn-notes" data-dup="${safeId}" title="Duplicar sesión">📋</button><button class="btn-trash" data-del="${safeId}" title="Borrar sesión">🗑</button></td>
    `;
    tbody.appendChild(tr);
  }

  renderPagination(searched.length);

  // Checkbox handlers
  tbody.querySelectorAll('.session-check').forEach(cb => {
    cb.onchange = () => {
      const sid = Number(cb.getAttribute('data-sid'));
      if (cb.checked) selectedSessionIds.add(sid); else selectedSessionIds.delete(sid);
      updateBulkBar();
    };
  });

  // Select All (selects visible page)
  if (selectAllEl) {
    selectAllEl.onchange = () => {
      const checked = selectAllEl.checked;
      tbody.querySelectorAll('.session-check').forEach(cb => {
        cb.checked = checked;
        const sid = Number(cb.getAttribute('data-sid'));
        if (checked) selectedSessionIds.add(sid); else selectedSessionIds.delete(sid);
      });
      updateBulkBar();
    };
  }

  // Notes handlers
  tbody.querySelectorAll('.btn-notes').forEach(btn => {
    btn.onclick = () => {
      const id = Number(btn.getAttribute('data-note-id'));
      const session = allSessions.find(s => Number(s.id) === id);
      openNotesModal(id, session ? session.notes || '' : '');
    };
  });

  // Delete handlers
  tbody.querySelectorAll('button[data-del]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-del');
      if (!confirm('¿Borrar esta sesión?')) return;
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      toast('Sesión eliminada', 'success');
      await refreshAll();
    };
  });

  // Duplicate handlers
  tbody.querySelectorAll('button[data-dup]').forEach(btn => {
    btn.onclick = async () => {
      const id = Number(btn.getAttribute('data-dup'));
      const original = allSessions.find(s => Number(s.id) === id);
      if (!original) return;
      const dup = {
        category: original.category, language: original.language,
        sessionType: original.sessionType, sessionName: original.sessionName,
        durationMin: original.durationMin, durationSec: original.durationSec,
        url: original.url, notes: original.notes,
        startISO: new Date().toISOString()
      };
      await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dup) });
      toast('Sesión duplicada', 'success');
      await refreshAll();
    };
  });
}

function openNotesModal(sessionId, currentNotes) {
  const modal = document.getElementById('notesModal');
  const textarea = document.getElementById('notesText');
  const saveBtn = document.getElementById('notesSave');
  const cancelBtn = document.getElementById('notesCancel');
  if (!modal || !textarea) return;

  textarea.value = currentNotes;
  modal.style.display = 'flex';
  textarea.focus();

  const close = () => { modal.style.display = 'none'; };

  cancelBtn.onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };

  saveBtn.onclick = async () => {
    await fetch(`/api/sessions/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: textarea.value })
    });
    close();
    toast('Notas guardadas', 'success');
    await refreshAll();
  };
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
  const timerEl = document.querySelector('.rc-timer');
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
  if (timerEl) timerEl.setAttribute('data-state', remoteState.state || 'idle');

  // Pomodoro status sync
  const pomStatus = document.getElementById('pomodoroStatus');
  const pomCheck = document.getElementById('pomodoroEnabled');
  const pomControls = document.getElementById('pomodoroControls');
  const pom = remoteState.pomodoro;
  if (pom && pom.enabled) {
    if (pomCheck && !pomCheck.checked) { pomCheck.checked = true; }
    if (pomControls) pomControls.style.display = 'flex';
    if (pomStatus) {
      const phaseLabel = pom.phase === 'break' ? 'DESCANSO' : 'TRABAJO';
      pomStatus.textContent = `${phaseLabel} — Round ${pom.round + (pom.phase === 'work' ? 1 : 0)}/${pom.totalRounds}`;
    }
  } else {
    if (pomStatus) pomStatus.textContent = '';
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
function setWsIndicator(online) {
  const el = document.getElementById('wsStatus');
  if (!el) return;
  el.classList.toggle('ws-on', online);
  el.classList.toggle('ws-off', !online);
  el.title = online ? 'Conectado al servidor' : 'Desconectado';
}

function connectBus() {
  try {
    const wsHost = window.location.hostname || '127.0.0.1';
    ws = new WebSocket(`ws://${wsHost}:8765`);
    ws.onopen = () => setWsIndicator(true);
    ws.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'session:complete') { await refreshAll(); updateUrlInput(''); }
        if (msg.type === 'state' && msg.payload) {
          updateRemoteState(msg.payload);
          updateUrlInput(msg.payload.sessionUrl || '');
        }
      } catch (e) { console.warn('[WS] parse error', e); }
    };
    ws.onclose = () => {
      ws = null;
      setWsIndicator(false);
      setTimeout(connectBus, 2000);
    };
  } catch (e) { console.warn('[WS] connect error', e); }
}
function sendCmd(action, payload) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'command', action, payload })); }
function populateCategorySelect(cfg) {
  const sel = document.getElementById('rcCategory'); if (!sel) return; sel.innerHTML = '';
  for (const c of collectAllCategories()) { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); }
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
  populateCategorySelect({});

  renderStats(stats);
  populateMonthFilter(allSessions);
  populateYearFilter(allSessions);
  populateCategoryFilter(allSessions);
  renderSessions(applySessionFilters());
}

function renderTemplateQuickstart(cfg) {
  const container = document.getElementById('templateQuickstart');
  if (!container) return;
  container.innerHTML = '';
  const templates = cfg.templates || [];
  for (const t of templates) {
    const btn = document.createElement('button');
    btn.className = 'btn-template';
    btn.textContent = `${t.name} (${t.durationMin}m)`;
    const color = getCategoryColor(t.category);
    btn.style.setProperty('--cat-color', color);
    btn.title = `${t.category} · ${t.sessionType} · ${t.durationMin} min`;
    btn.onclick = () => {
      sendCmd('setCategory', t.category);
      sendCmd('setDurationSec', t.durationMin * 60);
      sendCmd('setSessionType', t.sessionType);
      // Update local UI selects
      const rcCat = document.getElementById('rcCategory');
      if (rcCat) { rcCat.value = t.category; applyCategoryColor(rcCat); }
      const rcType = document.getElementById('rcSessionType');
      if (rcType) rcType.value = t.sessionType;
      const durInput = document.getElementById('cfgDuration');
      const durVal = document.getElementById('durationVal');
      if (durInput) { durInput.value = t.durationMin; }
      if (durVal) durVal.textContent = `${t.durationMin} min`;
      sendCmd('start');
      toast(`Template "${t.name}" iniciado`, 'success');
    };
    container.appendChild(btn);
  }
}

function renderTemplateList(cfg) {
  const list = document.getElementById('templateList');
  if (!list) return;
  list.innerHTML = '';
  const templates = cfg.templates || [];
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    const row = document.createElement('div');
    row.className = 'template-row';
    const color = getCategoryColor(t.category);
    row.innerHTML = `
      <span class="template-name" style="color:${color}">${escapeHTML(t.name)}</span>
      <span class="template-meta">${escapeHTML(t.category)} · ${Number(t.durationMin) || 0}m · ${escapeHTML(t.sessionType)}</span>
    `;
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-delete-cat';
    delBtn.innerHTML = '✕';
    delBtn.title = 'Eliminar template';
    delBtn.onclick = () => {
      cfg.templates = (cfg.templates || []).filter((_, idx) => idx !== i);
      renderTemplateList(cfg);
      renderTemplateQuickstart(cfg);
    };
    row.appendChild(delBtn);
    list.appendChild(row);
  }
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

  // Templates
  renderTemplateQuickstart(cfg);
  renderTemplateList(cfg);

  document.getElementById('addTemplate').onclick = () => {
    const nameInput = document.getElementById('newTemplateName');
    const name = nameInput.value.trim();
    if (!name) { toast('Escribe un nombre para el template', 'warning'); return; }
    const rcCat = document.getElementById('rcCategory');
    const rcType = document.getElementById('rcSessionType');
    const durInput = document.getElementById('cfgDuration');
    const tpl = {
      name,
      category: rcCat ? rcCat.value : '',
      durationMin: durInput ? parseInt(durInput.value, 10) || 90 : 90,
      sessionType: rcType ? rcType.value : 'privada'
    };
    if (!cfg.templates) cfg.templates = [];
    cfg.templates.push(tpl);
    nameInput.value = '';
    renderTemplateList(cfg);
    renderTemplateQuickstart(cfg);
    toast(`Template "${name}" añadido`, 'success');
  };

  // Include templates in save config
  const origSaveClick = document.getElementById('saveCfg').onclick;
  document.getElementById('saveCfg').onclick = async () => {
    // Inject templates into cfg before save
    const newCfg = {
      ...cfg,
      categories: [...(cfg.categories || [])],
      categoryColors: { ...categoryColors },
      templates: cfg.templates || [],
      defaultDurationMin: parseInt(document.getElementById('cfgDuration').value, 10) || 90,
      opacity: +document.getElementById('cfgOpacity').value
    };
    const saved = await saveConfig(newCfg);
    configCategories = [...(saved.categories || [])];
    categoryColors = { ...(saved.categoryColors || categoryColors) };
    cfg.templates = saved.templates || [];
    assignCategoryColors();
    toast('Configuración guardada', 'success');
    populateCategorySelect(saved);
    populateCategoryFilter(allSessions);
    renderTemplateQuickstart(saved);
    renderTemplateList(cfg);
  };

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
  // Pomodoro controls
  const pomodoroCheck = document.getElementById('pomodoroEnabled');
  const pomodoroControlsEl = document.getElementById('pomodoroControls');
  const pomodoroWorkInput = document.getElementById('pomodoroWork');
  const pomodoroBreakInput = document.getElementById('pomodoroBreak');
  const pomodoroRoundsInput = document.getElementById('pomodoroRounds');

  if (pomodoroCheck) {
    pomodoroCheck.onchange = () => {
      const on = pomodoroCheck.checked;
      if (pomodoroControlsEl) pomodoroControlsEl.style.display = on ? 'flex' : 'none';
      sendCmd('setPomodoroEnabled', on);
      if (on) {
        sendCmd('setPomodoroWork', Number(pomodoroWorkInput.value) || 25);
        sendCmd('setPomodoroBreak', Number(pomodoroBreakInput.value) || 5);
        sendCmd('setPomodoroRounds', Number(pomodoroRoundsInput.value) || 4);
      }
    };
  }
  if (pomodoroWorkInput) pomodoroWorkInput.onchange = () => sendCmd('setPomodoroWork', Number(pomodoroWorkInput.value) || 25);
  if (pomodoroBreakInput) pomodoroBreakInput.onchange = () => sendCmd('setPomodoroBreak', Number(pomodoroBreakInput.value) || 5);
  if (pomodoroRoundsInput) pomodoroRoundsInput.onchange = () => sendCmd('setPomodoroRounds', Number(pomodoroRoundsInput.value) || 4);

  // Calendar navigation
  const calPrevBtn = document.getElementById('calPrev');
  const calNextBtn = document.getElementById('calNext');
  if (calPrevBtn) {
    calPrevBtn.onclick = () => {
      calendarMonth--;
      if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
      renderCalendar(allSessions);
    };
  }
  if (calNextBtn) {
    calNextBtn.onclick = () => {
      calendarMonth++;
      if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
      renderCalendar(allSessions);
    };
  }

  renderRemoteTimer();
  await fetchRemoteState();
  const monthSel = document.getElementById('filterMonth');
  const typeSel = document.getElementById('filterType');
  const yearSel = document.getElementById('filterYear');
  const catSel = document.getElementById('filterCategory');
  const urlSel = document.getElementById('filterUrl');
  const clearFiltersBtn = document.getElementById('clearFilters');
  if (monthSel) { monthSel.onchange = () => { currentPage = 1; renderSessions(applySessionFilters()); }; }
  if (typeSel) { typeSel.onchange = () => { currentPage = 1; renderSessions(applySessionFilters()); }; }
  if (yearSel) { yearSel.onchange = () => { currentPage = 1; renderSessions(applySessionFilters()); }; }
  if (catSel) { catSel.onchange = () => { currentPage = 1; applyCategoryColor(catSel); renderSessions(applySessionFilters()); }; }
  if (urlSel) { urlSel.onchange = () => { currentPage = 1; renderSessions(applySessionFilters()); }; }
  // Search input
  const searchInput = document.getElementById('searchSessions');
  if (searchInput) {
    searchInput.oninput = debounce(() => {
      currentSearchQuery = searchInput.value.trim();
      currentPage = 1;
      renderSessions(applySessionFilters());
    }, 300);
  }

  if (clearFiltersBtn) {
    clearFiltersBtn.onclick = () => {
      if (monthSel) monthSel.value = 'all';
      if (typeSel) typeSel.value = 'all';
      if (yearSel) yearSel.value = 'all';
      if (catSel) { catSel.value = 'all'; applyCategoryColor(catSel); }
      if (urlSel) urlSel.value = 'all';
      if (searchInput) { searchInput.value = ''; currentSearchQuery = ''; }
      currentPage = 1;
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

  // Backup
  document.getElementById('backupBtn').onclick = async () => {
    const resp = await fetch('/api/backup');
    const data = await resp.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `90minutos_backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Backup descargado', 'success');
  };

  // Restore
  document.getElementById('restoreBtn').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Esto reemplazara TODA la config y sesiones actuales. Continuar?')) { e.target.value = ''; return; }
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const resp = await fetch('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const result = await resp.json();
      if (resp.ok) { toast(`Restore OK: ${result.sessions} sesiones`, 'success'); location.reload(); }
      else { toast('Error: ' + (result.error || 'desconocido'), 'error'); }
    } catch (err) { toast('Error al leer backup: ' + err.message, 'error'); }
    e.target.value = '';
  };

  // Clear all sessions
  document.getElementById('clearAll').onclick = async () => {
    if (!allSessions.length) { toast('No hay sesiones', 'warning'); return; }
    if (!confirm(`¿Borrar TODAS las ${allSessions.length} sesiones? Esta acción no se puede deshacer.`)) return;
    await fetch('/api/sessions', { method: 'DELETE', headers: { 'X-Confirm-Delete': 'true' } });
    toast('Todas las sesiones eliminadas', 'success');
    await refreshAll();
  };

  // Import from Sheets
  document.getElementById('importSheets').onclick = async () => {
    const id = await getSheetId();
    if (!id) { toast('Configura SHEET_ID en .env y conecta Google', 'warning'); return; }
    const resp = await fetch('/api/sessions/importFromSheets', { method: 'POST' });
    const data = await resp.json();
    if (resp.ok) { toast(`Importadas ${data.imported} sesiones desde Sheets`, 'success'); await refreshAll(); }
    else { toast('Error: ' + (data.error || 'desconocido'), 'error'); }
  };

  // Export CSV
  document.getElementById('exportCSV').onclick = () => {
    if (!allSessions.length) { toast('No hay sesiones para exportar', 'warning'); return; }
    const hdr = 'Categoria,DuracionMin,Lenguaje,Fecha,Sesion,Tipo,URL\n';
    const rows = allSessions.map(s => {
      const min = s.durationSec ? (s.durationSec / 60).toFixed(2) : (s.durationMin || 0);
      const fecha = formatDateShort(s.startISO);
      const esc = v => `"${String(v || '').replace(/"/g, '""')}"`;
      return [esc(s.category), min, esc(s.language), fecha, esc(s.sessionName), esc(s.sessionType), esc(s.url)].join(',');
    });
    const csv = hdr + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `90minutos_sessions_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('CSV exportado', 'success');
  };

  // Bulk operations
  document.getElementById('bulkDelete').onclick = async () => {
    if (!selectedSessionIds.size) return;
    if (!confirm(`¿Borrar ${selectedSessionIds.size} sesión(es)?`)) return;
    await fetch('/api/sessions/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(selectedSessionIds) })
    });
    toast(`${selectedSessionIds.size} sesión(es) eliminadas`, 'success');
    await refreshAll();
  };

  document.getElementById('bulkExport').onclick = () => {
    if (!selectedSessionIds.size) return;
    const selected = allSessions.filter(s => selectedSessionIds.has(Number(s.id)));
    if (!selected.length) { toast('No hay sesiones seleccionadas', 'warning'); return; }
    const hdr = 'Categoria,DuracionMin,Lenguaje,Fecha,Sesion,Tipo,URL\n';
    const rows = selected.map(s => {
      const min = s.durationSec ? (s.durationSec / 60).toFixed(2) : (s.durationMin || 0);
      const fecha = formatDateShort(s.startISO);
      const esc = v => `"${String(v || '').replace(/"/g, '""')}"`;
      return [esc(s.category), min, esc(s.language), fecha, esc(s.sessionName), esc(s.sessionType), esc(s.url)].join(',');
    });
    const csv = hdr + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `90minutos_selected_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`${selected.length} sesión(es) exportadas`, 'success');
  };

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (e.key === ' ') {
      e.preventDefault();
      if (remoteState.state === 'idle') sendCmd('start');
      else if (remoteState.state === 'running') sendCmd('pause');
      else if (remoteState.state === 'paused') sendCmd('resume');
    }
    if (e.key === 'r' || e.key === 'R') {
      if (!e.ctrlKey && !e.metaKey) sendCmd('reset');
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      document.getElementById('saveCfg').click();
    }
    if (e.key === '?') {
      const help = document.getElementById('shortcutHelp');
      if (help) help.style.display = help.style.display === 'none' ? 'block' : 'none';
    }
  });

  const refreshTimer = setInterval(refreshAll, 20000);
  window.addEventListener('beforeunload', () => clearInterval(refreshTimer));
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
