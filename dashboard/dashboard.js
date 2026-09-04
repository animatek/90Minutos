// Panel de control. Habla con la API por fetch y recibe el estado del timer por
// WebSocket, así que lo que se ve es siempre lo que el servidor tiene guardado.
'use strict';

// ── Utilidades ──────────────────────────────────────────────────────────────

function esc(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str ?? '')));
  return div.innerHTML;
}

function safeUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  try {
    const parsed = new URL(s);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return s;
  } catch { /* no es una URL usable */ }
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
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function clock(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function human(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Clave de día en hora local: agrupar por UTC desplaza las sesiones nocturnas. */
function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // lunes
  return d;
}

function decimalHours(sec) {
  return `${(Math.max(0, Number(sec) || 0) / 3600).toLocaleString('es-ES', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })} h`;
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function topicColorVar(slot, color) {
  return (slot && slot >= 1 && slot <= 8) ? `var(--series-${slot})` : (color || 'var(--series-other)');
}

// ── API ─────────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : (options.headers || {}),
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

const post = (path, body) => api(path, { method: 'POST', body });
const patch = (path, body) => api(path, { method: 'PATCH', body });

// ── Estado local ────────────────────────────────────────────────────────────

let settings = {};
let topics = [];
let sessions = [];
let stats = { byTopic: [], daily: [] };
let remote = { state: 'idle', mode: 'open', elapsedSec: 0, remainingSec: null, todaySec: 0 };
let preferredMode = 'open';        // modo con el que arrancarán los temas
let statsRange = 'all';
let ws = null;
let runtimeWsPort = 8765;
let activeView = 'control';

let currentPage = 1;
const PAGE_SIZE = 20;
let searchQuery = '';
let selectedIds = new Set();
let calendarMonth = new Date().getMonth();
let calendarYear = new Date().getFullYear();
let mergeSourceId = null;

const $ = (id) => document.getElementById(id);

// ── Reloj y estado de la sesión ─────────────────────────────────────────────

function renderTimer() {
  const box = $('rcTimer');
  const isSprint = remote.mode === 'sprint' && remote.plannedSec != null;
  const overtime = isSprint && remote.overtimeSec > 0;

  box.dataset.state = overtime ? 'overtime' : remote.state;

  // En sprint interesa lo que queda; en abierto, lo acumulado.
  const main = isSprint
    ? (overtime ? `+${clock(remote.overtimeSec)}` : clock(remote.remainingSec))
    : clock(remote.elapsedSec);
  $('rcTimerValue').textContent = main;

  $('rcTimerMode').textContent = isSprint
    ? (overtime ? 'Prórroga' : `Sprint ${Math.round(remote.plannedSec / 60)}′`)
    : 'Abierto';

  const stateText = { running: 'En curso', paused: 'En pausa', idle: 'En espera' }[remote.state] || '—';
  const parts = [stateText];
  if (remote.topic) parts.push(remote.topic);
  if (remote.state !== 'idle') parts.push(`trabajado ${human(remote.elapsedSec)}`);
  if (remote.startedAtISO) parts.push(`desde ${new Date(remote.startedAtISO).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`);
  $('rcTimerState').textContent = parts.join(' · ');

  const track = $('rcProgressTrack');
  track.hidden = !isSprint;
  if (isSprint) {
    const pct = Math.min(100, (remote.elapsedSec / Math.max(1, remote.plannedSec)) * 100);
    $('rcTimerProgress').style.width = `${pct}%`;
  }

  $('rcToday').textContent = human(remote.todaySec);

  // Botones acordes al estado: nada de pulsar lo que no aplica.
  const active = remote.state !== 'idle';
  $('rcActions').hidden = !active;
  $('rcPause').hidden = remote.state !== 'running';
  $('rcResume').hidden = remote.state !== 'paused';
  $('rcStop').hidden = !active;
  $('rcDiscard').hidden = !active;
  $('rcExtend').hidden = !active || remote.mode !== 'sprint';

  // El selector de modo refleja la sesión en curso; sin sesión, la preferencia.
  const shown = active ? remote.mode : preferredMode;
  $('modeOpen').setAttribute('aria-pressed', String(shown === 'open'));
  $('modeSprint').setAttribute('aria-pressed', String(shown === 'sprint'));
  $('modeSprintMin').textContent = Math.round((settings.defaultDurationMin || 90));

  // Los metadatos no se sobreescriben mientras se escribe en ellos.
  for (const [id, value] of [['rcUrl', remote.url], ['rcNotes', remote.notes]]) {
    const input = $(id);
    if (input && document.activeElement !== input) input.value = value || '';
  }
  $('quickTopicMode').textContent = shown === 'sprint' ? `sprint de ${settings.defaultDurationMin || 90} min` : 'abierto';

  renderTopicGrid();
}

// ── Lanzador de temas ───────────────────────────────────────────────────────

function renderTopicGrid() {
  const grid = $('topicGrid');
  const query = ($('topicSearch').value || '').trim().toLowerCase();
  const hours = new Map(stats.byTopic.map(t => [t.topic, t.totalSec]));

  const visible = topics
    .filter(t => !t.archived)
    .filter(t => !query || t.name.toLowerCase().includes(query))
    .sort((a, b) => (hours.get(b.name) || 0) - (hours.get(a.name) || 0) || a.name.localeCompare(b.name, 'es'));

  grid.replaceChildren();
  if (!visible.length) {
    const p = document.createElement('p');
    p.className = 'topic-empty';
    p.textContent = topics.length ? 'Ningún tema coincide con la búsqueda.' : 'Crea tu primer tema más abajo.';
    grid.appendChild(p);
    return;
  }

  for (const t of visible) {
    const btn = document.createElement('button');
    btn.className = 'topic-btn' + (remote.topicId === t.id && remote.state !== 'idle' ? ' is-active' : '');
    btn.style.setProperty('--topic-color', topicColorVar(t.paletteSlot, t.color));
    btn.title = `Empezar a contar en ${t.name}`;

    const dot = document.createElement('span');
    dot.className = 'topic-dot';
    const name = document.createElement('span');
    name.className = 'topic-name';
    name.textContent = t.name;
    const hrs = document.createElement('span');
    hrs.className = 'topic-hours';
    hrs.textContent = hours.has(t.name) ? human(hours.get(t.name)) : '';

    btn.append(dot, name, hrs);
    btn.onclick = () => startTopic(t);
    grid.appendChild(btn);
  }
}

async function startTopic(topic) {
  try {
    const body = { topicId: topic.id, mode: preferredMode };
    if (preferredMode === 'sprint') body.plannedMin = settings.defaultDurationMin || 90;
    const result = await post('/api/timer/start', body);
    if (result.previous) {
      toast(`${result.previous.topic} guardado (${human(result.previous.durationSec)}) → ${topic.name}`, 'success');
    } else {
      toast(`Contando en ${topic.name}`, 'success');
    }
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Indicadores ─────────────────────────────────────────────────────────────

function renderKPIs() {
  const closed = sessions.filter(s => !s.active);
  const totalSec = closed.reduce((a, s) => a + s.durationSec, 0);

  const now = new Date();
  const weekStart = startOfWeek(now);
  const previousWeekStart = new Date(weekStart);
  previousWeekStart.setDate(previousWeekStart.getDate() - 7);

  let weekSec = 0, weekCount = 0, prevSec = 0, prevCount = 0;
  for (const s of closed) {
    const d = new Date(s.startISO);
    if (d >= weekStart && d <= now) { weekSec += s.durationSec; weekCount++; }
    else if (d >= previousWeekStart && d < weekStart) { prevSec += s.durationSec; prevCount++; }
  }

  $('kpiTotalHours').textContent = (totalSec / 3600).toFixed(1);
  $('kpiWeekHours').textContent = (weekSec / 3600).toFixed(1);
  $('kpiSessions').textContent = closed.length;
  $('kpiAvgDuration').textContent = closed.length ? Math.round(totalSec / closed.length / 60) : 0;

  const delta = (curr, prev) => {
    if (!prev && !curr) return { text: '=', cls: 'flat' };
    if (!prev) return { text: '+100%', cls: 'up' };
    const pct = Math.round(((curr - prev) / prev) * 100);
    if (pct > 0) return { text: `+${pct}%`, cls: 'up' };
    if (pct < 0) return { text: `${pct}%`, cls: 'down' };
    return { text: '=', cls: 'flat' };
  };

  $('wcHoursThis').textContent = `${(weekSec / 3600).toFixed(1)}h`;
  const dh = delta(weekSec, prevSec);
  $('wcHoursDelta').textContent = dh.text;
  $('wcHoursDelta').className = `week-compare-delta ${dh.cls}`;

  $('wcSessionsThis').textContent = weekCount;
  const ds = delta(weekCount, prevCount);
  $('wcSessionsDelta').textContent = ds.text;
  $('wcSessionsDelta').className = `week-compare-delta ${ds.cls}`;

  renderGoalProgress(closed, now, weekStart);
}

function renderGoalProgress(closed, now, weekStart) {
  const goalWeekHours = Math.min(168, Math.max(1, Number(settings.weeklyGoalHours) || 15));
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);

  const sumFrom = (from) => closed.reduce((total, session) => {
    const date = new Date(session.startISO);
    return date >= from && date <= now ? total + session.durationSec : total;
  }, 0);

  const periods = [
    { key: 'Week', current: sumFrom(weekStart), targetHours: goalWeekHours },
    { key: 'Month', current: sumFrom(monthStart), targetHours: goalWeekHours * 4 },
    { key: 'Year', current: sumFrom(yearStart), targetHours: goalWeekHours * 52 },
  ];

  $('goalWeeklyBadge').textContent = `${goalWeekHours} h`;
  for (const period of periods) {
    const targetSec = period.targetHours * 3600;
    const percent = Math.min(100, (period.current / targetSec) * 100);
    $(`goal${period.key}Current`).textContent = decimalHours(period.current);
    $(`goal${period.key}Target`).textContent = `${period.targetHours} h`;
    $(`goal${period.key}Bar`).style.width = `${percent}%`;
    $(`goal${period.key}Row`).classList.toggle('is-complete', period.current >= targetSec);
  }
}

// ── Gráficas ────────────────────────────────────────────────────────────────

function renderCharts() {
  window.Charts.renderTopicBars($('chartTopics'), stats.byTopic);

  // Tabla equivalente: cumple el requisito de que el dato se pueda leer escrito.
  const tbody = document.querySelector('#topicsTable tbody');
  tbody.replaceChildren();
  for (const t of stats.byTopic) {
    const tr = document.createElement('tr');
    for (const value of [t.topic, `${t.totalHours.toFixed(2)} h`, t.sessions]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  // Últimos 14 días, incluidos los vacíos.
  const byDay = new Map(stats.daily.map(d => [d.day, d]));
  const days = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const entry = byDay.get(key);
    days.push({
      sec: entry ? entry.totalSec : 0,
      sessions: entry ? entry.sessions : 0,
      isToday: i === 0,
      labelShort: d.toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric' }),
      labelLong: d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }),
    });
  }
  window.Charts.renderDayBars($('chartDays'), days);
}

// ── Mapa de actividad ───────────────────────────────────────────────────────

function renderHeatmap() {
  const grid = $('heatmapGrid');
  grid.replaceChildren();

  const daily = new Map();
  for (const s of sessions) {
    if (s.active) continue;
    const key = dayKey(s.startISO);
    if (key) daily.set(key, (daily.get(key) || 0) + s.durationSec);
  }

  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 26 * 7 - today.getDay());
  const max = Math.max(...daily.values(), 1);

  const level = (sec) => {
    if (!sec) return 0;
    const ratio = sec / max;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  };

  const cursor = new Date(start);
  while (cursor <= today) {
    const week = document.createElement('div');
    week.className = 'heatmap-week';
    for (let d = 0; d < 7; d++) {
      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';
      if (cursor <= today) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
        const sec = daily.get(key) || 0;
        const lvl = level(sec);
        if (lvl) cell.setAttribute('data-level', lvl);
        cell.title = `${cursor.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })}: ${sec ? human(sec) : 'sin actividad'}`;
      } else {
        cell.style.visibility = 'hidden';
      }
      week.appendChild(cell);
      cursor.setDate(cursor.getDate() + 1);
    }
    grid.appendChild(week);
  }
}

// ── Calendario ──────────────────────────────────────────────────────────────

function renderCalendar() {
  const grid = $('calendarGrid');
  $('calTitle').textContent = new Date(calendarYear, calendarMonth, 1)
    .toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

  const daily = new Map();
  for (const s of sessions) {
    if (s.active) continue;
    const key = dayKey(s.startISO);
    if (!key) continue;
    if (!daily.has(key)) daily.set(key, { sec: 0, topics: new Map() });
    const entry = daily.get(key);
    entry.sec += s.durationSec;
    entry.topics.set(s.topic, topicColorVar(s.topicSlot, s.topicColor));
  }

  grid.replaceChildren();
  for (const label of ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']) {
    const h = document.createElement('div');
    h.className = 'calendar-day-header';
    h.textContent = label;
    grid.appendChild(h);
  }

  const firstDow = (new Date(calendarYear, calendarMonth, 1).getDay() + 6) % 7;   // lunes = 0
  const lastDate = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const todayKey = dayKey(new Date().toISOString());

  for (let i = 0; i < firstDow; i++) {
    const empty = document.createElement('div');
    empty.className = 'calendar-day empty';
    grid.appendChild(empty);
  }

  for (let d = 1; d <= lastDate; d++) {
    const key = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const entry = daily.get(key);
    const cell = document.createElement('div');
    cell.className = 'calendar-day' + (key === todayKey ? ' today' : '');

    const num = document.createElement('span');
    num.className = 'calendar-day-num';
    num.textContent = d;
    cell.appendChild(num);

    if (entry) {
      const hrs = document.createElement('span');
      hrs.className = 'calendar-day-hours';
      hrs.textContent = human(entry.sec);
      cell.appendChild(hrs);

      const dots = document.createElement('div');
      dots.className = 'calendar-day-dots';
      for (const [name, color] of entry.topics) {
        const dot = document.createElement('div');
        dot.className = 'calendar-cat-dot';
        dot.style.background = color;
        dot.title = name;
        dots.appendChild(dot);
      }
      cell.appendChild(dots);
      cell.title = `${key} — ${human(entry.sec)}: ${[...entry.topics.keys()].join(', ')}`;
    } else {
      cell.title = key;
    }
    grid.appendChild(cell);
  }
}

// ── Historial ───────────────────────────────────────────────────────────────

function filteredSessions() {
  const topicVal = $('filterTopic').value;
  const yearVal = $('filterYear').value;
  const monthVal = $('filterMonth').value;
  const q = searchQuery.toLowerCase();

  return sessions.filter(s => {
    if (s.active) return false;
    if (topicVal !== 'all' && String(s.topicId) !== topicVal) return false;
    const d = new Date(s.startISO);
    if (yearVal !== 'all' && String(d.getFullYear()) !== yearVal) return false;
    if (monthVal !== 'all' && String(d.getMonth() + 1) !== monthVal) return false;
    if (q) {
      const haystack = `${s.topic} ${s.notes} ${s.url}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function renderSessions() {
  const rows = filteredSessions();
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  const page = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const tbody = document.querySelector('#sessions tbody');
  tbody.replaceChildren();
  $('selectAll').checked = false;
  selectedIds.clear();
  updateBulkBar();

  for (const s of page) {
    const tr = document.createElement('tr');
    const url = safeUrl(s.url);
    tr.innerHTML = `
      <td><input type="checkbox" class="session-check" data-sid="${s.id}"></td>
      <td><span class="cat-badge" style="--cat-color:${esc(topicColorVar(s.topicSlot, s.topicColor))}">${esc(s.topic)}</span></td>
      <td>${esc(human(s.durationSec))}</td>
      <td>${esc(fmtDateTime(s.startISO))}</td>
      <td>${s.mode === 'sprint' ? 'Sprint' : 'Abierto'}</td>
      <td class="session-url-cell">${url
        ? `<a href="${esc(url)}" target="_blank" rel="noopener">Abrir ↗</a><button class="btn-inline-edit" data-edit-url="${s.id}" title="Cambiar URL">✎</button>`
        : `<button class="btn-inline-add" data-edit-url="${s.id}">＋ Añadir URL</button>`}</td>
      <td><span class="session-note-preview" title="${esc(s.notes || '')}">${esc(s.notes || '—')}</span></td>
      <td class="session-row-actions">
        <button class="btn-edit" data-edit="${s.id}" title="Editar sesión">✎</button>
        <button class="btn-trash" data-del="${s.id}" title="Borrar">🗑</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.session-check').forEach(cb => {
    cb.onchange = () => {
      const id = Number(cb.dataset.sid);
      if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
      updateBulkBar();
    };
  });
  tbody.querySelectorAll('[data-edit]').forEach(btn => {
    btn.onclick = () => openSessionEditor(Number(btn.dataset.edit));
  });
  tbody.querySelectorAll('[data-edit-url]').forEach(btn => {
    btn.onclick = () => openSessionEditor(Number(btn.dataset.editUrl), { focusUrl: true });
  });
  tbody.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('¿Borrar esta sesión?')) return;
      try {
        await api(`/api/sessions/${btn.dataset.del}`, { method: 'DELETE' });
        toast('Sesión borrada', 'success');
        await refreshData();
      } catch (e) { toast(e.message, 'error'); }
    };
  });

  renderPagination(rows.length, totalPages);
}

function renderPagination(total, totalPages) {
  const box = $('pagination');
  box.replaceChildren();
  if (totalPages <= 1) {
    if (total) {
      const info = document.createElement('span');
      info.className = 'pagination-info';
      info.textContent = `${total} sesion${total === 1 ? '' : 'es'}`;
      box.appendChild(info);
    }
    return;
  }

  const button = (label, page, disabled, active) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.disabled = !!disabled;
    if (active) b.classList.add('active');
    b.onclick = () => { currentPage = page; renderSessions(); };
    return b;
  };

  box.appendChild(button('‹', currentPage - 1, currentPage <= 1));
  const maxVisible = 7;
  let start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  const end = Math.min(totalPages, start + maxVisible - 1);
  start = Math.max(1, end - maxVisible + 1);
  for (let i = start; i <= end; i++) box.appendChild(button(String(i), i, false, i === currentPage));
  box.appendChild(button('›', currentPage + 1, currentPage >= totalPages));

  const info = document.createElement('span');
  info.className = 'pagination-info';
  info.textContent = `${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, total)} de ${total}`;
  box.appendChild(info);
}

function updateBulkBar() {
  const bar = $('bulkBar');
  bar.style.display = selectedIds.size ? 'flex' : 'none';
  $('bulkCount').textContent = `${selectedIds.size} seleccionada${selectedIds.size === 1 ? '' : 's'}`;
}

function localDateTimeValue(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function openSessionEditor(sessionId, { focusUrl = false } = {}) {
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return;

  const modal = $('sessionEditModal');
  const topic = $('editSessionTopic');
  topic.replaceChildren();
  for (const t of [...topics].sort((a, b) => a.name.localeCompare(b.name, 'es'))) {
    topic.appendChild(new Option(t.archived ? `${t.name} (archivado)` : t.name, String(t.id)));
  }
  topic.value = String(session.topicId);
  $('editSessionStart').value = localDateTimeValue(session.startISO);
  $('editSessionDuration').value = String(+(session.durationSec / 60).toFixed(2));
  $('editSessionUrl').value = session.url || '';
  $('editSessionNotes').value = session.notes || '';
  modal.style.display = 'flex';

  const close = () => { modal.style.display = 'none'; };
  $('sessionEditCancel').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  $('sessionEditSave').onclick = async () => {
    const startValue = $('editSessionStart').value;
    const durationMin = Number($('editSessionDuration').value);
    const url = $('editSessionUrl').value.trim();
    if (!startValue || !Number.isFinite(durationMin) || durationMin < 0) {
      toast('Revisa la fecha y la duración', 'warning');
      return;
    }
    if (url && !safeUrl(url)) {
      toast('La URL debe empezar por http:// o https://', 'warning');
      $('editSessionUrl').focus();
      return;
    }
    try {
      await patch(`/api/sessions/${sessionId}`, {
        topicId: Number(topic.value),
        startISO: new Date(startValue).toISOString(),
        durationSec: Math.round(durationMin * 60),
        url,
        notes: $('editSessionNotes').value,
      });
      close();
      toast('Sesión actualizada', 'success');
      await refreshData();
    } catch (e) { toast(e.message, 'error'); }
  };

  requestAnimationFrame(() => (focusUrl ? $('editSessionUrl') : topic).focus());
}

// ── Filtros ─────────────────────────────────────────────────────────────────

function populateFilters() {
  const topicSel = $('filterTopic');
  const prevTopic = topicSel.value;
  topicSel.replaceChildren();
  topicSel.appendChild(new Option('Todos', 'all'));
  for (const t of [...topics].sort((a, b) => a.name.localeCompare(b.name, 'es'))) {
    topicSel.appendChild(new Option(t.name, String(t.id)));
  }
  topicSel.value = prevTopic || 'all';

  const years = [...new Set(sessions.filter(s => !s.active).map(s => new Date(s.startISO).getFullYear()))].sort((a, b) => b - a);
  const yearSel = $('filterYear');
  const prevYear = yearSel.value;
  yearSel.replaceChildren();
  yearSel.appendChild(new Option('Todos', 'all'));
  for (const y of years) yearSel.appendChild(new Option(String(y), String(y)));
  yearSel.value = prevYear || 'all';

  const monthSel = $('filterMonth');
  if (!monthSel.options.length) {
    monthSel.appendChild(new Option('Todos', 'all'));
    const names = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    names.forEach((n, i) => monthSel.appendChild(new Option(n, String(i + 1))));
  }

}

// ── Gestión de temas ────────────────────────────────────────────────────────

function renderTopicList() {
  const list = $('topicList');
  const showArchived = $('showArchived').checked;
  list.replaceChildren();

  const visible = topics
    .filter(t => showArchived || !t.archived)
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));

  $('topicsHint').textContent = `${topics.filter(t => !t.archived).length} activos · ${topics.filter(t => t.archived).length} archivados`;

  for (const t of visible) {
    const row = document.createElement('div');
    row.className = 'topic-row' + (t.archived ? ' is-archived' : '');

    const color = document.createElement('input');
    color.type = 'color';
    color.value = /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : '#7aa2f7';
    color.title = t.paletteSlot ? `Slot ${t.paletteSlot} de la paleta validada` : 'Color propio';
    color.onchange = () => save(t.id, { color: color.value });

    const name = document.createElement('input');
    name.className = 'topic-name-input';
    name.value = t.name;
    name.onchange = () => {
      const value = name.value.trim();
      if (!value || value === t.name) { name.value = t.name; return; }
      save(t.id, { name: value });
    };

    const count = document.createElement('span');
    count.className = 'topic-count';
    count.textContent = `${t.sessionCount} ses.`;

    const archive = document.createElement('button');
    archive.className = 'btn-icon';
    archive.textContent = t.archived ? '📤' : '📥';
    archive.title = t.archived ? 'Desarchivar' : 'Archivar (se oculta pero conserva el historial)';
    archive.onclick = () => save(t.id, { archived: !t.archived });

    const merge = document.createElement('button');
    merge.className = 'btn-icon';
    merge.textContent = '⇄';
    merge.title = 'Fusionar con otro tema';
    merge.onclick = () => openMerge(t);

    const del = document.createElement('button');
    del.className = 'btn-trash';
    del.textContent = '🗑';
    del.title = t.sessionCount ? 'Tiene sesiones: archívalo o fusiónalo' : 'Borrar tema';
    del.onclick = async () => {
      if (!confirm(`¿Borrar el tema "${t.name}"?`)) return;
      try {
        await api(`/api/topics/${t.id}`, { method: 'DELETE' });
        toast('Tema borrado', 'success');
        await refreshData();
      } catch (e) { toast(e.message, 'error'); }
    };

    row.append(color, name, count, archive, merge, del);
    list.appendChild(row);
  }

  async function save(id, body) {
    try {
      await patch(`/api/topics/${id}`, body);
      await refreshData();
    } catch (e) { toast(e.message, 'error'); await refreshData(); }
  }
}

function openMerge(topic) {
  mergeSourceId = topic.id;
  const modal = $('mergeModal');
  $('mergeText').textContent = `Las ${topic.sessionCount} sesiones de "${topic.name}" pasarán al tema que elijas, y "${topic.name}" desaparecerá. No se puede deshacer.`;
  const select = $('mergeTarget');
  select.replaceChildren();
  for (const t of topics.filter(t => t.id !== topic.id).sort((a, b) => a.name.localeCompare(b.name, 'es'))) {
    select.appendChild(new Option(t.name, String(t.id)));
  }
  modal.style.display = 'flex';

  const close = () => { modal.style.display = 'none'; mergeSourceId = null; };
  $('mergeCancel').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  $('mergeConfirm').onclick = async () => {
    try {
      const result = await post(`/api/topics/${mergeSourceId}/merge`, { targetId: Number(select.value) });
      close();
      toast(`${result.moved} sesiones movidas a ${result.target.name}`, 'success');
      await refreshData();
    } catch (e) { toast(e.message, 'error'); }
  };
}

// ── Ajustes ─────────────────────────────────────────────────────────────────

function renderSettings() {
  $('cfgDuration').value = settings.defaultDurationMin || 90;
  $('durationVal').textContent = `${settings.defaultDurationMin || 90} min`;
  $('cfgDefaultMode').value = settings.defaultMode || 'open';
  $('cfgAutoStop').value = String(settings.autoStopOnSprintEnd !== false);
  $('cfgWeeklyGoal').value = Math.min(168, Math.max(1, Number(settings.weeklyGoalHours) || 15));
}

// ── WebSocket ───────────────────────────────────────────────────────────────

function setWsIndicator(online) {
  const el = $('wsStatus');
  el.classList.toggle('ws-on', online);
  el.classList.toggle('ws-off', !online);
  el.title = online ? 'Conectado al servidor' : 'Desconectado';
}

function connectWS() {
  try {
    // Host, protocolo y puerto salen de la instancia HTTP que sirve el panel.
    // Así una instancia de pruebas no escucha por accidente a otra app en 8765.
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${scheme}://${location.hostname}:${runtimeWsPort}`);
    ws.onopen = () => setWsIndicator(true);
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') { remote = msg.payload; renderTimer(); }
      else if (msg.type === 'session:complete') { toast(`Sesión guardada: ${msg.payload.topic} · ${human(msg.payload.durationSec)}`, 'success'); await refreshData(); }
      else if (msg.type === 'alarm') { toast('Objetivo del sprint alcanzado — sigues en prórroga', 'warning', 8000); }
      else if (msg.type === 'topics:update') { await refreshData(); }
      else if (msg.type === 'settings:update') { settings = msg.payload; renderSettings(); renderTimer(); }
    };
    ws.onclose = () => { ws = null; setWsIndicator(false); setTimeout(connectWS, 2000); };
    ws.onerror = () => { };
  } catch { setTimeout(connectWS, 2000); }
}

// ── Carga de datos ──────────────────────────────────────────────────────────

function rangeParams() {
  if (statsRange === 'all') return '';
  const days = Number(statsRange);
  const from = new Date(Date.now() - days * 86400000).toISOString();
  return `?from=${encodeURIComponent(from)}`;
}

async function refreshData() {
  const [t, s, st, health] = await Promise.all([
    api('/api/topics?all=true'),
    api('/api/sessions'),
    api(`/api/stats${rangeParams()}`),
    api('/api/health').catch(() => null),
  ]);
  topics = t;
  sessions = s;
  stats = st;

  populateFilters();
  renderKPIs();
  renderCharts();
  renderHeatmap();
  renderCalendar();
  renderSessions();
  renderTopicList();
  renderTopicGrid();
  if (health) {
    runtimeWsPort = Number(health.wsPort) || runtimeWsPort;
    $('dbPathNote').textContent = `Base de datos: ${health.db} · ${health.sessions} sesiones`;
  }
}

// ── Arranque ────────────────────────────────────────────────────────────────

function initTheme() {
  const btn = $('themeToggle');
  // El head ya decidió el tema antes de la primera pintura. Aquí solo conectamos
  // el botón y mantenemos el mismo atributo raíz al cambiarlo.
  const light = document.documentElement.dataset.theme === 'light';
  btn.textContent = light ? '☀️' : '🌙';
  btn.onclick = () => {
    const nowLight = document.documentElement.dataset.theme !== 'light';
    document.documentElement.dataset.theme = nowLight ? 'light' : 'dark';
    localStorage.setItem('animatek-theme', nowLight ? 'light' : 'dark');
    btn.textContent = nowLight ? '☀️' : '🌙';
    renderCharts();       // los colores de serie cambian por modo
  };
}

function showView(view, { remember = true } = {}) {
  activeView = view === 'stats' ? 'stats' : 'control';
  document.querySelectorAll('[data-view]').forEach(section => {
    section.hidden = section.dataset.view !== activeView;
  });
  document.querySelectorAll('[data-view-target]').forEach(button => {
    button.setAttribute('aria-selected', String(button.dataset.viewTarget === activeView));
  });
  if (remember) localStorage.setItem('90minutos-view', activeView);
  if (activeView === 'stats') requestAnimationFrame(renderCharts);
}

function initViews() {
  const requested = new URLSearchParams(location.search).get('view');
  const initial = requested || localStorage.getItem('90minutos-view') || 'control';
  showView(initial, { remember: false });
  document.querySelectorAll('[data-view-target]').forEach(button => {
    button.onclick = () => showView(button.dataset.viewTarget);
  });
}

function wireControls() {
  $('rcPause').onclick = () => post('/api/timer/pause').catch(e => toast(e.message, 'error'));
  $('rcResume').onclick = () => post('/api/timer/resume').catch(e => toast(e.message, 'error'));
  $('rcExtend').onclick = () => post('/api/timer/extend', { min: 10 }).catch(e => toast(e.message, 'error'));
  $('rcStop').onclick = async () => {
    try { await post('/api/timer/stop'); await refreshData(); }
    catch (e) { toast(e.message, 'error'); }
  };
  $('rcDiscard').onclick = async () => {
    if (!confirm('¿Descartar la sesión en curso? No se guardará en el historial.')) return;
    try { await post('/api/timer/discard'); toast('Sesión descartada', 'warning'); await refreshData(); }
    catch (e) { toast(e.message, 'error'); }
  };

  const setMode = async (mode) => {
    preferredMode = mode;
    if (remote.state !== 'idle') {
      try {
        const body = { mode };
        if (mode === 'sprint') body.plannedMin = settings.defaultDurationMin || 90;
        await post('/api/timer/mode', body);
      } catch (e) { toast(e.message, 'error'); }
    }
    renderTimer();
  };
  $('modeOpen').onclick = () => setMode('open');
  $('modeSprint').onclick = () => setMode('sprint');

  $('topicSearch').oninput = debounce(renderTopicGrid, 120);

  // Metadatos de la sesión en curso, sin machacar mientras se escribe.
  const pushMeta = debounce(async (body) => {
    if (remote.state === 'idle') return;
    try { await post('/api/timer/meta', body); } catch (e) { toast(e.message, 'error'); }
  }, 600);
  $('rcUrl').oninput = () => pushMeta({ url: $('rcUrl').value.trim() });
  $('rcNotes').oninput = () => pushMeta({ notes: $('rcNotes').value });

  $('quickTopicForm').onsubmit = async (e) => {
    e.preventDefault();
    const input = $('quickTopicName');
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    try {
      let topic = topics.find(t => t.name.localeCompare(name, 'es', { sensitivity: 'accent' }) === 0);
      if (topic?.archived) topic = await patch(`/api/topics/${topic.id}`, { archived: false });
      if (!topic) topic = await post('/api/topics', { name });
      input.value = '';
      await startTopic(topic);
    } catch (error) { toast(error.message, 'error'); }
  };

  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.onclick = async () => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      statsRange = btn.dataset.range;
      stats = await api(`/api/stats${rangeParams()}`);
      renderCharts();
      renderTopicGrid();
    };
  });

  $('showArchived').onchange = renderTopicList;

  for (const id of ['filterTopic', 'filterYear', 'filterMonth']) {
    $(id).onchange = () => { currentPage = 1; renderSessions(); };
  }
  $('searchSessions').oninput = debounce(() => {
    searchQuery = $('searchSessions').value.trim();
    currentPage = 1;
    renderSessions();
  }, 250);
  $('clearFilters').onclick = () => {
    for (const id of ['filterTopic', 'filterYear', 'filterMonth']) $(id).value = 'all';
    $('searchSessions').value = '';
    searchQuery = '';
    currentPage = 1;
    renderSessions();
  };

  $('selectAll').onchange = () => {
    const checked = $('selectAll').checked;
    document.querySelectorAll('#sessions .session-check').forEach(cb => {
      cb.checked = checked;
      const id = Number(cb.dataset.sid);
      if (checked) selectedIds.add(id); else selectedIds.delete(id);
    });
    updateBulkBar();
  };
  $('bulkDelete').onclick = async () => {
    if (!selectedIds.size) return;
    if (!confirm(`¿Borrar ${selectedIds.size} sesión(es)?`)) return;
    try {
      const r = await post('/api/sessions/bulk-delete', { ids: [...selectedIds] });
      toast(`${r.removed} sesiones borradas`, 'success');
      await refreshData();
    } catch (e) { toast(e.message, 'error'); }
  };

  $('cfgDuration').oninput = () => { $('durationVal').textContent = `${$('cfgDuration').value} min`; };
  $('saveSettings').onclick = async () => {
    try {
      settings = await post('/api/settings', {
        defaultDurationMin: Number($('cfgDuration').value) || 90,
        defaultMode: $('cfgDefaultMode').value,
        autoStopOnSprintEnd: $('cfgAutoStop').value === 'true',
        weeklyGoalHours: Math.min(168, Math.max(1, Number($('cfgWeeklyGoal').value) || 15)),
      });
      preferredMode = remote.state === 'idle' ? settings.defaultMode : preferredMode;
      renderSettings();
      renderTimer();
      renderKPIs();
      toast('Ajustes guardados', 'success');
    } catch (e) { toast(e.message, 'error'); }
  };

  $('backupBtn').onclick = async () => {
    const data = await api('/api/backup');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `90minutos_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Backup descargado', 'success');
  };
  $('restoreBtn').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Esto reemplazará TODOS los temas y sesiones actuales. ¿Continuar?')) { e.target.value = ''; return; }
    try {
      const data = JSON.parse(await file.text());
      const r = await post('/api/restore', data);
      toast(`Restaurado: ${r.sessions} sesiones, ${r.topics} temas`, 'success');
      await refreshData();
    } catch (err) { toast(err.message, 'error'); }
    e.target.value = '';
  };
  $('clearAll').onclick = async () => {
    const closed = sessions.filter(s => !s.active).length;
    if (!closed) { toast('No hay sesiones', 'warning'); return; }
    if (!confirm(`¿Borrar TODAS las ${closed} sesiones? No se puede deshacer.`)) return;
    try {
      await api('/api/sessions', { method: 'DELETE', headers: { 'X-Confirm-Delete': 'true' } });
      toast('Historial borrado', 'success');
      await refreshData();
    } catch (e) { toast(e.message, 'error'); }
  };

  $('calPrev').onclick = () => {
    calendarMonth--;
    if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
    renderCalendar();
  };
  $('calNext').onclick = () => {
    calendarMonth++;
    if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
    renderCalendar();
  };

  // Espacio: pausa o reanuda lo que haya en curso.
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (remote.state === 'running') $('rcPause').click();
      else if (remote.state === 'paused') $('rcResume').click();
    }
  });

  window.Charts.registerRedraw($('chartTopics'), renderCharts);
}

async function main() {
  initTheme();
  initViews();
  settings = await api('/api/settings');
  preferredMode = settings.defaultMode || 'open';
  renderSettings();

  remote = await api('/api/state');
  await refreshData();
  renderTimer();

  wireControls();
  connectWS();

  // Red de seguridad: si el WebSocket se cae, los datos no se quedan congelados.
  setInterval(() => { if (!ws) refreshData().catch(() => { }); }, 30000);
}

main().catch(e => {
  console.error(e);
  toast(`No se pudo cargar el panel: ${e.message}`, 'error', 10000);
});
