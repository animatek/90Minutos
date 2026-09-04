#!/usr/bin/env node
// Migra server/data/{sessions,config}.json a SQLite.
//
// Deduplica los ids que colisionaban (el timer usaba Date.now() y el import de
// Sheets usaba la fecha de inicio, así que 36 sesiones compartían id y borrar una
// se llevaba varias) y unifica las categorías escritas a mano en temas reales.
//
//   node migrate/json-to-sqlite.mjs --dry-run    # solo informe, no escribe
//   node migrate/json-to-sqlite.mjs              # migra
import { promises as fs } from 'fs';
import path from 'path';
import { rootDir, dataDir, dbPath } from '../server/config.js';
import { db, createTopic, findTopicByName, setSettings, transaction, countSessions } from '../server/db.js';

const dryRun = process.argv.includes('--dry-run');
const legacyDir = path.join(rootDir, 'server', 'data');

// Categorías que son el mismo tema escrito de dos maneras. Clave: nombre en
// minúsculas y con los espacios ya colapsados.
const ALIASES = new Map([
  ['b2.1 inglés', 'Inglés B2.1'],
  ['inglés b2.1', 'Inglés B2.1'],
  ['bitwig', 'Bitwig'],
  ['desarrollo - uzz', 'Desarrollo UZZ'],
  ['obisidan', 'Obsidian'],
  ['streaming', 'Streaming'],
  ['vickyleaks', 'Vickyleaks'],
  ['vcv rack', 'VCV Rack'],
  ['vcv rack - streaming', 'VCV Rack - Streaming'],
]);

function canonicalName(raw) {
  const collapsed = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!collapsed) return 'Sin tema';
  return ALIASES.get(collapsed.toLowerCase()) || collapsed;
}

async function readJSONIfExists(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf-8')); }
  catch { return fallback; }
}

function fmtHours(sec) { return (sec / 3600).toFixed(2) + ' h'; }

async function main() {
  const sessions = await readJSONIfExists(path.join(legacyDir, 'sessions.json'), []);
  const config = await readJSONIfExists(path.join(legacyDir, 'config.json'), {});

  if (!Array.isArray(sessions) || !sessions.length) {
    console.log('[migrate] No hay sesiones que migrar en server/data/sessions.json');
    return;
  }
  const already = countSessions();
  if (already > 0) {
    console.error(`[migrate] ABORTA: ${dbPath} ya contiene ${already} sesiones.`);
    console.error('           Borra o mueve el .db si quieres re-migrar desde cero.');
    process.exit(1);
  }

  // --- Informe de normalización ---------------------------------------------
  const groups = new Map();          // canónico -> { originals:Set, sessions, sec }
  let legacyTotalSec = 0;
  const idCounts = new Map();
  const renamedSessionNames = [];

  for (const s of sessions) {
    const canon = canonicalName(s.category);
    const sec = Math.max(0, Math.round(Number(s.durationSec) || (Number(s.durationMin) || 0) * 60));
    legacyTotalSec += sec;
    idCounts.set(s.id, (idCounts.get(s.id) || 0) + 1);

    if (!groups.has(canon)) groups.set(canon, { originals: new Set(), sessions: 0, sec: 0 });
    const g = groups.get(canon);
    g.originals.add(String(s.category ?? ''));
    g.sessions++;
    g.sec += sec;

    const name = String(s.sessionName ?? '').trim();
    if (name && name !== String(s.category ?? '').trim()) {
      renamedSessionNames.push({ id: s.id, name, category: s.category });
    }
  }

  const duplicatedIds = [...idCounts.entries()].filter(([, n]) => n > 1);

  console.log(`\n[migrate] ${sessions.length} sesiones · ${fmtHours(legacyTotalSec)} · ${groups.size} temas tras normalizar`);
  console.log(`[migrate] ids duplicados que se renumeran: ${duplicatedIds.length} (afectan a ${duplicatedIds.reduce((a, [, n]) => a + n, 0)} sesiones)\n`);

  const merged = [...groups.entries()].filter(([, g]) => g.originals.size > 1);
  if (merged.length) {
    console.log('  Fusiones:');
    for (const [canon, g] of merged) {
      const from = [...g.originals].map(o => JSON.stringify(o)).join(' + ');
      console.log(`    ${from}  →  "${canon}"  (${g.sessions} sesiones, ${fmtHours(g.sec)})`);
    }
    console.log('');
  }

  const renamedOnly = [...groups.entries()]
    .filter(([canon, g]) => g.originals.size === 1 && [...g.originals][0] !== canon);
  if (renamedOnly.length) {
    console.log('  Renombrados:');
    for (const [canon, g] of renamedOnly) {
      console.log(`    ${JSON.stringify([...g.originals][0])}  →  "${canon}"`);
    }
    console.log('');
  }

  if (renamedSessionNames.length) {
    console.log(`  Aviso: ${renamedSessionNames.length} sesiones tenían sessionName distinto de la categoría; se conserva en las notas.\n`);
  }

  if (dryRun) {
    console.log('[migrate] --dry-run: no se ha escrito nada.\n');
    return;
  }

  // --- Copia de seguridad ----------------------------------------------------
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(dataDir, 'backups', `pre-sqlite-${stamp}`);
  await fs.mkdir(backupDir, { recursive: true });
  for (const file of ['sessions.json', 'config.json']) {
    try { await fs.copyFile(path.join(legacyDir, file), path.join(backupDir, file)); } catch { }
  }
  console.log(`[migrate] Copia de seguridad en ${backupDir}`);

  // --- Colores por tema ------------------------------------------------------
  // Gana el color del nombre canónico; si no tiene, el de cualquier variante.
  const legacyColors = config.categoryColors || {};
  const colorFor = new Map();
  for (const [rawName, color] of Object.entries(legacyColors)) {
    const canon = canonicalName(rawName);
    const isCanonical = String(rawName).trim().replace(/\s+/g, ' ') === canon;
    if (isCanonical || !colorFor.has(canon)) colorFor.set(canon, color);
  }

  // --- Escritura -------------------------------------------------------------
  let inserted = 0;
  transaction(() => {
    // Los temas de la config que aún no tienen sesiones también se conservan.
    const allNames = new Set([
      ...groups.keys(),
      ...(config.categories || []).map(canonicalName),
    ]);
    const topicIds = new Map();
    for (const name of [...allNames].sort((a, b) => a.localeCompare(b, 'es'))) {
      const topic = findTopicByName(name) || createTopic({ name, color: colorFor.get(name) });
      topicIds.set(name, topic.id);
    }

    const insertSession = db.prepare(`
      INSERT INTO sessions (topic_id, mode, planned_sec, started_at, ended_at, heartbeat_at,
                            notes, url, language, session_type, source)
      VALUES (?, 'open', NULL, ?, ?, ?, ?, ?, ?, ?, 'import')
    `);
    const insertSegment = db.prepare(`INSERT INTO segments (session_id, started_at, ended_at) VALUES (?, ?, ?)`);

    for (const s of sessions) {
      const topicId = topicIds.get(canonicalName(s.category));

      const start = s.startISO && !Number.isNaN(Date.parse(s.startISO))
        ? new Date(s.startISO).toISOString()
        : new Date(Number(s.id) || Date.now()).toISOString();

      // El fin se deriva de la duración registrada, no del endISO: la duración es
      // el dato que llevas meses mirando y tiene que cuadrar al céntimo.
      const sec = Math.max(0, Math.round(Number(s.durationSec) || (Number(s.durationMin) || 0) * 60));
      const end = new Date(new Date(start).getTime() + sec * 1000).toISOString();

      const legacyName = String(s.sessionName ?? '').trim();
      const notes = [
        String(s.notes ?? '').trim(),
        legacyName && legacyName !== String(s.category ?? '').trim() ? `Nombre original: ${legacyName}` : '',
      ].filter(Boolean).join('\n') || null;

      const id = insertSession.run(
        topicId, start, end, end, notes,
        String(s.url ?? '').trim() || null,
        String(s.language ?? '').trim() || null,
        String(s.sessionType ?? '').trim() || null,
      ).lastInsertRowid;
      insertSegment.run(id, start, end);
      inserted++;
    }
  });

  // --- Ajustes ---------------------------------------------------------------
  setSettings({
    defaultDurationMin: Number(config.defaultDurationMin) || 90,
    theme: config.theme || 'auto',
    opacity: config.opacity ?? 0.85,
    timezone: config.timezone || 'Europe/Madrid',
    languages: Array.isArray(config.languages) ? config.languages : ['ES', 'EN'],
    defaultLanguage: config.defaultLanguage || 'ES',
    defaultSessionType: config.defaultSessionType || 'privada',
  });

  // --- Verificación ----------------------------------------------------------
  const after = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(duration_sec), 0) AS sec FROM v_sessions`).get();
  const topicCount = db.prepare(`SELECT COUNT(*) AS n FROM topics`).get().n;

  console.log(`[migrate] Insertadas ${inserted} sesiones en ${topicCount} temas → ${dbPath}`);
  console.log(`[migrate] Verificación: ${after.n} sesiones · ${fmtHours(Number(after.sec))}`);

  if (after.n !== sessions.length || Number(after.sec) !== legacyTotalSec) {
    console.error(`[migrate] ¡DESCUADRE! esperado ${sessions.length} sesiones / ${fmtHours(legacyTotalSec)}`);
    process.exit(1);
  }
  console.log('[migrate] Sesiones y horas cuadran exactamente con el JSON original.\n');
}

main().catch(e => { console.error('[migrate] Error:', e); process.exit(1); });
