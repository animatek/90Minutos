#!/usr/bin/env node
// Reparte los ocho slots de la paleta validada entre los temas con más horas.
//
// El código antiguo asignaba colores al azar de una paleta de nueve entre 32
// categorías, así que los dos temas con más horas podían compartir tono y en un
// donut resultaban indistinguibles. Los temas fuera del top 8 conservan su color
// (les basta: en las tablas el nombre va escrito al lado) y las gráficas los
// agrupan en "Otros".
//
//   node migrate/recolor-topics.mjs --dry-run
//   node migrate/recolor-topics.mjs
import { db, statsByTopic, listTopics, PALETTE_SLOTS } from '../server/db.js';

const dryRun = process.argv.includes('--dry-run');
const ranked = statsByTopic();
const top = ranked.slice(0, PALETTE_SLOTS.length);

console.log(`\n[recolor] ${ranked.length} temas con horas · ${PALETTE_SLOTS.length} slots validados\n`);

const assignments = top.map((t, i) => ({
  id: t.id,
  topic: t.topic,
  hours: t.totalHours,
  from: t.color,
  slot: PALETTE_SLOTS[i].slot,
  to: PALETTE_SLOTS[i].light,
}));

// Colores que estaban repitiéndose entre los temas grandes.
const seen = new Map();
for (const t of top) seen.set(t.color, (seen.get(t.color) || 0) + 1);
const clashes = [...seen.entries()].filter(([, n]) => n > 1);
if (clashes.length) {
  console.log('  Colores repetidos en el top 8 que se corrigen:');
  for (const [color, n] of clashes) {
    const names = top.filter(t => t.color === color).map(t => t.topic).join(', ');
    console.log(`    ${color} × ${n}  →  ${names}`);
  }
  console.log('');
}

console.log('  Asignación:');
for (const a of assignments) {
  console.log(`    slot ${a.slot}  ${a.from} → ${a.to}   ${a.hours.toFixed(1).padStart(6)} h  ${a.topic}`);
}

const rest = ranked.slice(PALETTE_SLOTS.length);
if (rest.length) console.log(`\n  ${rest.length} temas menores conservan su color y se agrupan en "Otros".`);

const unused = listTopics({ includeArchived: true }).filter(t => !ranked.some(r => r.id === t.id));
if (unused.length) console.log(`  ${unused.length} temas sin sesiones sin tocar.`);

if (dryRun) {
  console.log('\n[recolor] --dry-run: no se ha escrito nada.\n');
} else {
  const stmt = db.prepare(`UPDATE topics SET color = ?, palette_slot = ? WHERE id = ?`);
  // Libera los slots antes de repartirlos: son únicos por tema.
  db.prepare(`UPDATE topics SET palette_slot = NULL`).run();
  for (const a of assignments) stmt.run(a.to, a.slot, a.id);
  console.log(`\n[recolor] ${assignments.length} temas recoloreados.\n`);
}
