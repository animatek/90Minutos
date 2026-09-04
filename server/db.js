// SQLite mediante el módulo integrado de Node: cero dependencias nativas, nada
// que compilar al mudar la app a otra arquitectura (Raspberry Pi).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import path from 'path';
import { dbPath } from './config.js';

mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

const SCHEMA_VERSION = 2;

function currentVersion() {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  return row ? Number(row.value) : 0;
}

function migrateTo1() {
  db.exec(`
    CREATE TABLE topics (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      color       TEXT,
      archived    INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL
    );

    CREATE TABLE sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id      INTEGER NOT NULL REFERENCES topics(id),
      mode          TEXT    NOT NULL DEFAULT 'open' CHECK (mode IN ('sprint', 'open')),
      planned_sec   INTEGER,                        -- NULL en modo abierto
      started_at    TEXT    NOT NULL,
      ended_at      TEXT,                           -- NULL = sesión activa
      heartbeat_at  TEXT,                           -- último latido, para recuperar cortes
      notes         TEXT,
      url           TEXT,
      language      TEXT,
      session_type  TEXT,
      source        TEXT    NOT NULL DEFAULT 'timer' CHECK (source IN ('timer', 'import', 'manual'))
    );

    -- Cada pausa cierra un segmento y cada reanudación abre otro. La duración es
    -- la suma de segmentos, así que el tiempo en pausa nunca cuenta como trabajo.
    CREATE TABLE segments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      started_at  TEXT    NOT NULL,
      ended_at    TEXT
    );

    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE INDEX idx_sessions_started  ON sessions(started_at);
    CREATE INDEX idx_sessions_topic    ON sessions(topic_id);
    CREATE INDEX idx_sessions_active   ON sessions(ended_at) WHERE ended_at IS NULL;
    CREATE INDEX idx_segments_session  ON segments(session_id);

    -- Un segmento abierto cuenta hasta ahora mismo, así la sesión en curso
    -- reporta su duración real sin que nadie tenga que ir sumando en memoria.
    CREATE VIEW v_sessions AS
    SELECT
      s.id, s.topic_id, s.mode, s.planned_sec, s.started_at, s.ended_at,
      s.heartbeat_at, s.notes, s.url, s.language, s.session_type, s.source,
      t.name  AS topic_name,
      t.color AS topic_color,
      COALESCE((
        SELECT SUM(
          strftime('%s', COALESCE(g.ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
          - strftime('%s', g.started_at)
        )
        FROM segments g WHERE g.session_id = s.id
      ), 0) AS duration_sec
    FROM sessions s
    JOIN topics t ON t.id = s.topic_id;
  `);
}

// Un slot es una posición de la paleta categórica validada, no un color fijo: la
// interfaz resuelve el tono según el modo claro u oscuro. Un color elegido a mano
// vacía el slot y manda el hex tal cual.
function migrateTo2() {
  db.exec(`
    ALTER TABLE topics ADD COLUMN palette_slot INTEGER;

    DROP VIEW v_sessions;
    CREATE VIEW v_sessions AS
    SELECT
      s.id, s.topic_id, s.mode, s.planned_sec, s.started_at, s.ended_at,
      s.heartbeat_at, s.notes, s.url, s.language, s.session_type, s.source,
      t.name         AS topic_name,
      t.color        AS topic_color,
      t.palette_slot AS topic_slot,
      COALESCE((
        SELECT SUM(
          strftime('%s', COALESCE(g.ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
          - strftime('%s', g.started_at)
        )
        FROM segments g WHERE g.session_id = s.id
      ), 0) AS duration_sec
    FROM sessions s
    JOIN topics t ON t.id = s.topic_id;
  `);
}

export function migrate() {
  const from = currentVersion();
  if (from >= SCHEMA_VERSION) return from;
  if (from < 1) migrateTo1();
  if (from < 2) migrateTo2();
  db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
  return SCHEMA_VERSION;
}

migrate();

// --- Ajustes -----------------------------------------------------------------
// Viven en la propia base de datos para que mudar la app siga siendo un archivo.

export const DEFAULT_SETTINGS = {
  defaultDurationMin: 90,
  defaultMode: 'open',            // 'open' | 'sprint'
  autoStopOnSprintEnd: true,      // false = sigue contando en prórroga
  weeklyGoalHours: 15,
  theme: 'auto',
  opacity: 0.85,
  timezone: 'Europe/Madrid',
  languages: ['ES', 'EN'],
  defaultLanguage: 'ES',
  defaultSessionType: 'privada',
};

export function getSettings() {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  const stored = {};
  for (const r of rows) {
    try { stored[r.key] = JSON.parse(r.value); } catch { stored[r.key] = r.value; }
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function setSettings(patch) {
  const stmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                           ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;   // whitelist: nada de claves sorpresa
    stmt.run(k, JSON.stringify(v));
  }
  return getSettings();
}

// --- Temas -------------------------------------------------------------------

// Paleta categórica validada (contraste y separación para daltonismo comprobados
// en claro y oscuro con el validador de la guía de visualización). Cada slot tiene
// un paso distinto por modo: el oscuro no es el claro "apagado".
export const PALETTE_SLOTS = [
  { slot: 1, light: '#2a78d6', dark: '#3987e5' },
  { slot: 2, light: '#eb6834', dark: '#d95926' },
  { slot: 3, light: '#1baf7a', dark: '#199e70' },
  { slot: 4, light: '#eda100', dark: '#c98500' },
  { slot: 5, light: '#e87ba4', dark: '#d55181' },
  { slot: 6, light: '#008300', dark: '#008300' },
  { slot: 7, light: '#4a3aa7', dark: '#9085e9' },
  { slot: 8, light: '#e34948', dark: '#e66767' },
];
const MAX_SLOT = PALETTE_SLOTS.length;

function slotLight(slot) {
  return PALETTE_SLOTS.find(s => s.slot === slot)?.light || null;
}

// El primer slot que no esté cogido; null si ya están los ocho en uso.
function nextFreeSlot() {
  const taken = new Set(db.prepare(`SELECT palette_slot FROM topics WHERE palette_slot IS NOT NULL`).all().map(r => r.palette_slot));
  for (let s = 1; s <= MAX_SLOT; s++) if (!taken.has(s)) return s;
  return null;
}

export function listTopics({ includeArchived = false } = {}) {
  const where = includeArchived ? '' : 'WHERE archived = 0';
  return db.prepare(`
    SELECT t.id, t.name, t.color, t.archived, t.sort_order, t.palette_slot,
           (SELECT COUNT(*) FROM sessions s WHERE s.topic_id = t.id) AS session_count
    FROM topics t ${where}
    ORDER BY t.sort_order, t.name COLLATE NOCASE
  `).all().map(normalizeTopic);
}

// session_count va incluido a propósito: deleteTopic se apoya en él para negarse
// a borrar un tema con historial.
const TOPIC_SELECT = `
  SELECT t.*, (SELECT COUNT(*) FROM sessions s WHERE s.topic_id = t.id) AS session_count
  FROM topics t
`;

export function getTopic(id) {
  const row = db.prepare(`${TOPIC_SELECT} WHERE t.id = ?`).get(Number(id));
  return row ? normalizeTopic(row) : null;
}

export function findTopicByName(name) {
  const row = db.prepare(`${TOPIC_SELECT} WHERE t.name = ? COLLATE NOCASE`).get(String(name));
  return row ? normalizeTopic(row) : null;
}

export function createTopic({ name, color, sortOrder } = {}) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('El tema necesita un nombre');
  const existing = findTopicByName(clean);
  if (existing) throw new Error(`El tema "${existing.name}" ya existe`);
  const count = db.prepare(`SELECT COUNT(*) AS n FROM topics`).get().n;

  // Sin color explícito toma el siguiente slot validado. Agotados los ocho, se
  // queda en gris y las gráficas lo agrupan en "Otros" en vez de inventar tonos.
  const slot = color ? null : nextFreeSlot();
  const finalColor = color || slotLight(slot) || '#8a8a85';

  const info = db.prepare(`
    INSERT INTO topics (name, color, archived, sort_order, created_at, palette_slot)
    VALUES (?, ?, 0, ?, ?, ?)
  `).run(clean, finalColor, Number(sortOrder) || count, nowISO(), slot);
  return getTopic(info.lastInsertRowid);
}

export function updateTopic(id, patch) {
  const topic = getTopic(id);
  if (!topic) return null;
  const fields = [];
  const values = [];
  if (patch.name !== undefined) {
    const clean = String(patch.name).trim();
    if (!clean) throw new Error('El tema necesita un nombre');
    const clash = findTopicByName(clean);
    if (clash && clash.id !== topic.id) throw new Error(`El tema "${clash.name}" ya existe`);
    fields.push('name = ?'); values.push(clean);
  }
  // Un color a mano libera el slot: manda lo que el usuario ha elegido.
  if (patch.color !== undefined) {
    fields.push('color = ?'); values.push(patch.color || null);
    fields.push('palette_slot = NULL');
  }
  if (patch.paletteSlot !== undefined) {
    const slot = Number(patch.paletteSlot);
    const valid = PALETTE_SLOTS.some(s => s.slot === slot);
    fields.push('palette_slot = ?'); values.push(valid ? slot : null);
    if (valid) { fields.push('color = ?'); values.push(slotLight(slot)); }
  }
  if (patch.archived !== undefined) { fields.push('archived = ?'); values.push(patch.archived ? 1 : 0); }
  if (patch.sortOrder !== undefined) { fields.push('sort_order = ?'); values.push(Number(patch.sortOrder) || 0); }
  if (!fields.length) return topic;
  values.push(topic.id);
  db.prepare(`UPDATE topics SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getTopic(topic.id);
}

// Borrar un tema con historial se lo llevaría por delante; archivar lo esconde
// de los selectores pero conserva las sesiones.
export function deleteTopic(id) {
  const topic = getTopic(id);
  if (!topic) return { ok: false, reason: 'not_found' };
  if (topic.sessionCount > 0) return { ok: false, reason: 'has_sessions', sessionCount: topic.sessionCount };
  db.prepare(`DELETE FROM topics WHERE id = ?`).run(topic.id);
  return { ok: true };
}

export function mergeTopics(sourceId, targetId) {
  const source = getTopic(sourceId);
  const target = getTopic(targetId);
  if (!source || !target) throw new Error('Tema no encontrado');
  if (source.id === target.id) throw new Error('Origen y destino son el mismo tema');
  let moved = 0;
  transaction(() => {
    moved = db.prepare(`UPDATE sessions SET topic_id = ? WHERE topic_id = ?`).run(target.id, source.id).changes;
    db.prepare(`DELETE FROM topics WHERE id = ?`).run(source.id);
  });
  return { ok: true, moved, target };
}

function normalizeTopic(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    paletteSlot: row.palette_slot ?? null,
    archived: !!row.archived,
    sortOrder: row.sort_order,
    sessionCount: row.session_count ?? undefined,
  };
}

// --- Sesiones ----------------------------------------------------------------

export function normalizeSession(row) {
  if (!row) return null;
  const durationSec = Number(row.duration_sec) || 0;
  return {
    id: row.id,
    topicId: row.topic_id,
    topic: row.topic_name,
    topicColor: row.topic_color,
    topicSlot: row.topic_slot ?? null,
    mode: row.mode,
    plannedSec: row.planned_sec ?? null,
    startISO: row.started_at,
    endISO: row.ended_at ?? null,
    durationSec,
    durationMin: +(durationSec / 60).toFixed(2),
    notes: row.notes ?? '',
    url: row.url ?? '',
    language: row.language ?? '',
    sessionType: row.session_type ?? '',
    source: row.source,
    active: !row.ended_at,
  };
}

export function getSession(id) {
  return normalizeSession(db.prepare(`SELECT * FROM v_sessions WHERE id = ?`).get(Number(id)));
}

export function listSessions({ from, to, topicId, limit, offset, includeActive = true } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('started_at >= ?'); params.push(from); }
  if (to) { where.push('started_at <= ?'); params.push(to); }
  if (topicId) { where.push('topic_id = ?'); params.push(Number(topicId)); }
  if (!includeActive) where.push('ended_at IS NOT NULL');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let sql = `SELECT * FROM v_sessions ${clause} ORDER BY started_at DESC`;
  if (limit) {
    sql += ` LIMIT ?`; params.push(Number(limit));
    if (offset) { sql += ` OFFSET ?`; params.push(Number(offset)); }
  }
  return db.prepare(sql).all(...params).map(normalizeSession);
}

export function countSessions() {
  return db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n;
}

export function updateSession(id, patch) {
  const session = getSession(id);
  if (!session) return null;
  const map = {
    topicId: 'topic_id', notes: 'notes', url: 'url',
    language: 'language', sessionType: 'session_type',
  };
  const fields = [];
  const values = [];
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    fields.push(`${column} = ?`);
    values.push(key === 'topicId' ? Number(patch[key]) : String(patch[key] ?? ''));
  }
  if (fields.length) {
    values.push(session.id);
    db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
  // Editar las horas reescribe los segmentos: la duración siempre se deriva de ellos.
  if (patch.startISO || patch.endISO || patch.durationSec !== undefined) {
    const startISO = patch.startISO || session.startISO;
    const endISO = patch.endISO
      || (patch.durationSec !== undefined
        ? new Date(new Date(startISO).getTime() + Number(patch.durationSec) * 1000).toISOString()
        : session.endISO);
    if (endISO) {
      transaction(() => {
        db.prepare(`UPDATE sessions SET started_at = ?, ended_at = ? WHERE id = ?`).run(startISO, endISO, session.id);
        db.prepare(`DELETE FROM segments WHERE session_id = ?`).run(session.id);
        db.prepare(`INSERT INTO segments (session_id, started_at, ended_at) VALUES (?, ?, ?)`).run(session.id, startISO, endISO);
      });
    }
  }
  return getSession(session.id);
}

export function createManualSession({ topicId, startISO, durationSec, endISO, notes, url, language, sessionType, mode = 'open' } = {}) {
  const topic = getTopic(topicId);
  if (!topic) throw new Error('Tema no encontrado');
  const start = startISO || nowISO();
  const end = endISO || new Date(new Date(start).getTime() + (Number(durationSec) || 0) * 1000).toISOString();
  let id;
  transaction(() => {
    id = db.prepare(`
      INSERT INTO sessions (topic_id, mode, planned_sec, started_at, ended_at, heartbeat_at,
                            notes, url, language, session_type, source)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'manual')
    `).run(topic.id, mode, start, end, end, notes || null, url || null, language || null, sessionType || null).lastInsertRowid;
    db.prepare(`INSERT INTO segments (session_id, started_at, ended_at) VALUES (?, ?, ?)`).run(id, start, end);
  });
  return getSession(id);
}

export function deleteSession(id) {
  return db.prepare(`DELETE FROM sessions WHERE id = ?`).run(Number(id)).changes;
}

export function deleteSessions(ids) {
  let removed = 0;
  transaction(() => {
    const stmt = db.prepare(`DELETE FROM sessions WHERE id = ?`);
    for (const id of ids) removed += stmt.run(Number(id)).changes;
  });
  return removed;
}

// --- Estadísticas ------------------------------------------------------------

export function statsByTopic({ from, to } = {}) {
  const where = ['ended_at IS NOT NULL'];
  const params = [];
  if (from) { where.push('started_at >= ?'); params.push(from); }
  if (to) { where.push('started_at <= ?'); params.push(to); }
  return db.prepare(`
    SELECT topic_id AS id, topic_name AS topic, topic_color AS color, topic_slot AS slot,
           COUNT(*) AS sessions,
           SUM(duration_sec) AS total_sec
    FROM v_sessions WHERE ${where.join(' AND ')}
    GROUP BY topic_id ORDER BY total_sec DESC
  `).all(...params).map(r => ({
    id: r.id,
    topic: r.topic,
    color: r.color,
    slot: r.slot ?? null,
    sessions: r.sessions,
    totalSec: Number(r.total_sec) || 0,
    totalHours: +((Number(r.total_sec) || 0) / 3600).toFixed(2),
  }));
}

// Los días se agrupan en hora local, que es lo que el usuario entiende por "hoy".
export function dailyTotals({ from, to } = {}) {
  const where = ['ended_at IS NOT NULL'];
  const params = [];
  if (from) { where.push('started_at >= ?'); params.push(from); }
  if (to) { where.push('started_at <= ?'); params.push(to); }
  return db.prepare(`
    SELECT date(started_at, 'localtime') AS day, SUM(duration_sec) AS total_sec, COUNT(*) AS sessions
    FROM v_sessions WHERE ${where.join(' AND ')}
    GROUP BY day ORDER BY day
  `).all(...params).map(r => ({ day: r.day, totalSec: Number(r.total_sec) || 0, sessions: r.sessions }));
}

// Incluye la sesión en curso: es el número que la bandeja muestra como "hoy".
export function todaySeconds() {
  const row = db.prepare(`
    SELECT COALESCE(SUM(duration_sec), 0) AS total_sec FROM v_sessions
    WHERE date(started_at, 'localtime') = date('now', 'localtime')
  `).get();
  return Number(row.total_sec) || 0;
}

// --- Utilidades --------------------------------------------------------------

export function nowISO() { return new Date().toISOString(); }

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
