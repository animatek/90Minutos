const API = 'https://developer-api.govee.com/v1/devices/control';
const KEY = process.env.GOVEE_API_KEY;

const DEVICES = {
  estudio: { device: 'DA:1C:DD:6E:84:C6:55:6A', model: 'H6047', name: 'Estudio Javi' },
  salon:   { device: '53:5E:D3:36:36:37:37:06', model: 'H6046', name: 'Luz Salon Tv' },
};

// Rate limit: 10 req/min GLOBAL (all devices share the same key).
const MIN_GAP_MS = 6200; // ~9.6 req/min max, safe margin
const MAX_RETRIES = 2;
let lastCallGlobal = 0;
let sendQueue = Promise.resolve();

function enqueue(fn) {
  sendQueue = sendQueue.then(fn, fn);
  return sendQueue;
}

async function send(dev, cmd) {
  return enqueue(() => _send(dev, cmd, 0));
}

async function _send(dev, cmd, attempt) {
  if (!KEY) throw new Error('GOVEE_API_KEY no configurada');

  const now = Date.now();
  const elapsed = now - lastCallGlobal;
  if (elapsed < MIN_GAP_MS) await delay(MIN_GAP_MS - elapsed);
  lastCallGlobal = Date.now();

  const res = await fetch(API, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Govee-API-Key': KEY },
    body: JSON.stringify({ device: dev.device, model: dev.model, cmd }),
  });

  if (res.status === 429 && attempt < MAX_RETRIES) {
    const body = await res.text();
    const match = body.match(/(\d+)\s*second/i);
    const waitSec = match ? parseInt(match[1], 10) + 1 : 30;
    console.log(`[Govee] 429 rate-limited, reintentando en ${waitSec}s (intento ${attempt + 1}/${MAX_RETRIES})`);
    await delay(waitSec * 1000);
    lastCallGlobal = Date.now();
    return _send(dev, cmd, attempt + 1);
  }

  if (!res.ok) throw new Error(`Govee ${res.status}: ${await res.text()}`);
  return res.json();
}

async function turnOn(dev)  { return send(dev, { name: 'turn', value: 'on' }); }
async function turnOff(dev) { return send(dev, { name: 'turn', value: 'off' }); }
async function setColor(dev, r, g, b) { return send(dev, { name: 'color', value: { r, g, b } }); }
async function setBrightness(dev, pct) { return send(dev, { name: 'brightness', value: pct }); }

const delay = (ms) => new Promise(r => setTimeout(r, ms));

export const CATEGORY_COLORS = {
  'VCV Rack':  { r: 0, g: 128, b: 0 },      // verde
  'Bitwig':    { r: 255, g: 165, b: 0 },     // naranja
  'Octatrack': { r: 0, g: 100, b: 255 },     // azul
};

export async function applyCategoryColor(catName) {
  const color = CATEGORY_COLORS[catName];
  if (!color) return false;
  await turnOn(DEVICES.estudio);
  await setColor(DEVICES.estudio, color.r, color.g, color.b);
  await setBrightness(DEVICES.estudio, 50);
  return true;
}

export const PRESETS = {
  focus: {
    name: 'Focus (90min)',
    emoji: '\u{1F9E0}',
    desc: 'Estudio Azul Claro 50%, Salon Off',
  },
  streaming: {
    name: 'Streaming',
    emoji: '\u{1F3A5}',
    desc: 'Estudio Blanco 100%, Salon Verde 10%',
  },
  movie: {
    name: 'Movie',
    emoji: '\u{1F3AC}',
    desc: 'Salon Azul 5%, Estudio Off',
  },
  romantic: {
    name: 'Romantic',
    emoji: '\u{2764}\u{FE0F}',
    desc: 'Todo Rojo Carmesi 20%',
  },
};

export async function applyPreset(name) {
  const d = DEVICES;
  switch (name) {
    case 'focus':
      await turnOn(d.estudio);
      await setColor(d.estudio, 173, 216, 230);
      await setBrightness(d.estudio, 50);
      await turnOff(d.salon);
      break;
    case 'streaming':
      await turnOn(d.estudio);
      await setColor(d.estudio, 255, 255, 255);
      await setBrightness(d.estudio, 100);
      await turnOn(d.salon);
      await setColor(d.salon, 0, 128, 0);
      await setBrightness(d.salon, 10);
      break;
    case 'movie':
      await turnOn(d.salon);
      await setColor(d.salon, 0, 0, 255);
      await setBrightness(d.salon, 5);
      await turnOff(d.estudio);
      break;
    case 'romantic':
      await turnOn(d.estudio);
      await setColor(d.estudio, 220, 20, 60);
      await setBrightness(d.estudio, 20);
      await turnOn(d.salon);
      await setColor(d.salon, 220, 20, 60);
      await setBrightness(d.salon, 20);
      break;
  }
}

export async function allOn() {
  await turnOn(DEVICES.estudio);
  await turnOn(DEVICES.salon);
}

export async function allOff() {
  await turnOff(DEVICES.estudio);
  await turnOff(DEVICES.salon);
}

export async function blink() {
  // 2 cycles: off-on off-on (4 commands per device, safe within rate limit)
  for (let i = 0; i < 2; i++) {
    await turnOff(DEVICES.estudio);
    await turnOff(DEVICES.salon);
    await turnOn(DEVICES.estudio);
    await turnOn(DEVICES.salon);
  }
}

async function getDeviceState(dev) {
  if (!KEY) return null;
  const url = `https://developer-api.govee.com/v1/devices/state?device=${encodeURIComponent(dev.device)}&model=${dev.model}`;
  const res = await fetch(url, { headers: { 'Govee-API-Key': KEY } });
  if (!res.ok) return null;
  const json = await res.json();
  const props = json.data?.properties || [];
  const power = props.find(p => p.powerState)?.powerState || 'unknown';
  const brightness = props.find(p => p.brightness !== undefined)?.brightness;
  const color = props.find(p => p.color)?.color;
  return { name: dev.name, power, brightness, color };
}

export async function getAllStates() {
  const [estudio, salon] = await Promise.all([
    getDeviceState(DEVICES.estudio).catch(() => null),
    getDeviceState(DEVICES.salon).catch(() => null),
  ]);
  return { estudio, salon };
}

export const COLORS = {
  // español
  rojo:      { r: 255, g: 0,   b: 0 },
  azul:      { r: 0,   g: 0,   b: 255 },
  verde:     { r: 0,   g: 255, b: 0 },
  blanco:    { r: 255, g: 255, b: 255 },
  amarillo:  { r: 255, g: 255, b: 0 },
  naranja:   { r: 255, g: 165, b: 0 },
  morado:    { r: 128, g: 0,   b: 255 },
  violeta:   { r: 128, g: 0,   b: 255 },
  rosa:      { r: 255, g: 105, b: 180 },
  cyan:      { r: 0,   g: 255, b: 255 },
  turquesa:  { r: 0,   g: 255, b: 255 },
  carmesi:   { r: 220, g: 20,  b: 60 },
  calido:    { r: 255, g: 200, b: 100 },
  frio:      { r: 180, g: 220, b: 255 },
  // english aliases (el modelo 3B a veces mezcla idiomas)
  red:       { r: 255, g: 0,   b: 0 },
  blue:      { r: 0,   g: 0,   b: 255 },
  green:     { r: 0,   g: 255, b: 0 },
  white:     { r: 255, g: 255, b: 255 },
  yellow:    { r: 255, g: 255, b: 0 },
  orange:    { r: 255, g: 165, b: 0 },
  purple:    { r: 128, g: 0,   b: 255 },
  pink:      { r: 255, g: 105, b: 180 },
  warm:      { r: 255, g: 200, b: 100 },
  cold:      { r: 180, g: 220, b: 255 },
};

export async function setDeviceColor(deviceKey, colorName) {
  const dev = DEVICES[deviceKey];
  if (!dev) throw new Error(`Dispositivo "${deviceKey}" no existe`);
  const c = COLORS[colorName.toLowerCase()];
  if (!c) throw new Error(`Color "${colorName}" no reconocido`);
  await turnOn(dev);
  await setColor(dev, c.r, c.g, c.b);
}

export { DEVICES, turnOn, turnOff, setColor, setBrightness };
