import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, 'data');

async function ensureDataDir() { await fs.mkdir(dataDir, { recursive: true }); }

export async function readJSON(name, fallback) {
  await ensureDataDir();
  const p = path.join(dataDir, name);
  try {
    const raw = await fs.readFile(p, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

export async function writeJSON(name, obj) {
  await ensureDataDir();
  const p = path.join(dataDir, name);
  const tmp = p + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  await fs.rename(tmp, p);
}

export const paths = {
  dataDir,
  tokens: path.join(dataDir, 'tokens.json'),
  sessionsFile: path.join(dataDir, 'sessions.json'),
  configFile: path.join(dataDir, 'config.json'),
  sessionsOutDir: path.join(__dirname, '..', 'sessions'),
};
