// Configuración y rutas. Nada aquí depende de dónde esté clonado el repo:
// mover la app a otra máquina (o a una Raspberry Pi) es copiar el código y el .db.
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.join(__dirname, '..');

// El primer .env que define una variable gana (dotenv no sobreescribe).
dotenv.config({ path: path.join(rootDir, '.env') });
dotenv.config({ path: path.join(__dirname, '.env') });

function firstDefined(...vals) {
  for (const v of vals) if (v) return v;
  return undefined;
}

// Datos fuera del repo: así los backups son un archivo y el código es desechable.
const xdgData = firstDefined(process.env.XDG_DATA_HOME, path.join(os.homedir(), '.local', 'share'));
export const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(xdgData, '90minutos');

export const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(dataDir, '90minutos.db');

// El PID vive en una ruta que también sabe calcular el script de shell.
export const pidFile = path.join(firstDefined(process.env.XDG_RUNTIME_DIR, os.tmpdir()), '90minutos.pid');

export const port = Number(process.env.PORT) || 5173;
export const wsPort = Number(process.env.WS_PORT) || 8765;
export const host = process.env.HOST || '127.0.0.1';
export const authToken = process.env.AUTH_TOKEN || '';
export const iconPath = path.join(rootDir, 'icon', '90.png');

export const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(host);

// Escuchar fuera de loopback sin token dejaría el historial abierto a cualquiera
// en la red. Preferimos no arrancar antes que arrancar desprotegido.
export function assertNetworkConfig() {
  if (!isLoopback && !authToken) {
    throw new Error(
      `HOST=${host} expone el servidor en la red pero AUTH_TOKEN está vacío.\n` +
      `  Genera uno con:  node -e "console.log(crypto.randomUUID())"\n` +
      `  y añádelo al .env como AUTH_TOKEN=…`
    );
  }
}
