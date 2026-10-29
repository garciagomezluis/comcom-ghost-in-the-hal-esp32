const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');

const PORT = process.env.PORT || 3000;
const SERIAL_BAUD = Number(process.env.SERIAL_BAUD) || 115200;
const TICK_MS = 20; // 50 Hz
const TELEMETRY_EVERY = 5; // ticks -> 10 Hz hacia el navegador
const MAX_KGF = Number(process.env.MAX_KGF) || 1500;
const VALID_STATES = new Set(['subir', 'bajar', 'descansar', 'enganchar', 'caer', 'fin']);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules/chart.js/dist')));

// ---------- Estado compartido ----------
let state = 'descansar';
let baseTension = 0;
let noiseAmp = 0.2; // kgf, ruido máximo ± sobre la base; lo fija el frontend según la fase
let boardStatus = null; // último @S recibido del ESP32: { estado, motor, ultimoCmd }

io.on('connection', (socket) => {
  socket.emit('serial', { connected: serialConnected });
  if (boardStatus) socket.emit('board:status', boardStatus);
  socket.on('reset', () => {
    console.log('[reset]');
    boardStatus = null;
    io.emit('board:reset');
    sendSerial('R\n');
  });
  socket.on('state', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const base = Number(msg.base);
    if (Number.isFinite(base)) baseTension = Math.min(MAX_KGF, Math.max(0, base));
    const noise = Number(msg.noise);
    if (Number.isFinite(noise)) noiseAmp = Math.min(10, Math.max(0, noise));
    if (VALID_STATES.has(msg.state) && msg.state !== state) {
      state = msg.state;
      console.log(`[estado] ${state}`);
    }
  });
});

// ---------- Fidelidad física abstracta (ruido de Perlin 1D + sinusoide) ----------
const PERM = (() => {
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return [...p, ...p];
})();

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const grad = (hash, x) => ((hash & 1) === 0 ? x : -x);

function perlin1D(x) {
  const xi = Math.floor(x) & 255;
  const xf = x - Math.floor(x);
  const a = grad(PERM[xi], xf);
  const b = grad(PERM[xi + 1], xf - 1);
  return 2 * (a + (b - a) * fade(xf)); // aprox. [-1, 1]
}

const sinePhase = Math.random() * Math.PI * 2;

function applyRopeNoise(base, t, amp) {
  // Frecuencia modulada lentamente para que no sea una oscilación periódica evidente.
  const freq = 4 + 1.5 * perlin1D(t * 0.3 + 100);
  const unit = 0.6 * perlin1D(t * 2.5) + 0.4 * Math.sin(sinePhase + 2 * Math.PI * freq * t);
  const noise = amp * Math.max(-1, Math.min(1, unit));
  return Math.min(MAX_KGF, Math.max(0, base + noise));
}

// ---------- Puerto serie con reconexión ----------
let port = null;
let serialConnected = false;
let serialPath = '';

// Un ESP32 aparece como ttyUSB* (chip CP210x/CH340) o ttyACM* (USB nativo); SERIAL_PATH fuerza una ruta.
function resolveSerialPath() {
  if (process.env.SERIAL_PATH) return process.env.SERIAL_PATH;
  const dev = fs.readdirSync('/dev').filter((n) => /^tty(USB|ACM)\d+$/.test(n)).sort()[0];
  return dev ? `/dev/${dev}` : '/dev/ttyUSB0';
}

function setSerialStatus(connected) {
  if (connected === serialConnected) return;
  serialConnected = connected;
  console.log(`[serial] ${connected ? 'conectado' : 'desconectado'} (${serialPath})`);
  io.emit('serial', { connected });
}

// ---------- Tramas del ESP32 (ESP32 -> servidor) ----------
// @S <estado> <motor> <ultimo_cmd>   estado completo
// @E <evento> [info]                 aviso puntual (CAIDA, EMERGENCIA, ...)
// Cualquier línea que no empiece con '@' es log y se ignora.
function parseInfo(parts) {
  const data = {};
  parts.forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) data[p.slice(0, i)] = Number.isFinite(Number(p.slice(i + 1))) ? Number(p.slice(i + 1)) : p.slice(i + 1);
  });
  return data;
}

function handleBoardLine(raw) {
  const line = raw.trim();
  if (!line.startsWith('@')) return;
  const [tag, ...parts] = line.split(/\s+/);

  if (tag === '@S') {
    const [estado, motor, ultimoCmd] = parts;
    if (!estado) return;
    boardStatus = { estado, motor: motor ?? null, ultimoCmd: ultimoCmd ?? null };
    console.log(`[esp32] estado=${estado} motor=${boardStatus.motor} ultimo_cmd=${boardStatus.ultimoCmd}`);
    io.emit('board:status', boardStatus);
  } else if (tag === '@E') {
    const [evento, ...info] = parts;
    if (!evento) return;
    const event = { evento, info: info.join(' '), data: parseInfo(info) };
    console.log(`[esp32] evento=${evento}${event.info ? ` ${event.info}` : ''}`);
    io.emit('board:event', event);
  }
}

let rxBuffer = '';
function onSerialData(chunk) {
  rxBuffer += chunk.toString('utf8');
  const lines = rxBuffer.split(/\r?\n/);
  rxBuffer = lines.pop().slice(-512); // resto sin salto de línea; acotado por si llega basura
  lines.forEach(handleBoardLine);
}

function openSerial() {
  serialPath = resolveSerialPath();
  port = new SerialPort({ path: serialPath, baudRate: SERIAL_BAUD, autoOpen: false });
  rxBuffer = '';
  port.on('data', onSerialData);
  port.on('error', (err) => console.warn(`[serial] error: ${err.message}`));
  port.on('close', () => {
    setSerialStatus(false);
    setTimeout(openSerial, 3000);
  });
  port.open((err) => {
    if (err) {
      console.warn(`[serial] no se pudo abrir ${serialPath}: ${err.message}. Reintentando en 3s (modo simulado)`);
      setTimeout(openSerial, 3000);
      return;
    }
    setSerialStatus(true);
  });
}

function sendSerial(line) {
  // Si el buffer se acumula (ESP32 lento) se descarta el frame en vez de generar latencia.
  if (!port || !port.isOpen || port.writableLength > 256) return;
  port.write(line, (err) => {
    if (err) console.warn(`[serial] write: ${err.message}`);
  });
}

// ---------- Loop de hardware a 50 Hz (auto-corregido contra drift) ----------
let tick = 0;
const startedAt = process.hrtime.bigint();
const nowMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;

function hardwareLoop() {
  const t = tick * (TICK_MS / 1000);
  const value = Number(applyRopeNoise(baseTension, t, noiseAmp).toFixed(2));

  console.log(value, "*******");

  sendSerial(`T ${tick} ${value.toFixed(2)}\n`);

  if (tick % TELEMETRY_EVERY === 0) io.emit('telemetry', { value });

  tick++;
  const delay = Math.max(0, tick * TICK_MS - nowMs());
  setTimeout(hardwareLoop, delay);
}

openSerial();
hardwareLoop();

server.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
