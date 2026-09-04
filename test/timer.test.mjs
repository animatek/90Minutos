// Pruebas de la lógica de duración y del ciclo de vida de una sesión.
// Es la parte que no puede fallar en silencio: si aquí hay un error, el historial
// acumula horas equivocadas durante meses sin que nada avise.
//
//   npm test
import os from 'os';
import path from 'path';
import { rmSync } from 'fs';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// La base de datos se elige al importar config.js, así que hay que fijarla antes.
const tmpDb = path.join(os.tmpdir(), `90m-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;

const dbmod = await import('../server/db.js');
const {
  db, createTopic, getTopic, deleteTopic, mergeTopics,
  getSession, getSettings, setSettings, listSessions, createManualSession, updateSession,
} = dbmod;
const { Timer } = await import('../server/timer.js');

let topicId;

before(() => {
  topicId = createTopic({ name: 'Pruebas' }).id;
  setSettings({ autoStopOnSprintEnd: true, defaultMode: 'open' });
});

beforeEach(() => {
  db.exec('DELETE FROM sessions');
});

after(() => {
  try { db.close(); } catch { }
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(tmpDb + suffix); } catch { }
  }
});

/** Inserta una sesión cerrada con segmentos concretos, sin pasar por el timer. */
function craftSession(segments, { mode = 'open', plannedSec = null } = {}) {
  const start = segments[0][0];
  const end = segments[segments.length - 1][1];
  const id = db.prepare(`
    INSERT INTO sessions (topic_id, mode, planned_sec, started_at, ended_at, heartbeat_at, source)
    VALUES (?, ?, ?, ?, ?, ?, 'timer')
  `).run(topicId, mode, plannedSec, start, end, end).lastInsertRowid;
  for (const [from, to] of segments) {
    db.prepare(`INSERT INTO segments (session_id, started_at, ended_at) VALUES (?, ?, ?)`).run(id, from, to);
  }
  return id;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- La corrección central ---------------------------------------------------

test('el tiempo en pausa no cuenta como trabajado', () => {
  // Dos horas de reloj de pared, pero solo una hora trabajada: una pausa de
  // 60 min en medio. El código antiguo hacía fin - inicio y registraba 120 min.
  const id = craftSession([
    ['2026-07-25T10:00:00.000Z', '2026-07-25T10:30:00.000Z'],
    ['2026-07-25T11:30:00.000Z', '2026-07-25T12:00:00.000Z'],
  ]);
  const session = getSession(id);
  assert.equal(session.durationSec, 3600, 'debe sumar solo los segmentos');
  assert.equal(session.durationMin, 60);

  const wallClock = (Date.parse(session.endISO) - Date.parse(session.startISO)) / 1000;
  assert.equal(wallClock, 7200);
  assert.ok(session.durationSec < wallClock, 'la duración nunca es el reloj de pared');
});

test('una sesión sin pausas dura exactamente lo que el reloj de pared', () => {
  const id = craftSession([['2026-07-25T10:00:00.000Z', '2026-07-25T11:30:00.000Z']]);
  assert.equal(getSession(id).durationSec, 5400);
});

test('la duración suma varios segmentos cortos', () => {
  const id = craftSession([
    ['2026-07-25T09:00:00.000Z', '2026-07-25T09:10:00.000Z'],
    ['2026-07-25T09:15:00.000Z', '2026-07-25T09:25:00.000Z'],
    ['2026-07-25T09:40:00.000Z', '2026-07-25T09:50:00.000Z'],
  ]);
  assert.equal(getSession(id).durationSec, 1800);
});

// --- Ciclo de vida -----------------------------------------------------------

test('start / pause / resume / stop recorre los estados y guarda la sesión', async () => {
  const timer = new Timer();
  assert.equal(timer.state, 'idle');

  timer.start({ topicId, mode: 'open' });
  assert.equal(timer.state, 'running');
  assert.equal(timer.snapshot().mode, 'open');
  assert.equal(timer.snapshot().remainingSec, null, 'el modo abierto no tiene cuenta atrás');

  await sleep(1100);
  timer.pause();
  assert.equal(timer.state, 'paused');
  const paused = timer.snapshot().elapsedSec;
  assert.ok(paused >= 1, `esperaba al menos 1 s, hubo ${paused}`);

  await sleep(1100);
  assert.equal(timer.snapshot().elapsedSec, paused, 'en pausa el contador no avanza');

  timer.resume();
  assert.equal(timer.state, 'running');
  const finished = timer.stop();
  assert.equal(timer.state, 'idle');
  assert.equal(finished.active, false);
  assert.ok(finished.endISO, 'la sesión guardada tiene fin');
  timer.shutdown();
});

test('el fin de la sesión es el último instante trabajado, no el momento de parar', () => {
  const timer = new Timer();
  timer.start({ topicId, mode: 'open' });
  const sessionId = timer.snapshot().sessionId;

  // Simula: trabajó hasta las 10:30 y dejó la app en pausa hasta que la cerró hoy.
  db.prepare(`UPDATE segments SET started_at = ?, ended_at = ? WHERE session_id = ?`)
    .run('2026-07-25T10:00:00.000Z', '2026-07-25T10:30:00.000Z', sessionId);

  const finished = timer.stop();
  assert.equal(finished.endISO, '2026-07-25T10:30:00.000Z');
  assert.equal(finished.durationSec, 1800, 'la pausa antes de parar no infla la sesión');
  timer.shutdown();
});

test('arrancar otro tema cierra el anterior y abre el nuevo', () => {
  const timer = new Timer();
  const otro = createTopic({ name: `Otro tema ${Date.now()}` }).id;

  timer.start({ topicId, mode: 'open' });
  const primera = timer.snapshot().sessionId;

  const { previous } = timer.start({ topicId: otro, mode: 'open' });
  assert.equal(previous.id, primera);
  assert.equal(previous.active, false, 'la sesión anterior queda cerrada');
  assert.equal(timer.state, 'running');
  assert.equal(timer.snapshot().topicId, otro);

  assert.equal(listSessions().length, 2, 'quedan las dos sesiones en el historial');
  timer.stop();
  timer.shutdown();
});

test('descartar no deja rastro en el historial', () => {
  const timer = new Timer();
  timer.start({ topicId, mode: 'open' });
  timer.discard();
  assert.equal(timer.state, 'idle');
  assert.equal(listSessions().length, 0);
  timer.shutdown();
});

// --- Recuperación tras un corte ----------------------------------------------

test('una sesión interrumpida se recupera en pausa y cierra en el último latido', () => {
  const timer = new Timer();
  timer.start({ topicId, mode: 'open' });
  const sessionId = timer.snapshot().sessionId;
  timer.shutdown();     // simula un cierre brusco: el segmento queda abierto

  // El equipo estuvo apagado de 10:30 a 18:00; el último latido fue a las 10:30.
  db.prepare(`UPDATE segments SET started_at = ?, ended_at = NULL WHERE session_id = ?`)
    .run('2026-07-25T10:00:00.000Z', sessionId);
  db.prepare(`UPDATE sessions SET started_at = ?, heartbeat_at = ? WHERE id = ?`)
    .run('2026-07-25T10:00:00.000Z', '2026-07-25T10:30:00.000Z', sessionId);

  const fresh = new Timer();
  const result = fresh.recover();
  assert.equal(result.interrupted, true);
  assert.equal(fresh.state, 'paused', 'se recupera en pausa: ni se pierde ni se inventa tiempo');
  assert.equal(result.session.durationSec, 1800, 'cuenta hasta el último latido, no hasta ahora');
  assert.equal(result.session.active, true, 'la sesión sigue abierta para decidir');
  fresh.shutdown();
});

test('un cierre ordenado en pausa se recupera sin tocar nada', () => {
  const timer = new Timer();
  timer.start({ topicId, mode: 'open' });
  timer.pause();
  const before = timer.snapshot().elapsedSec;
  timer.shutdown();

  const fresh = new Timer();
  const result = fresh.recover();
  assert.equal(result.interrupted, false, 'no había segmento abierto que cerrar');
  assert.equal(fresh.state, 'paused');
  assert.equal(fresh.snapshot().elapsedSec, before);
  fresh.shutdown();
});

// --- Modo sprint -------------------------------------------------------------

test('el sprint calcula la cuenta atrás y se cierra solo al llegar al objetivo', async () => {
  const timer = new Timer();
  let completed = null;
  timer.on('complete', (s) => { completed = s; });

  timer.start({ topicId, mode: 'sprint', plannedSec: 2 });
  const snap = timer.snapshot();
  assert.equal(snap.mode, 'sprint');
  assert.equal(snap.plannedSec, 2);
  assert.ok(snap.remainingSec <= 2 && snap.remainingSec >= 0);

  await sleep(3600);
  assert.equal(timer.state, 'idle', 'el sprint se cierra al alcanzar el objetivo');
  assert.ok(completed, 'debe emitir complete');
  assert.ok(completed.durationSec >= 2);
  timer.shutdown();
});

test('extender el sprint mueve el objetivo sin tocar lo ya trabajado', () => {
  const timer = new Timer();
  timer.start({ topicId, mode: 'sprint', plannedSec: 3600 });
  const antes = timer.snapshot().elapsedSec;

  timer.extend(600);
  const snap = timer.snapshot();
  assert.equal(snap.plannedSec, 4200);
  assert.equal(snap.elapsedSec, antes, 'extender no regala tiempo trabajado');
  timer.discard();
  timer.shutdown();
});

test('el modo abierto no admite objetivo que extender', () => {
  const timer = new Timer();
  timer.start({ topicId, mode: 'open' });
  assert.throws(() => timer.extend(600), /sprint/);
  timer.discard();
  timer.shutdown();
});

// --- Errores esperados -------------------------------------------------------

test('los comandos sin sesión activa fallan con un mensaje claro', () => {
  const timer = new Timer();
  assert.throws(() => timer.pause(), /No hay sesión activa/);
  assert.throws(() => timer.resume(), /No hay sesión activa/);
  assert.throws(() => timer.stop(), /No hay sesión activa/);
  assert.equal(timer.discard(), null, 'descartar sin sesión no es un error');
});

test('no se puede arrancar con un tema inexistente', () => {
  const timer = new Timer();
  assert.throws(() => timer.start({ topicId: 999999 }), /Tema no encontrado/);
});

// --- Temas -------------------------------------------------------------------

test('un tema con sesiones no se puede borrar', () => {
  // Regresión: getTopic no traía session_count, así que la comprobación no
  // saltaba nunca y el borrado llegaba a la base de datos a estrellarse contra
  // la clave ajena con un error incomprensible.
  const topic = createTopic({ name: `Con historial ${Date.now()}` });
  createManualSession({ topicId: topic.id, durationSec: 600 });

  assert.equal(getTopic(topic.id).sessionCount, 1, 'getTopic debe informar del número de sesiones');

  const result = deleteTopic(topic.id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'has_sessions');
  assert.equal(result.sessionCount, 1);
  assert.ok(getTopic(topic.id), 'el tema sigue ahí');
});

test('un tema sin sesiones sí se borra', () => {
  const topic = createTopic({ name: `Vacío ${Date.now()}` });
  assert.equal(deleteTopic(topic.id).ok, true);
  assert.equal(getTopic(topic.id), null);
});

test('fusionar mueve las sesiones y elimina el tema de origen', () => {
  const from = createTopic({ name: `Origen ${Date.now()}` });
  const to = createTopic({ name: `Destino ${Date.now()}` });
  createManualSession({ topicId: from.id, durationSec: 1800 });
  createManualSession({ topicId: from.id, durationSec: 900 });

  const result = mergeTopics(from.id, to.id);
  assert.equal(result.moved, 2);
  assert.equal(getTopic(from.id), null, 'el origen desaparece');
  assert.equal(getTopic(to.id).sessionCount, 2, 'las sesiones llegan al destino');
});

test('no se fusiona un tema consigo mismo', () => {
  const topic = createTopic({ name: `Solo ${Date.now()}` });
  assert.throws(() => mergeTopics(topic.id, topic.id), /mismo tema/);
});

test('los nombres de tema no se duplican ignorando mayúsculas', () => {
  const name = `Duplicado ${Date.now()}`;
  createTopic({ name });
  assert.throws(() => createTopic({ name: name.toUpperCase() }), /ya existe/);
});

test('editar el historial cambia tema, fecha, duración, URL y notas mediante segmentos', () => {
  const target = createTopic({ name: `Tema editado ${Date.now()}` });
  const original = createManualSession({
    topicId,
    startISO: '2026-07-20T08:00:00.000Z',
    durationSec: 600,
  });

  const updated = updateSession(original.id, {
    topicId: target.id,
    startISO: '2026-07-21T09:30:00.000Z',
    durationSec: 1500,
    url: 'https://youtube.com/watch?v=prueba',
    notes: 'Sesión corregida desde el historial',
  });

  assert.equal(updated.topicId, target.id);
  assert.equal(updated.startISO, '2026-07-21T09:30:00.000Z');
  assert.equal(updated.durationSec, 1500);
  assert.equal(updated.url, 'https://youtube.com/watch?v=prueba');
  assert.equal(updated.notes, 'Sesión corregida desde el historial');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM segments WHERE session_id = ?').get(original.id).n,
    1,
    'editar la duración reescribe un segmento en lugar de guardar un contador paralelo',
  );
});

test('el objetivo semanal se guarda como ajuste conocido', () => {
  const updated = setSettings({ weeklyGoalHours: 37, claveInventada: 'ignorada' });
  assert.equal(updated.weeklyGoalHours, 37);
  assert.equal('claveInventada' in getSettings(), false, 'la whitelist rechaza ajustes desconocidos');
  setSettings({ weeklyGoalHours: 15 });
});

// Este test necesita la tabla de temas vacía, así que va al final del archivo.
test('cada tema nuevo coge un slot distinto de la paleta validada', () => {
  db.exec('DELETE FROM sessions; DELETE FROM topics');

  const created = dbmod.PALETTE_SLOTS.map((_, i) => createTopic({ name: `Slot test ${i}` }));
  assert.deepEqual(
    created.map(t => t.paletteSlot),
    dbmod.PALETTE_SLOTS.map(s => s.slot),
    'reparte los ocho slots en orden',
  );

  // Agotados los ocho, no se inventan tonos nuevos: gris y a "Otros".
  assert.equal(createTopic({ name: 'Slot test extra' }).paletteSlot, null);

  // Elegir un color a mano libera el slot.
  const custom = dbmod.updateTopic(created[0].id, { color: '#123456' });
  assert.equal(custom.color, '#123456');
  assert.equal(custom.paletteSlot, null);

  // Y ese slot vuelve a estar disponible para el siguiente tema.
  assert.equal(createTopic({ name: 'Slot test reciclado' }).paletteSlot, 1);
});
