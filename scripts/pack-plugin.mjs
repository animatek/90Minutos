import fs from 'fs'; import path from 'path'; import archiver from 'archiver'; import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url); const __dirname = path.dirname(__filename);
async function zipDir(srcDir, zipPath){
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  return new Promise((resolve, reject) => { output.on('close', resolve); archive.on('error', reject); archive.pipe(output); archive.directory(srcDir, false); archive.finalize(); });
}
const src = path.join(__dirname, '..', 'streamdeck-plugin'); const out = path.join(__dirname, '..', 'animatek-timer.streamDeckPlugin');
await zipDir(src, out); console.log('Plugin empaquetado en', out);
