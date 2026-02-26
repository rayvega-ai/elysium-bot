'use strict';

const bedrock = require('bedrock-protocol');
const express = require('express');

/* ---------------- CONFIG FROM ENV ---------------- */
const APP_PORT = process.env.PORT || 3000;
const MC_HOST = (process.env.MC_HOST || '').trim();
const MC_PORT = process.env.MC_PORT ? Number(process.env.MC_PORT) : NaN;
const BOT_NAME = process.env.BOT_NAME || 'BedrockBot';
const RECONNECT_MODE = (process.env.RECONNECT_MODE || 'retry').toLowerCase();
const RETRY_INTERVAL_MS = process.env.RETRY_INTERVAL_MS ? Number(process.env.RETRY_INTERVAL_MS) : 30000;
const KEEPALIVE_MS = 60_000;

// New ENV params (defaults per spec)
const RECONNECT_DELAY_MS = process.env.RECONNECT_DELAY_MS ? Number(process.env.RECONNECT_DELAY_MS) : 60000;
const PATROL_STEP_SEC_MIN = process.env.PATROL_STEP_SEC_MIN ? Number(process.env.PATROL_STEP_SEC_MIN) : 3;
const PATROL_STEP_SEC_MAX = process.env.PATROL_STEP_SEC_MAX ? Number(process.env.PATROL_STEP_SEC_MAX) : 6;
const PATROL_TURN_SEC_MIN = 15;
const PATROL_TURN_SEC_MAX = 30;
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

let client = null;
let keepAliveTimer = null;
let reconnectTimer = null;
let tryingIndex = 0;

let patrolStepTimer = null;
let patrolTurnTimer = null;
let chatTimer = null;

/* ---------------- POSITION STATE ---------------- */
let pos = { x: 0, y: 64, z: 0, pitch: 0, yaw: 0 };
let spawnPos = null;

function safeCloseClient() {
  stopHumanBehavior();

  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
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

function currentVersion() {
  return MC_VERSIONS[tryingIndex] || MC_VERSIONS[0];
}

function scheduleReconnect(delay = RECONNECT_DELAY_MS) {
  if (reconnectTimer) return;
  console.log(`Reconnecting in ${delay} ms (${Math.round(delay / 1000)}s)...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWithCurrentVersion();
  }, delay);
}

function rotateVersionAndReconnect(reason) {
  console.warn(`Rotating protocol version due to: ${reason}`);
  tryingIndex = (tryingIndex + 1) % MC_VERSIONS.length;
  const didFullCycle = tryingIndex === 0;
  scheduleReconnect(didFullCycle ? RECONNECT_DELAY_MS * 2 : 1000);
}

function getRuntimeId() {
  if (!client) return null;
  return client.entityId ?? client.entity?.runtime_id ?? client.startGameData?.runtime_entity_id ?? null;
}

function sendMove(newPos) {
  const rid = getRuntimeId();
  if (!rid) return;

  pos.x = newPos.x;
  pos.y = newPos.y;
  pos.z = newPos.z;
  pos.pitch = newPos.pitch ?? pos.pitch;
  pos.yaw = newPos.yaw ?? pos.yaw;

  try {
    client.queue('move_player', {
      runtime_id: rid,
      position: { x: pos.x, y: pos.y, z: pos.z },
      pitch: pos.pitch,
      yaw: pos.yaw,
      head_yaw: pos.yaw,
      mode: 0,
      on_ground: true,
      ridden_runtime_id: 0
    });
  } catch (e) {
    console.warn('sendMove error:', e?.message);
  }
}

function dist3(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function patrolStep() {
  if (!client || !getRuntimeId()) return;

  const base = spawnPos ?? pos;
  const d = dist3(pos, base);
  if (d >= MAX_PATROL_DISTANCE) {
    const dir = {
      x: (base.x - pos.x) / d,
      z: (base.z - pos.z) / d
    };
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

  const step = 1 + Math.floor(Math.random() * 2);
  const angle = (pos.yaw || Math.random() * 360) * (Math.PI / 180);
  const dirs = [
    { dx: Math.sin(angle), dz: Math.cos(angle) },
    { dx: -Math.sin(angle), dz: -Math.cos(angle) },
    { dx: Math.cos(angle), dz: -Math.sin(angle) },
    { dx: -Math.cos(angle), dz: Math.sin(angle) }
  ];
  const dirVec = dirs[Math.floor(Math.random() * dirs.length)];
  const next = {
    x: pos.x + dirVec.dx * step,
    y: pos.y,
    z: pos.z + dirVec.dz * step,
    pitch: pos.pitch,
    yaw: Math.atan2(-dirVec.dx, dirVec.dz) * (180 / Math.PI)
  };

  if (dist3(next, base) > MAX_PATROL_DISTANCE) return;

  sendMove(next);
}

function patrolTurn() {
  if (!client || !getRuntimeId()) return;

  const yaw = Math.random() * 360;
  const pitch = (Math.random() * 20) - 10;

  pos.yaw = yaw;
  pos.pitch = pitch;

  try {
    client.queue('move_player', {
      runtime_id: getRuntimeId(),
      position: { x: pos.x, y: pos.y, z: pos.z },
      pitch,
      yaw,
      head_yaw: yaw,
      mode: 0,
      on_ground: true,
      ridden_runtime_id: 0
    });
  } catch (e) {
    console.warn('patrolTurn error:', e?.message);
  }
}

function sendChat(msg) {
  if (!client) return;
  try {
    client.queue('text', {
      type: 'chat',
      needs_translation: false,
      source_name: BOT_NAME,
      message: msg,
      xuid: '',
      platform_chat_id: '',
      filtered_message: ''
    });
    console.log(`[chat] ${BOT_NAME}: ${msg}`);
  } catch (e) {
    console.warn('sendChat error:', e?.message);
  }
}

function sendJump() {
  if (!client || !getRuntimeId()) return;
  try {
    client.queue('animate', {
      action_id: 1,
      runtime_id: getRuntimeId()
    });
  } catch (e) {}
}

function startHumanBehavior() {
  if (!client) return;

  if (client.startGameData) {
    const sg = client.startGameData;
    const p = sg.position ?? sg.player_position ?? sg.spawn_position ?? (typeof sg.x === 'number' ? { x: sg.x, y: sg.y ?? 64, z: sg.z } : null);
    if (p && typeof p.x === 'number') {
      pos.x = p.x;
      pos.y = p.y ?? pos.y;
      pos.z = p.z;
      if (!spawnPos) spawnPos = { ...pos };
    }
  }
  if (!spawnPos) spawnPos = { x: pos.x, y: pos.y, z: pos.z };

  console.log('Human simulation started (patrol + chat). spawnPos:', spawnPos);

  const stepMs = (PATROL_STEP_SEC_MIN + Math.random() * (PATROL_STEP_SEC_MAX - PATROL_STEP_SEC_MIN)) * 1000;
  const turnMs = (PATROL_TURN_SEC_MIN + Math.random() * (PATROL_TURN_SEC_MAX - PATROL_TURN_SEC_MIN)) * 1000;

  patrolStepTimer = setInterval(patrolStep, stepMs);
  patrolTurnTimer = setInterval(patrolTurn, turnMs);

  chatTimer = setInterval(() => {
    if (!client || !getRuntimeId()) return;
    const msg = CHAT_MESSAGES[Math.floor(Math.random() * CHAT_MESSAGES.length)];
    sendChat(msg);
    if (Math.random() < 0.3) sendJump();
  }, CHAT_INTERVAL_MS);
}

function stopHumanBehavior() {
  if (patrolStepTimer) { clearInterval(patrolStepTimer); patrolStepTimer = null; }
  if (patrolTurnTimer) { clearInterval(patrolTurnTimer); patrolTurnTimer = null; }
  if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }
}

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

  client.on('start_game', (pkt) => {
    const p = pkt.position ?? pkt.player_position ?? pkt.spawn_position ?? (typeof pkt.x === 'number' ? { x: pkt.x, y: pkt.y ?? 64, z: pkt.z } : null);
    if (p && typeof p.x === 'number') {
      pos.x = p.x;
      pos.y = p.y ?? pos.y;
      pos.z = p.z;
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

    safeCloseClient();
    if (RECONNECT_MODE === 'exit') return shutdown(1);
    scheduleReconnect(RECONNECT_DELAY_MS);
  });

  client.on('end', () => {
    safeCloseClient();
    if (RECONNECT_MODE === 'exit') return shutdown(1);
    scheduleReconnect(RECONNECT_DELAY_MS);
  });

  client.on('close', () => {
    safeCloseClient();
    if (RECONNECT_MODE === 'exit') return shutdown(1);
    scheduleReconnect(RECONNECT_DELAY_MS);
  });
}

tryingIndex = 0;
connectWithCurrentVersion();
