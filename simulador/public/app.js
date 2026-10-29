const socket = io();

const LABELS = { subir: 'Subiendo', bajar: 'Bajando', descansar: 'Descansando', enganchar: 'Enganchando', caer: 'Cayendo', fin: 'Meta alcanzada' };
// Tensión en kgf para 70 kg. Solo colgado y bajando escalan con la masa; subir, enganchar y picos de caída son fijos
// porque la placa tiene el peso fijado en 70 kg y su umbral de caída es 68.25 kgf.
let bodyMass = 70; // kg
const FLOOR_KGF = 0; // quieto en el piso
const CLIMB_KGF = 3.5;
const CLIMB_RIPPLE = 0.5; // oscilación rítmica al subir
const HANG_RATIO = 0.65; // colgado: 45.5 kgf con 70 kg
const DOWN_RATIO = 45 / 70; // bajando: 45 kgf con 70 kg
const CLIP_RISE = 9; // pico del enganche = nivel previo + 9 (12.5 al subir)
const IMPACT_MIN = 90; // pico de impacto según altura caída: 90 kgf (corta) a 140 kgf (>= IMPACT_DROP_MAX)
const IMPACT_MAX = 140;
const IMPACT_DROP_MAX = 5; // m
const IMPACT_HOLD = 0.2; // s que dura el pico
const REBOUND_PERIOD = 0.5; // s
const REBOUND_TAU = 0.92; // s: ~20 kgf -> 3 kgf en 1.75 s
const REBOUND_MAX = 20; // kgf, amplitud del primer rebote
const REBOUND_CEIL = 65; // el rebote más el ruido (±3) nunca pasa de 68 kgf
const REBOUND_DURATION = 2.0; // s tras el pico
const FIRST_UP = Math.exp((-0.75 * REBOUND_PERIOD) / REBOUND_TAU); // factor de la primera subida del rebote
const NOISE = { floor: 0.2, climb: 1, hang: 3, impact: 1 }; // amplitudes de ruido, kgf
const MIN_HEIGHT = 0.05;

// Unidades del mundo: metros. Altura 0 = pies del escalador en el suelo.
const GRAVITY = 9.8; // m/s²
// Secuencia de enganche en tiempo de referencia (s); el enganche real dura CLIP_MIN..CLIP_MAX y se escala.
const CLIP_MIN = 0.5;
const CLIP_MAX = 1.5;
const CLIP_GRAB = 0.5;
const CLIP_LIFT_END = 1.6;
const CLIP_AT = 1.75;
const CLIP_HOLD_END = 2.0;
const CLIP_DURATION = 2.4;
const HOOK_MIN = 0.9; // alcance de la mano: gancho entre pies+0.9 y pies+1.95 m
const HOOK_MAX = 1.95;
const CLIMB_SPEED = 0.3; // m/s
const DOWN_SPEED = 0.25; // m/s
const REACH = 1.8; // alcance de las manos sobre los pies
const HIP = 0.9; // cadera sobre los pies
const FINISH_AHEAD = 5; // m por encima de las manos al agregar el tope

const WALL_W = 1.2;
const MACHINE_GAP = 1.0; // pared -> máquina
const MACHINE_W = 0.5;
const MACHINE_H = 0.6;
const CLIMBER_DX = 0.45; // pared -> cadera
const DRAW_DX = 0.08;
const MARGIN = 0.5; // m de suelo visibles bajo la cota 0

const EMIT_MS = 40;
const SAMPLE_MS = 50;
const CHART_POINTS = 300; // 15 s

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function newSim() {
  return {
    state: 'descansar', prevState: 'descansar', stateTime: 0, clock: 0,
    base: FLOOR_KGF,
    y: 0, // altura de los pies, sin límite superior salvo el tope
    phase: 0,
    draws: [], // alturas (m) de los ganchos ya clipeados (ganchos fijos cada 1 m)
    clipHook: null, clipDone: false, clipLvl: 0, clipDur: 2.4,
    restFall: 0, impact: 0,
    restTarget: 0, freeFall: false, vel: 0, catching: false, catchT: 0, lean: 0,
    finishH: null, // altura del tope; null = muro infinito
    camY: 0, vib: 0, spool: 0,
  };
}
let sim = newSim();

const isBusy = () => sim.state === 'caer' || sim.state === 'enganchar' || sim.state === 'fin' || sim.freeFall;

// Primer gancho sin clipear al alcance de la mano; null si no hay ninguno.
function findHook() {
  for (let h = Math.max(1, Math.ceil(sim.y + HOOK_MIN - 1e-6)); h <= sim.y + HOOK_MAX; h++) {
    if (sim.finishH !== null && h >= sim.finishH - 0.3) return null;
    if (!sim.draws.includes(h)) return h;
  }
  return null;
}

const smooth = (u) => { const k = clamp(u, 0, 1); return k * k * (3 - 2 * k); };

// Al caer desde encima del último punto de anclaje (gancho o, sin ganchos, la máquina) la caída es el doble de esa altura.
function fallInfo(y) {
  const anchor = sim.draws.length ? Math.max(...sim.draws) : MACHINE_H;
  const above = y + HIP - anchor;
  return { drop: Math.min(Math.max(0, 2 * above), y) };
}

const onFloor = () => sim.y <= MIN_HEIGHT;
const hangLevel = () => HANG_RATIO * bodyMass;

// Tensión estacionaria de cada estado; también es el punto de partida del enganche.
function levelFor(state) {
  switch (state) {
    case 'subir': return CLIMB_KGF;
    case 'bajar': return DOWN_RATIO * bodyMass;
    case 'descansar': return onFloor() ? FLOOR_KGF : hangLevel();
    default: return FLOOR_KGF;
  }
}

// Tiempo de referencia (2.4 s) del enganche, escalado a su duración real.
const clipT = () => sim.stateTime * (CLIP_DURATION / sim.clipDur);

// Primer rebote acotado para que rebote + ruido nunca llegue al umbral de caída de la placa.
const reboundAmp = () => clamp((REBOUND_CEIL - hangLevel()) / FIRST_UP, 0, REBOUND_MAX);

function catchTension() {
  const u = sim.catchT - IMPACT_HOLD;
  if (u < 0) return sim.impact;
  return Math.max(0, hangLevel() - reboundAmp() * Math.exp(-u / REBOUND_TAU) * Math.sin((2 * Math.PI * u) / REBOUND_PERIOD));
}

function setState(next) {
  if (next === sim.state) return;
  if (next === 'enganchar') {
    const hook = findHook();
    if (hook === null) return;
    sim.prevState = ['subir', 'bajar', 'descansar'].includes(sim.state) ? sim.state : 'descansar';
    sim.clipHook = hook;
    sim.clipDone = false;
    sim.clipLvl = levelFor(sim.state);
    sim.clipDur = CLIP_MIN + Math.random() * (CLIP_MAX - CLIP_MIN);
  }
  sim.freeFall = false;
  sim.catching = false;
  if (next === 'caer' || next === 'descansar') {
    const info = fallInfo(sim.y);
    sim.restTarget = sim.y - info.drop;
    sim.freeFall = info.drop > 0.01;
    sim.restFall = info.drop;
    // Si cae hasta el piso no hay tirón de la cuerda.
    sim.impact = sim.restTarget > MIN_HEIGHT ? IMPACT_MIN + (IMPACT_MAX - IMPACT_MIN) * clamp(info.drop / IMPACT_DROP_MAX, 0, 1) : 0;
    sim.vel = 0;
  }
  sim.state = next;
  sim.stateTime = 0;
  updateUI();
}

// Caída/descanso: cuerda flotando (~0), pico de impacto, rebote que se apaga y queda colgado.
function baseTension() {
  switch (sim.state) {
    case 'subir': return CLIMB_KGF + CLIMB_RIPPLE * Math.sin(2 * Math.PI * 0.8 * sim.clock);
    case 'caer':
    case 'descansar':
      if (sim.freeFall) return FLOOR_KGF;
      if (sim.catching) return catchTension();
      return levelFor('descansar');
    case 'enganchar': {
      // Mantiene el nivel previo, sube al tirar la cuerda, pico al clipear y afloja a ~0.
      const t = clipT();
      if (t < CLIP_GRAB) return sim.clipLvl;
      if (t < CLIP_LIFT_END) return sim.clipLvl + 0.6 * CLIP_RISE * smooth((t - CLIP_GRAB) / (CLIP_LIFT_END - CLIP_GRAB));
      if (t < CLIP_HOLD_END) return sim.clipLvl + 0.6 * CLIP_RISE + 0.4 * CLIP_RISE * Math.exp(-(((t - CLIP_AT) / 0.12) ** 2));
      return FLOOR_KGF;
    }
    default: return levelFor(sim.state);
  }
}

// Amplitud del ruido (kgf) que el servidor aplica a la tensión; depende de la fase.
function noiseAmp() {
  switch (sim.state) {
    case 'subir':
    case 'bajar': return NOISE.climb;
    case 'enganchar': return clipT() >= CLIP_HOLD_END ? NOISE.floor : NOISE.climb;
    case 'caer':
    case 'descansar':
      if (sim.freeFall) return NOISE.floor;
      if (sim.catching) return sim.catchT < IMPACT_HOLD ? NOISE.impact : NOISE.hang;
      return onFloor() ? NOISE.floor : NOISE.hang;
    default: return NOISE.floor;
  }
}

function stepSim(dt) {
  const prevBase = sim.base;
  const prevY = sim.y;
  sim.clock += dt;
  sim.stateTime += dt;

  const target = baseTension();
  const fallingState = sim.state === 'caer' || sim.state === 'descansar';
  if (fallingState && sim.catching && !sim.freeFall) {
    sim.base = target;
  } else {
    const floorRamp = sim.state === 'descansar' && onFloor();
    const tau = sim.state === 'enganchar' ? 0.02 : sim.freeFall ? 0.03 : floorRamp ? 0.1 : 0.25;
    sim.base += (target - sim.base) * (1 - Math.exp(-dt / tau));
  }

  switch (sim.state) {
    case 'subir': {
      const speed = CLIMB_SPEED * (1 + 0.5 * Math.sin(2 * Math.PI * 0.8 * sim.clock));
      sim.y += speed * dt;
      sim.phase += dt * 5;
      if (sim.finishH !== null && sim.y + REACH >= sim.finishH) {
        sim.y = sim.finishH - REACH;
        setState('fin');
      }
      break;
    }
    case 'bajar':
      sim.y = Math.max(0, sim.y - DOWN_SPEED * dt);
      sim.phase += dt * 3;
      if (sim.y <= 0) setState('descansar');
      break;
    case 'caer':
    case 'descansar':
      if (sim.freeFall) {
        sim.vel += GRAVITY * dt;
        sim.y -= sim.vel * dt;
        if (sim.y <= sim.restTarget) {
          sim.y = sim.restTarget;
          sim.freeFall = false;
          sim.catching = sim.impact > 0;
          sim.catchT = 0;
          updateUI();
        }
      } else if (sim.catching) {
        sim.catchT += dt;
        // Estiramiento de la cuerda: crece durante el pico y rebota con el mismo período que la tensión.
        const k = 0.3 + 0.7 * clamp(sim.restFall / IMPACT_DROP_MAX, 0, 1);
        const u = sim.catchT - IMPACT_HOLD;
        const stretch = u < 0
          ? 0.2 * k * smooth(sim.catchT / IMPACT_HOLD)
          : 0.2 * k * Math.exp(-u / REBOUND_TAU) * Math.cos((2 * Math.PI * u) / REBOUND_PERIOD);
        sim.y = Math.max(0, sim.restTarget - stretch);
        if (u > REBOUND_DURATION) {
          sim.catching = false;
          sim.y = sim.restTarget;
          if (sim.state === 'caer') setState('descansar');
        }
      } else if (sim.state === 'caer') {
        setState('descansar');
      }
      break;
    case 'enganchar':
      if (!sim.clipDone && clipT() >= CLIP_AT) {
        sim.clipDone = true;
        sim.draws.push(sim.clipHook);
        sim.draws.sort((a, b) => a - b);
      }
      if (clipT() >= CLIP_DURATION) setState(sim.prevState);
      break;
  }

  // Tambor de la máquina: gira según la cuerda que entrega (sube) o recoge (baja).
  sim.spool -= (sim.y - prevY) / 0.17;
  // Vibración de la cuerda proporcional a la rapidez con que cambia la tensión.
  const rate = Math.abs(sim.base - prevBase) / dt;
  sim.vib = Math.max(sim.vib * Math.exp(-dt / 0.5), Math.min(1, rate / 120));

  const leanTarget = (sim.state === 'descansar' || sim.state === 'caer') && !sim.freeFall ? 0.12 : 0;
  sim.lean += (leanTarget - sim.lean) * (1 - Math.exp(-dt / 0.3));

  const span = view.H / view.scale - MARGIN;
  const camTarget = Math.max(0, sim.y + HIP - 0.4 * span);
  sim.camY += (camTarget - sim.camY) * (1 - Math.exp(-dt / 0.35));
}

// ---------- UI ----------
const buttons = document.querySelectorAll('button[data-state]');
const finishBtn = document.getElementById('btn-finish');
const resetBtn = document.getElementById('btn-reset');
const stateLabel = document.getElementById('state-label');
const baseValue = document.getElementById('base-value');
const heightValue = document.getElementById('height-value');
const finalValue = document.getElementById('final-value');

let lastAvailability = '';

// Acciones que solo tienen sentido en cierto contexto.
const DISABLED_HINT = {
  enganchar: 'No hay gancho al alcance: seguí subiendo',
  bajar: 'Solo se puede bajar con altura mayor a 0',
  caer: 'Solo se puede caer estando por encima del último gancho',
};
function canDo(state) {
  if (state === 'enganchar') return findHook() !== null;
  if (state === 'bajar') return sim.y > MIN_HEIGHT;
  if (state === 'caer') return fallInfo(sim.y).drop > MIN_HEIGHT;
  return true;
}
const availability = () => ['enganchar', 'bajar', 'caer'].map(canDo).join();

function updateUI() {
  stateLabel.textContent = LABELS[sim.state];
  const busy = isBusy();
  buttons.forEach((b) => {
    const st = b.dataset.state;
    b.classList.toggle('active', st === sim.state);
    b.disabled = busy ? st !== sim.state : st !== sim.state && !canDo(st);
    b.title = b.disabled && !busy ? DISABLED_HINT[st] || '' : '';
  });
  lastAvailability = availability();
  finishBtn.disabled = sim.finishH !== null || sim.state === 'fin';
  finishBtn.textContent = sim.finishH === null ? 'Agregar tope' : `Tope a ${sim.finishH} m`;
}

buttons.forEach((b) => b.addEventListener('click', () => {
  if (!isBusy() && canDo(b.dataset.state)) setState(b.dataset.state);
}));

finishBtn.addEventListener('click', () => {
  if (sim.finishH !== null) return;
  sim.finishH = Math.ceil(sim.y + REACH + FINISH_AHEAD);
  updateUI();
});

resetBtn.addEventListener('click', () => {
  sim = newSim();
  pendingBoardState = null;
  clearBoardPanel();
  socket.emit('reset');
  updateUI();
});

document.getElementById('mass').addEventListener('change', (e) => {
  bodyMass = clamp(Number(e.target.value) || 70, 50, 100);
  e.target.value = bodyMass;
});

function setBadge(id, ok) {
  const el = document.getElementById(id);
  el.classList.toggle('ok', ok);
  el.classList.toggle('off', !ok);
}

socket.on('connect', () => setBadge('ws-status', true));
socket.on('disconnect', () => setBadge('ws-status', false));
socket.on('serial', ({ connected }) => setBadge('serial-status', connected));
socket.on('telemetry', ({ value }) => { finalValue.textContent = `${value.toFixed(1)} kgf`; });

// Estado y eventos que reporta el ESP32 (el servidor los reenvía por el mismo socket).
const boardEvents = document.getElementById('board-events');
const MAX_BOARD_EVENTS = 20;

function clearBoardPanel() {
  ['board-estado', 'board-motor', 'board-cmd'].forEach((id) => { document.getElementById(id).textContent = '-'; });
  boardEvents.replaceChildren();
}
socket.on('board:reset', clearBoardPanel);

socket.on('board:status', ({ estado, motor, ultimoCmd }) => {
  document.getElementById('board-estado').textContent = estado ?? '-';
  document.getElementById('board-motor').textContent = motor ?? '-';
  document.getElementById('board-cmd').textContent = ultimoCmd ?? '-';
  // @S se repite con el mismo ultimo_cmd: solo se actúa cuando cambia.
  if (ultimoCmd && ultimoCmd !== lastBoardCmd) runBoardCommand(ultimoCmd);
  lastBoardCmd = ultimoCmd ?? null;
});

// Comandos del ESP32 que disparan las acciones que la botonera tiene ocultas.
const BOARD_COMMANDS = { BAJAME: 'bajar', TENSION: 'descansar' };
let lastBoardCmd = null;
let pendingBoardState = null;

function runBoardCommand(cmd) {
  const state = BOARD_COMMANDS[String(cmd).toUpperCase()];
  if (state) pendingBoardState = state;
}

// Se aplica apenas la simulación puede aceptarlo (no durante caída, enganche ni meta).
function applyPendingBoardCommand() {
  if (!pendingBoardState || isBusy()) return;
  if (canDo(pendingBoardState)) setState(pendingBoardState);
  pendingBoardState = null;
}

socket.on('board:event', ({ evento, info }) => {
  runBoardCommand(evento);
  const li = document.createElement('li');
  li.className = `ev-${String(evento).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString();
  li.append(time, info ? `${evento} ${info}` : evento);
  boardEvents.prepend(li);
  while (boardEvents.children.length > MAX_BOARD_EVENTS) boardEvents.lastChild.remove();
});

setInterval(() => {
  if (socket.connected) socket.emit('state', { state: sim.state, base: Number(sim.base.toFixed(2)), noise: noiseAmp() });
}, EMIT_MS);

// ---------- Gráfico ----------
const chart = new Chart(document.getElementById('chart'), {
  type: 'line',
  data: {
    labels: Array(CHART_POINTS).fill(''),
    datasets: [{
      label: 'Tensión base (kgf)',
      data: Array(CHART_POINTS).fill(null),
      borderColor: '#7fd1ff',
      backgroundColor: 'rgba(127,209,255,.15)',
      borderWidth: 2,
      pointRadius: 0,
      fill: true,
      tension: 0.2,
    }],
  },
  options: {
    maintainAspectRatio: false,
    animation: false,
    scales: {
      y: { beginAtZero: true, suggestedMax: 150, title: { display: true, text: 'Tensión (kgf)', color: '#aab' }, grid: { color: '#2a313c' }, ticks: { color: '#aab' } },
      x: { display: false },
    },
    plugins: {
      legend: { labels: { color: '#e6e9ee' } },
      tooltip: { callbacks: { label: (c) => `${c.parsed.y.toFixed(1)} kgf` } },
    },
  },
});

setInterval(() => {
  const data = chart.data.datasets[0].data;
  data.push(sim.base);
  data.shift();
  baseValue.textContent = `${sim.base.toFixed(1)} kgf`;
  heightValue.textContent = `${sim.y.toFixed(1)} m`;
  if (availability() !== lastAvailability) updateUI();
  chart.update('none');
}, SAMPLE_MS);

// ---------- Escena (canvas a pantalla completa del panel) ----------
const stage = document.getElementById('stage');
const canvas = document.getElementById('climber');
const ctx = canvas.getContext('2d');
const view = { W: 0, H: 0, scale: 100 };

function resize() {
  const r = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  view.W = r.width;
  view.H = r.height;
  // ~9 m visibles de alto, y el conjunto pared + máquina (2.9 m) siempre entra a lo ancho.
  view.scale = Math.max(20, Math.min(r.height / 9, r.width / 2.9));
}
new ResizeObserver(resize).observe(stage);
resize();

const X = (m) => m * view.scale;
const Y = (h) => view.H - (MARGIN + h - sim.camY) * view.scale;

const rnd = (n) => { const v = Math.sin(n * 127.1) * 43758.5453; return v - Math.floor(v); };
const HOLD_COLORS = ['#e0a458', '#d35d6e', '#6bbf59', '#5aa9e6', '#c8b6ff'];

function drawWall() {
  const s = view.scale;
  const top = sim.finishH !== null ? Y(sim.finishH) : -10;
  const camTop = sim.camY + view.H / s;
  const wallX = X(WALL_W);

  ctx.fillStyle = '#6b4f3a';
  ctx.fillRect(0, top, wallX, Y(0) - top);

  // Paneles
  ctx.strokeStyle = 'rgba(0,0,0,.25)';
  ctx.lineWidth = 1;
  for (let k = Math.floor(sim.camY / 1.2); k * 1.2 <= camTop; k++) {
    const h = k * 1.2;
    if (sim.finishH !== null && h > sim.finishH) break;
    ctx.beginPath(); ctx.moveTo(0, Y(h)); ctx.lineTo(wallX, Y(h)); ctx.stroke();
  }

  // Presas
  for (let k = Math.max(0, Math.floor(sim.camY / 0.4) - 1); k * 0.4 <= camTop + 0.4; k++) {
    const h = k * 0.4 + 0.3;
    if (sim.finishH !== null && h > sim.finishH - 0.1) break;
    for (let j = 0; j < 2; j++) {
      const n = k * 2 + j;
      ctx.fillStyle = HOLD_COLORS[Math.floor(rnd(n + 7) * HOLD_COLORS.length)];
      ctx.beginPath();
      ctx.arc((0.08 + rnd(n) * 0.84) * wallX, Y(h + rnd(n + 3) * 0.3), (0.025 + rnd(n + 5) * 0.025) * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Regla de altura
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = 'rgba(255,255,255,.7)';
  ctx.font = `${Math.max(10, 0.1 * s)}px system-ui`;
  ctx.textAlign = 'left';
  for (let m = Math.max(0, Math.ceil(sim.camY)); m <= camTop; m++) {
    if (sim.finishH !== null && m > sim.finishH) break;
    const major = m % 5 === 0;
    ctx.beginPath(); ctx.moveTo(wallX, Y(m)); ctx.lineTo(wallX - (major ? 0.2 : 0.1) * s, Y(m)); ctx.stroke();
    if (major) ctx.fillText(`${m} m`, 4, Y(m) - 3);
  }
}

function drawFinish() {
  if (sim.finishH === null) return;
  const s = view.scale;
  const y = Y(sim.finishH);
  const w = X(WALL_W + 0.3);
  const bh = 0.12 * s;
  for (let x = 0; x < w; x += bh * 2) {
    ctx.fillStyle = '#f1c40f';
    ctx.fillRect(x, y - bh, Math.min(bh, w - x), bh);
    ctx.fillStyle = '#222';
    ctx.fillRect(x + bh, y - bh, Math.min(bh, Math.max(0, w - x - bh)), bh);
  }
  ctx.fillStyle = '#f1c40f';
  ctx.font = `bold ${Math.max(12, 0.16 * s)}px system-ui`;
  ctx.textAlign = 'left';
  ctx.fillText(`META ${sim.finishH} m`, 6, y - bh - 6);
}

function drawGround() {
  const y = Y(0);
  if (y >= view.H) return;
  ctx.fillStyle = '#3b4a38';
  ctx.fillRect(0, y, view.W, view.H - y);
}

const tensionColor = () => `hsl(${200 - 200 * clamp(sim.base / 140, 0, 1)} 85% 60%)`;

const kiwi = new Image();
kiwi.src = 'kiwi.png';

// Ramas del árbol en unidades del árbol (x desde el eje del tronco, h sobre el suelo); cada una puede llevar un kiwi.
const TREE_BRANCHES = [
  { from: [-0.1, 1.7], to: [-1.3, 1.95], kiwi: { at: -0.75, w: 1.0, flip: false } },
  { from: [-0.1, 3.0], to: [-1.0, 3.3], kiwi: { at: -0.6, w: 0.8, flip: false } },
  { from: [0.1, 2.3], to: [1.0, 2.75], kiwi: { at: 0.55, w: 0.8, flip: true } },
];
const TREE_TWIGS = [[-0.6, 1.78, -0.8, 1.5], [-0.5, 3.12, -0.7, 2.9], [0.6, 2.55, 0.82, 2.3], [0.1, 3.4, 0.4, 3.75]];
const TREE_LEAVES = [['#2e7d32', 0, 4.7, 0.95], ['#388e3c', -0.65, 4.35, 0.55], ['#43a047', 0.6, 4.45, 0.6], ['#388e3c', -0.1, 5.3, 0.6], ['#43a047', 0.9, 3.7, 0.4]];

// Árbol decorativo al borde derecho, a la derecha de la máquina; se omite si no hay espacio libre.
function drawTree() {
  const s = view.scale;
  const xL = X(WALL_W + MACHINE_GAP + MACHINE_W + 0.25);
  const xR = view.W - 0.1 * s;
  if (xR - xL < 0.9 * s) return;
  const ts = Math.min(1.3 * s, (xR - xL) / 2.45);
  const g = Y(0);
  if (g <= 0 || g - 6 * ts >= view.H) return;

  const tx = xR - 1.1 * ts;
  const P = (x, h) => [tx + x * ts, g - h * ts];

  ctx.fillStyle = '#6d4c41';
  ctx.beginPath();
  ctx.moveTo(...P(-0.2, 0));
  ctx.lineTo(...P(0.2, 0));
  ctx.lineTo(...P(0.12, 4.2));
  ctx.lineTo(...P(-0.12, 4.2));
  ctx.closePath();
  ctx.fill();

  const bw = 0.11 * ts;
  ctx.strokeStyle = '#6d4c41';
  ctx.lineCap = 'round';
  ctx.lineWidth = bw;
  TREE_BRANCHES.forEach((b) => { ctx.beginPath(); ctx.moveTo(...P(...b.from)); ctx.lineTo(...P(...b.to)); ctx.stroke(); });
  ctx.lineWidth = bw * 0.5;
  TREE_TWIGS.forEach(([x1, h1, x2, h2]) => { ctx.beginPath(); ctx.moveTo(...P(x1, h1)); ctx.lineTo(...P(x2, h2)); ctx.stroke(); });

  const leaves = [
    ...TREE_LEAVES,
    ...TREE_BRANCHES.map((b) => ['#43a047', b.to[0], b.to[1] + 0.05, 0.14]),
    ...TREE_TWIGS.map((t) => ['#388e3c', t[2], t[3], 0.1]),
  ];
  leaves.forEach(([color, x, h, r]) => {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(...P(x, h), r * ts, 0, Math.PI * 2); ctx.fill();
  });

  if (!(kiwi.complete && kiwi.naturalWidth)) return;
  TREE_BRANCHES.forEach(({ from, to, kiwi: k }) => {
    const w = k.w * ts;
    const h = (w * kiwi.naturalHeight) / kiwi.naturalWidth;
    const hAt = from[1] + ((to[1] - from[1]) * (k.at - from[0])) / (to[0] - from[0]);
    const [cx, by] = P(k.at, hAt);
    ctx.save();
    ctx.translate(cx, by - bw / 2 + 0.04 * ts);
    if (k.flip) ctx.scale(-1, 1);
    ctx.drawImage(kiwi, -w / 2, -h, w, h);
    ctx.restore();
  });
}

function drawMachine() {
  const s = view.scale;
  const x0 = X(WALL_W + MACHINE_GAP);
  const w = MACHINE_W * s;
  const h = MACHINE_H * s;
  const y0 = Y(0) - h;
  if (y0 > view.H) return;

  // Cota de 1 m entre pared y máquina
  const dy = Y(0) + 0.25 * s;
  ctx.strokeStyle = '#cfd8dc';
  ctx.fillStyle = '#cfd8dc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(X(WALL_W), dy); ctx.lineTo(x0, dy);
  ctx.moveTo(X(WALL_W), dy - 5); ctx.lineTo(X(WALL_W), dy + 5);
  ctx.moveTo(x0, dy - 5); ctx.lineTo(x0, dy + 5);
  ctx.stroke();
  ctx.font = `${Math.max(10, 0.1 * s)}px system-ui`;
  ctx.textAlign = 'center';
  ctx.fillText('1,00 m', (X(WALL_W) + x0) / 2, dy + 0.14 * s);

  ctx.fillStyle = '#37474f';
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = '#90a4ae';
  ctx.lineWidth = 2;
  ctx.strokeRect(x0, y0, w, h);

  // Tambor
  const cx = x0 + w * 0.58;
  const cy = y0 + h * 0.55;
  const r = 0.17 * s;
  ctx.fillStyle = '#263238';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = sim.spool + (i * 2 * Math.PI) / 3;
    ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  ctx.stroke();

  // LED de tensión y polea de salida
  ctx.fillStyle = tensionColor();
  ctx.beginPath(); ctx.arc(x0 + w - 0.07 * s, y0 + 0.07 * s, 0.035 * s, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#cfd8dc';
  ctx.beginPath(); ctx.arc(X(ropeStart().x), Y(ropeStart().y), 0.03 * s, 0, Math.PI * 2); ctx.fill();
  ctx.font = `${Math.max(9, 0.075 * s)}px system-ui`;
  ctx.textAlign = 'center';
  ctx.fillText('MÁQUINA', x0 + w / 2, Y(0) + 0.39 * s);
}

const ropeStart = () => ({ x: WALL_W + MACHINE_GAP + 0.04, y: MACHINE_H });

function drawDraws() {
  const s = view.scale;
  const x = X(WALL_W + DRAW_DX);
  const camTop = sim.camY + view.H / s;
  const next = isBusy() ? sim.clipHook : findHook();
  ctx.lineWidth = 2;
  for (let h = Math.max(1, Math.ceil(sim.camY - 0.5)); h <= camTop + 0.5; h++) {
    if (sim.finishH !== null && h >= sim.finishH - 0.3) break;
    const y = Y(h);
    const clipped = sim.draws.includes(h);
    ctx.fillStyle = clipped ? '#f1c40f' : '#90a4ae';
    ctx.strokeStyle = clipped ? '#b7950b' : '#546e7a';
    ctx.beginPath(); ctx.arc(x, y, 0.045 * s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (h === next && !clipped) {
      ctx.strokeStyle = '#2ecc71';
      ctx.beginPath(); ctx.arc(x, y, 0.09 * s, 0, Math.PI * 2); ctx.stroke();
    }
  }
}

// Posición de la mano que clipea y si en ese instante sostiene un seno de cuerda.
function clipHand() {
  const cx = climberX();
  const hip = sim.y + HIP;
  const t = clipT();
  const rest = { x: WALL_W + 0.03, y: hip + 0.75 };
  const waist = { x: cx, y: hip + 0.05 };
  const hook = { x: WALL_W + DRAW_DX, y: sim.clipHook };
  const mix = (a, b, u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
  if (t < CLIP_GRAB) return { pos: mix(rest, waist, smooth(t / CLIP_GRAB)), holding: false };
  if (t < CLIP_LIFT_END) return { pos: mix(waist, hook, smooth((t - CLIP_GRAB) / (CLIP_LIFT_END - CLIP_GRAB))), holding: true };
  if (t < CLIP_HOLD_END) return { pos: hook, holding: t < CLIP_AT };
  return { pos: mix(hook, rest, smooth((t - CLIP_HOLD_END) / (CLIP_DURATION - CLIP_HOLD_END))), holding: false };
}

function drawRope() {
  const slack = clamp(1 - Math.sqrt(sim.base / 45), 0, 1);
  const t = clamp(sim.base / 140, 0, 1);
  const hip = sim.y + HIP;
  const pts = [ropeStart(), ...sim.draws.map((d) => ({ x: WALL_W + DRAW_DX, y: d }))];
  if (sim.state === 'enganchar') {
    const hand = clipHand();
    if (hand.holding) pts.push(hand.pos);
  }
  pts.push({ x: climberX(), y: hip + 0.05 });

  ctx.strokeStyle = tensionColor();
  ctx.lineWidth = 2 + 3 * t;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(X(pts[0].x), Y(pts[0].y));

  const vibAmp = sim.vib * 0.07;
  const SAMPLES = 20;
  for (let i = 0; i < pts.length - 1; i++) {
    const A = pts[i];
    const B = pts[i + 1];
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const ux = dx / L;
    const uy = dy / L;
    // Gravedad (con sesgo hacia afuera del muro) proyectada sobre la normal del tramo.
    const g = { x: 0.6, y: -0.8 };
    const gd = g.x * ux + g.y * uy;
    const px = g.x - gd * ux;
    const py = g.y - gd * uy;
    const pm = Math.hypot(px, py) || 1;
    const sag = Math.min(0.3 * L, 1.0) * slack;
    const cxm = (A.x + B.x) / 2 + px * sag * 2;
    const cym = (A.y + B.y) / 2 + py * sag * 2;
    const nx = px / pm;
    const ny = py / pm;

    for (let k = 1; k <= SAMPLES; k++) {
      const u = k / SAMPLES;
      const a = (1 - u) * (1 - u);
      const b = 2 * u * (1 - u);
      const c = u * u;
      let x = a * A.x + b * cxm + c * B.x;
      let y = a * A.y + b * cym + c * B.y;
      const wave = Math.sin(Math.PI * u) * Math.sin(2 * Math.PI * 7 * sim.clock)
        + 0.5 * Math.sin(2 * Math.PI * u) * Math.sin(2 * Math.PI * 11 * sim.clock);
      x += nx * vibAmp * wave;
      y += ny * vibAmp * wave;
      ctx.lineTo(X(x), Y(y));
    }
  }
  ctx.stroke();
}

const climberX = () => WALL_W + CLIMBER_DX + sim.lean + (sim.state === 'subir' || sim.state === 'bajar' ? 0 : Math.sin(sim.clock * 2) * 0.03);

// IK de dos huesos: devuelve la articulación (codo/rodilla) y el extremo alcanzado.
function ik(root, target, l1, l2, pref) {
  const dx = target.x - root.x;
  const dy = target.y - root.y;
  const d = Math.hypot(dx, dy) || 1e-6;
  const dc = clamp(d, Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const ux = dx / d;
  const uy = dy / d;
  const a = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const sign = -uy * pref.x + ux * pref.y >= 0 ? 1 : -1;
  return {
    joint: { x: root.x + ux * a - uy * h * sign, y: root.y + uy * a + ux * h * sign },
    end: { x: root.x + ux * dc, y: root.y + uy * dc },
  };
}

const ARM = 0.33; // largo de brazo y antebrazo
const LEG = 0.5; // largo de muslo y pantorrilla
const lerpPt = (a, b, u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });

function drawClimber() {
  const s = view.scale;
  const cx = climberX();
  const hip = sim.y + HIP;
  const face = WALL_W + 0.03;
  const swing = Math.sin(sim.phase);
  const moving = sim.state === 'subir' || sim.state === 'bajar';
  const P = (p) => [X(p.x), Y(p.y)];

  const hipP = { x: cx, y: hip };
  const shoulder = { x: cx - 0.02 - sim.lean * 0.8, y: hip + 0.5 };

  // Extremos objetivo (manos y pies); far = lado más lejano a la cámara.
  let handFar; let handNear; let footFar; let footNear;
  let elbowPref = { x: 1, y: -1 };

  const f = Math.sin(sim.clock * 9) * 0.1;
  const flail = {
    handFar: { x: cx - 0.4, y: hip + 1.15 + f },
    handNear: { x: cx + 0.4, y: hip + 1.05 - f },
    footFar: { x: cx - 0.2, y: hip - 1.0 + f },
    footNear: { x: cx + 0.1, y: hip - 1.0 - f },
  };
  // Colgado del arnés: recostado, brazos sueltos y pies apoyados en el muro.
  const limp = {
    handFar: { x: cx - 0.12, y: hip - 0.05 },
    handNear: { x: cx + 0.1, y: hip - 0.1 },
    footFar: { x: face + 0.08, y: hip - 0.75 },
    footNear: { x: face + 0.1, y: hip - 0.62 },
  };

  let pose = null;
  if (sim.freeFall) {
    pose = flail;
    elbowPref = { x: 0, y: -1 };
  } else if (sim.state === 'caer') {
    // Tras el tir\u00f3n de la cuerda deja de agitarse: las extremidades "latiguean" y se relajan.
    const tw = sim.catchT;
    const b = smooth(tw / 0.4);
    const w = Math.exp(-4 * tw) * Math.sin(2 * Math.PI * 2.5 * tw);
    const whip = (p, dx, dy) => ({ x: p.x + dx * w, y: p.y + dy * w });
    pose = {
      handFar: whip(lerpPt(flail.handFar, limp.handFar, b), -0.12, 0.3),
      handNear: whip(lerpPt(flail.handNear, limp.handNear, b), 0.12, 0.3),
      footFar: whip(lerpPt(flail.footFar, limp.footFar, b), -0.08, 0.25),
      footNear: whip(lerpPt(flail.footNear, limp.footNear, b), 0.08, 0.25),
    };
    elbowPref = { x: 0.5, y: -1 };
  } else if (sim.state === 'descansar') {
    pose = limp;
  }

  if (pose) {
    ({ handFar, handNear, footFar, footNear } = pose);
  } else {
    handFar = { x: face, y: moving ? hip + 0.95 + 0.2 * swing : hip + 0.95 };
    handNear = { x: face, y: moving ? hip + 0.78 - 0.2 * swing : hip + 0.78 };
    footFar = { x: face + 0.08, y: moving ? hip - 0.85 + 0.25 * (0.5 + 0.5 * swing) : hip - 0.82 };
    footNear = { x: face + 0.08, y: moving ? hip - 0.85 + 0.25 * (0.5 - 0.5 * swing) : hip - 0.7 };
    if (sim.state === 'enganchar') handNear = clipHand().pos;
  }
  const kneePref = { x: -1, y: 0.2 };

  const farArm = ik(shoulder, handFar, ARM, ARM, elbowPref);
  const nearArm = ik(shoulder, handNear, ARM, ARM, elbowPref);
  const farLeg = ik(hipP, footFar, LEG, LEG, kneePref);
  const nearLeg = ik(hipP, footNear, LEG, LEG, kneePref);

  const limbW = Math.max(3, 0.045 * s);
  const limb = (root, r, color) => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(...P(root)); ctx.lineTo(...P(r.joint)); ctx.lineTo(...P(r.end));
    ctx.stroke();
  };
  const dot = (p, r, color) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(...P(p), r, 0, Math.PI * 2); ctx.fill(); };

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = limbW;

  // Miembros lejanos, tronco y cabeza, miembros cercanos.
  limb(hipP, farLeg, '#2e86ab');
  limb(shoulder, farArm, '#2e86ab');

  ctx.strokeStyle = '#4fc3f7';
  ctx.lineWidth = limbW * 1.5;
  ctx.beginPath(); ctx.moveTo(...P(hipP)); ctx.lineTo(...P(shoulder)); ctx.stroke();
  ctx.lineWidth = limbW * 0.6;
  ctx.beginPath(); ctx.moveTo(...P(shoulder)); ctx.lineTo(...P({ x: shoulder.x - 0.02, y: hip + 0.6 })); ctx.stroke();
  dot({ x: shoulder.x - 0.02, y: hip + 0.7 }, 0.1 * s, '#ffe0b2');

  ctx.lineWidth = limbW;
  limb(hipP, nearLeg, '#4fc3f7');
  limb(shoulder, nearArm, '#4fc3f7');

  // Articulaciones y extremos
  [farArm, nearArm, farLeg, nearLeg].forEach((l) => dot(l.joint, 0.03 * s, '#e1f5fe'));
  dot(shoulder, 0.035 * s, '#e1f5fe');
  dot(hipP, 0.035 * s, '#e1f5fe');
  [farArm.end, nearArm.end].forEach((p) => dot(p, 0.035 * s, '#ffe0b2'));
  [farLeg.end, nearLeg.end].forEach((p) => dot(p, 0.04 * s, '#455a64'));

  // Arnés
  ctx.fillStyle = '#ff5d73';
  ctx.fillRect(...P({ x: cx - 0.06, y: hip + 0.06 }), 0.12 * s, 0.09 * s);
}

function drawEndOverlay() {
  if (sim.state !== 'fin') return;
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.fillRect(0, 0, view.W, view.H);
  ctx.fillStyle = '#f1c40f';
  ctx.textAlign = 'center';
  ctx.font = `bold ${Math.max(18, view.W * 0.07)}px system-ui`;
  ctx.fillText('META ALCANZADA', view.W / 2, view.H * 0.3);
  ctx.fillStyle = '#fff';
  ctx.font = `${Math.max(12, view.W * 0.035)}px system-ui`;
  ctx.fillText('Simulación finalizada', view.W / 2, view.H * 0.3 + view.W * 0.06);
}

function drawScene() {
  ctx.fillStyle = '#243040';
  ctx.fillRect(0, 0, view.W, view.H);
  drawWall();
  drawFinish();
  drawGround();
  drawTree();
  drawMachine();
  drawDraws();
  drawRope();
  drawClimber();
  drawEndOverlay();
}

// ---------- Loop principal ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (dt > 0) stepSim(dt);
  applyPendingBoardCommand();
  drawScene();
  requestAnimationFrame(frame);
}

updateUI();
requestAnimationFrame(frame);
