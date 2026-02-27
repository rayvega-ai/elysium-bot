'use strict';

const bedrock = require('bedrock-protocol');
const express = require('express');

/* ---------------- CONFIG FROM ENV ---------------- */
const APP_PORT = process.env.PORT || 3000;
const MC_HOST = (process.env.MC_HOST || '').trim();
const MC_PORT = process.env.MC_PORT ? Number(process.env.MC_PORT) : NaN;

// Optional: base name (you can set BOT_NAME_BASE in env), and add suffix if ENABLE_NAME_SUFFIX != 'false'
const BOT_NAME_BASE = process.env.BOT_NAME_BASE || process.env.BOT_NAME || 'BedrockBot';
const ENABLE_NAME_SUFFIX = (process.env.ENABLE_NAME_SUFFIX || 'true').toLowerCase() !== 'false';
const BOT_NAME = ENABLE_NAME_SUFFIX ? `${BOT_NAME_BASE}_${Math.floor(Math.random() * 9000 + 1000)}` : BOT_NAME_BASE;

const RECONNECT_MODE = (process.env.RECONNECT_MODE || 'retry').toLowerCase();
const RETRY_INTERVAL_MS = process.env.RETRY_INTERVAL_MS ? Number(process.env.RETRY_INTERVAL_MS) : 30000;
const KEEPALIVE_MS = 60_000;

// New ENV params (defaults per spec)
const RECONNECT_DELAY_MS = process.env.RECONNECT_DELAY_MS ? Number(process.env.RECONNECT_DELAY_MS) : 60000;
const PATROL_STEP_SEC_MIN = process.env.PATROL_STEP_SEC_MIN ? Number(process.env.PATROL_STEP_SEC_MIN) : 3;
const PATROL_STEP_SEC_MAX = process.env.PATROL_STEP_SEC_MAX ? Number(process.env.PATROL_STEP_SEC_MAX) : 6;
const PATROL_TURN_SEC_MIN = process.env.PATROL_TURN_SEC_MIN ? Number(process.env.PATROL_TURN_SEC_MIN) : 15;
const PATROL_TURN_SEC_MAX = process.env.PATROL_TURN_SEC_MAX ? Number(process.env.PATROL_TURN_SEC_MAX) : 30;
const CHAT_INTERVAL_MS = process.env.CHAT_INTERVAL_MS
  ? Number(process.env.CHAT_INTERVAL_MS)
  : (180_000 + Math.floor(Math.random() * 120_000)); // 3–5 min default
const MAX_PATROL_DISTANCE = process.env.MAX_PATROL_DISTANCE ? Number(process.env.MAX_PATROL_DISTANCE) : 5;

const MC_VERSIONS = (process.env.MC_VERSIONS || '1.21.131,1.21.124,1.21.100')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const CHAT_MESSAGES = [
  'Я тут 👀',
  'Привет!',
  'Всё норм',
  'Сервер топ',
  'Ок'
];

if (!MC_HOST || Number.isNaN(MC_PORT)) {
  console.error('FATAL: MC_HOST and MC_PORT must be set in environment variables.');
  process.exit(1);
}

const app = express();
app.get('/', (req, res) => res.send('Bedrock bot: OK'));
app.listen(APP_PORT, () => console.log(`Express started on port ${APP_PORT}`));

/* ---------------- STATE ---------------- */
let client = null;
let keepAliveTimer = null;
let reconnectTimer = null;
let tryingIndex = 0;
let reconnectAttempts = 0;

let patrolStepTimer = null;   // timeouts (not intervals)
let patrolTurnTimer = null;
let chatTimer = null;

/* ---------------- POSITION STATE ---------------- */
let pos = { x: 0, y: 64, z: 0, pitch: 0, yaw: 0 };
let spawnPos = null;

/* ---------------- HELPERS ---------------- */
function currentVersion() {
  return MC_VERSIONS[tryingIndex] || MC_VERSIONS[0];
}

function safeClearTimeout(t) {
  try { if (t) clearTimeout(t); } catch (e) {}
}

function safeCloseClient() {
  stopHumanBehavior();

  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (client) {
    try { client.removeAllListeners && client.removeAllListeners(); } catch (e) {}
    try { client.close && client.close(); } catch (e) {}
    client = null;
  }
}

function shutdown(code = 1) {
  console.log(`Shutdown with code ${code}`);
  safeCloseClient();
  process.exit(code);
}

process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err?.stack || err);
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
  shutdown(1);
});
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

/* ---------------- RECONNECT / VERSION ROTATION ---------------- */
function scheduleReconnect(delay = RECONNECT_DELAY_MS) {
  if (reconnectTimer) return;
  reconnectAttempts = Math.min(reconnectAttempts + 1, 1000);
  // Exponential-ish backoff: base + attempts*5s, cap 5 minutes
  const dynamic = Math.min(delay + reconnectAttempts * 5000, 300000);
  console.log(`Scheduling reconnect in ${dynamic} ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWithCurrentVersion();
  }, dynamic);
}

function rotateVersionAndReconnect(reason) {
  console.warn(`Rotating protocol version due to: ${reason}`);
  tryingIndex = (tryingIndex + 1) % MC_VERSIONS.length;
  const didFullCycle = tryingIndex === 0;
  // if did full cycle, wait a bit longer
  scheduleReconnect(didFullCycle ? RECONNECT_DELAY_MS * 2 : 1000);
}

/* ---------------- RUNTIME ID helpers (BigInt-safe) ---------------- */
function getRuntimeIdRaw() {
  if (!client) return null;
  // Try multiple places where runtime id may exist
  return client.entity?.runtime_id ?? client.startGameData?.runtime_entity_id ?? client.entityId ?? null;
}
function getRuntimeId() {
  const id = getRuntimeIdRaw();
  if (id === null || typeof id === 'undefined') return null;
  try {
    if (typeof id === 'bigint') return id;
    // Some versions return string or number - coerce to BigInt safely
    if (typeof id === 'string') return BigInt(id);
    if (typeof id === 'number') return BigInt(Math.floor(id));
    // fallback
    return BigInt(id);
  } catch (e) {
    console.warn('getRuntimeId: cannot convert id to BigInt:', id, e?.message);
    return null;
  }
}

/* ---------------- SEND PACKETS (with strict types) ---------------- */
function sendMove(newPos) {
  const rid = getRuntimeId();
  if (!rid) {
    // runtime id not ready yet
    // console.debug('sendMove: no runtime id');
    return;
  }

  // Normalize numbers
  pos.x = Number(newPos.x ?? pos.x);
  pos.y = Number(newPos.y ?? pos.y);
  pos.z = Number(newPos.z ?? pos.z);
  pos.pitch = Number(newPos.pitch ?? pos.pitch);
  pos.yaw = Number(newPos.yaw ?? pos.yaw);

  try {
    client.queue('move_player', {
      runtime_id: rid,
      position: { x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) },
      pitch: Number(pos.pitch),
      yaw: Number(pos.yaw),
      head_yaw: Number(pos.yaw),
      mode: 0,
      on_ground: true,
      // must be BigInt
      ridden_runtime_id: BigInt(0)
    });
  } catch (e) {
    console.warn('sendMove error:', e?.message || e);
  }
}

function sendJump() {
  const rid = getRuntimeId();
  if (!rid) return;
  try {
    client.queue('animate', {
      action_id: 1,
      runtime_id: rid
    });
  } catch (e) {
    console.warn('sendJump error:', e?.message || e);
  }
}

function sendChat(msg) {
  if (!client) return;
  try {
    client.queue('text', {
      type: 'chat',
      needs_translation: false,
      source_name: BOT_NAME,
      message: String(msg),
      xuid: '',
      platform_chat_id: '',
      filtered_message: ''
    });
    console.log(`[chat] ${BOT_NAME}: ${msg}`);
  } catch (e) {
    console.warn('sendChat error:', e?.message || e);
  }
}

/* ---------------- PATROL LOGIC ---------------- */
function dist3(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function chooseStepDirection() {
  // produce a small direction unit vector based on current yaw (or random)
  const yawDeg = (typeof pos.yaw === 'number' && !Number.isNaN(pos.yaw)) ? pos.yaw : (Math.random() * 360);
  const angle = yawDeg * (Math.PI / 180);
  const choices = [
    { dx: Math.sin(angle), dz: Math.cos(angle) },
    { dx: -Math.sin(angle), dz: -Math.cos(angle) },
    { dx: Math.cos(angle), dz: -Math.sin(angle) },
    { dx: -Math.cos(angle), dz: Math.sin(angle) }
  ];
  return choices[Math.floor(Math.random() * choices.length)];
}

function patrolStepOnce() {
  try {
    if (!client || !getRuntimeId()) return;

    const base = spawnPos ?? pos;
    const d = dist3(pos, base);
    if (d >= MAX_PATROL_DISTANCE && d > 0) {
      // move back toward base
      const dir = { x: (base.x - pos.x) / d, z: (base.z - pos.z) / d };
      const next = {
        x: pos.x + dir.x * 0.8,
        y: pos.y,
        z: pos.z + dir.z * 0.8,
        pitch: pos.pitch,
        yaw: Math.atan2(-dir.x, dir.z) * (180 / Math.PI)
      };
      sendMove(next);
      return;
    }

    const step = 1 + Math.floor(Math.random() * 2); // 1 or 2
    const dirVec = chooseStepDirection();
    const next = {
      x: pos.x + dirVec.dx * step,
      y: pos.y,
      z: pos.z + dirVec.dz * step,
      pitch: pos.pitch,
      yaw: Math.atan2(-dirVec.dx, dirVec.dz) * (180 / Math.PI)
    };

    if (dist3(next, base) > MAX_PATROL_DISTANCE) {
      // skip step that would go out of allowed area
      return;
    }

    sendMove(next);
  } catch (e) {
    console.warn('patrolStepOnce error:', e?.message || e);
  }
}

function scheduleNextPatrolStep() {
  safeClearTimeout(patrolStepTimer);
  const ms = (PATROL_STEP_SEC_MIN + Math.random() * (PATROL_STEP_SEC_MAX - PATROL_STEP_SEC_MIN)) * 1000;
  patrolStepTimer = setTimeout(() => {
    patrolStepOnce();
    scheduleNextPatrolStep();
  }, ms);
}

function patrolTurnOnce() {
  try {
    if (!client || !getRuntimeId()) return;
    const yaw = Math.random() * 360;
    const pitch = (Math.random() * 20) - 10;
    pos.yaw = Number(yaw);
    pos.pitch = Number(pitch);
    // send a move packet with same pos but new head orientation
    const rid = getRuntimeId();
    try {
      client.queue('move_player', {
        runtime_id: rid,
        position: { x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) },
        pitch: Number(pos.pitch),
        yaw: Number(pos.yaw),
        head_yaw: Number(pos.yaw),
        mode: 0,
        on_ground: true,
        ridden_runtime_id: BigInt(0)
      });
    } catch (e) {
      console.warn('patrolTurn send error:', e?.message || e);
    }
  } catch (e) {
    console.warn('patrolTurnOnce error:', e?.message || e);
  }
}

function scheduleNextPatrolTurn() {
  safeClearTimeout(patrolTurnTimer);
  const ms = (PATROL_TURN_SEC_MIN + Math.random() * (PATROL_TURN_SEC_MAX - PATROL_TURN_SEC_MIN)) * 1000;
  patrolTurnTimer = setTimeout(() => {
    patrolTurnOnce();
    scheduleNextPatrolTurn();
  }, ms);
}

/* ---------------- HUMAN BEHAVIOR START / STOP ---------------- */
function startHumanBehavior() {
  if (!client) return;

  // Try to seed position from startGameData (if available)
  if (client.startGameData) {
    const sg = client.startGameData;
    const p = sg.position ?? sg.player_position ?? sg.spawn_position ?? (typeof sg.x === 'number' ? { x: sg.x, y: sg.y ?? 64, z: sg.z } : null);
    if (p && typeof p.x === 'number') {
      pos.x = Number(p.x);
      pos.y = Number(p.y ?? pos.y);
      pos.z = Number(p.z);
      if (!spawnPos) spawnPos = { x: pos.x, y: pos.y, z: pos.z };
    }
  }
  if (!spawnPos) spawnPos = { x: pos.x, y: pos.y, z: pos.z };

  console.log('Human simulation started (patrol + chat). spawnPos:', spawnPos);

  // Reset reconnect attempts on success
  reconnectAttempts = 0;

  // schedule first run
  scheduleNextPatrolStep();
  scheduleNextPatrolTurn();

  // chat timer
  safeClearTimeout(chatTimer);
  chatTimer = setTimeout(function chatLoop() {
    try {
      if (!client || !getRuntimeId()) return;
      const msg = CHAT_MESSAGES[Math.floor(Math.random() * CHAT_MESSAGES.length)];
      sendChat(msg);
      if (Math.random() < 0.3) sendJump();
    } catch (e) {
      console.warn('chatLoop error:', e?.message || e);
    } finally {
      chatTimer = setTimeout(chatLoop, CHAT_INTERVAL_MS + Math.floor(Math.random() * 30000));
    }
  }, CHAT_INTERVAL_MS);
}

function stopHumanBehavior() {
  safeClearTimeout(patrolStepTimer);
  safeClearTimeout(patrolTurnTimer);
  safeClearTimeout(chatTimer);
  patrolStepTimer = null;
  patrolTurnTimer = null;
  chatTimer = null;
}

/* ---------------- CONNECT / EVENTS ---------------- */
function connectWithCurrentVersion() {
  safeCloseClient();
  const version = currentVersion();

  console.log(`Attempting connection to ${MC_HOST}:${MC_PORT} as "${BOT_NAME}" with version "${version}"`);

  try {
    client = bedrock.createClient({
      host: MC_HOST,
      port: MC_PORT,
      username: BOT_NAME,
      offline: true,
      version: version
    });
  } catch (err) {
    console.error('createClient threw:', err?.stack || err);
    rotateVersionAndReconnect('createClient error');
    return;
  }

  // get initial position from start_game packet
  client.on('start_game', (pkt) => {
    const p = pkt.position ?? pkt.player_position ?? pkt.spawn_position ?? (typeof pkt.x === 'number' ? { x: pkt.x, y: pkt.y ?? 64, z: pkt.z } : null);
    if (p && typeof p.x === 'number') {
      pos.x = Number(p.x);
      pos.y = Number(p.y ?? pos.y);
      pos.z = Number(p.z);
      if (!spawnPos) spawnPos = { x: pos.x, y: pos.y, z: pos.z };
    }
  });

  client.on('spawn', () => {
    console.log('Bot spawned and in world — connected successfully. (version used:', version, ')');
    startHumanBehavior();

    if (!keepAliveTimer) {
      keepAliveTimer = setInterval(() => {
        console.log(`[keepalive] ${new Date().toISOString()}`);
      }, KEEPALIVE_MS);
    }
  });

  client.on('text', pkt => {
    try { console.log('chat:', pkt?.message ?? pkt); } catch (e) {}
  });

  client.on('error', (err) => {
    const msg = (err?.message || String(err)).toLowerCase();
    console.error('client error:', err?.message || err);

    if (msg.includes('ping timed out') || msg.includes('timed out')) {
      safeCloseClient();
      if (RECONNECT_MODE === 'exit') return shutdown(1);
      return scheduleReconnect(RECONNECT_DELAY_MS);
    }

    if (msg.includes('outdated_client') || msg.includes('outdated_server') ||
        msg.includes('unsupported') || msg.includes('unsupported protocol') || msg.includes('unsupported version')) {
      safeCloseClient();
      rotateVersionAndReconnect('protocol mismatch');
      return;
    }

    // any other errors -> retry with backoff
    safeCloseClient();
    if (RECONNECT_MODE === 'exit') return shutdown(1);
    scheduleReconnect(RECONNECT_DELAY_MS);
  });

  client.on('disconnect', (packet) => {
    console.warn('disconnect:', packet?.reason ?? packet);
    const reason = (packet && (packet.reason || packet) + '').toLowerCase();

    if (reason.includes('outdated_server') || reason.includes('outdated_client')) {
      safeCloseClient();
      rotateVersionAndReconnect(`disconnect: ${reason}`);
      return;
    }

    // server requested disconnect (bad_packet, kicked, stop) -> schedule reconnect
    safeCloseClient();
    if (RECONNECT_MODE === 'exit') return shutdown(1);
    scheduleReconnect(RECONNECT_DELAY_MS);
  });

  client.on('end', () => {
    console.warn('Connection ended by server.');
    safeCloseClient();
    if (RECONNECT_MODE === 'exit') return shutdown(1);
    scheduleReconnect(RECONNECT_DELAY_MS);
  });

  client.on('close', () => {
    console.warn('Socket closed.');
    safeCloseClient();
    if (RECONNECT_MODE === 'exit') return shutdown(1);
    scheduleReconnect(RECONNECT_DELAY_MS);
  });
}

/* ---------------- START ---------------- */
tryingIndex = 0;
console.log('BOT_NAME =', BOT_NAME);
connectWithCurrentVersion();
