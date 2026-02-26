'use strict';

const bedrock = require('bedrock-protocol');
const express = require('express');

const APP_PORT = process.env.PORT || 3000;
const MC_HOST = (process.env.MC_HOST || '').trim();
const MC_PORT = process.env.MC_PORT ? Number(process.env.MC_PORT) : NaN;
const BOT_NAME = process.env.BOT_NAME || 'BedrockBot';
const RECONNECT_MODE = (process.env.RECONNECT_MODE || 'retry').toLowerCase();
const RETRY_INTERVAL_MS = process.env.RETRY_INTERVAL_MS ? Number(process.env.RETRY_INTERVAL_MS) : 30000;
const KEEPALIVE_MS = 60_000;
const RECONNECT_DELAY = 60000; // 1 минута

const MC_VERSIONS = (process.env.MC_VERSIONS || '1.21.131,1.21.124,1.21.100')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

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

let moveTimer = null;
let actionTimer = null;

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

function scheduleReconnect(delay = RECONNECT_DELAY) {
  if (reconnectTimer) return;
  console.log(`Reconnecting in ${delay} ms...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWithCurrentVersion();
  }, delay);
}

function rotateVersionAndReconnect(reason) {
  console.warn(`Rotating protocol version due to: ${reason}`);
  tryingIndex = (tryingIndex + 1) % MC_VERSIONS.length;
  const didFullCycle = tryingIndex === 0;
  scheduleReconnect(didFullCycle ? RECONNECT_DELAY * 2 : 1000);
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
      return scheduleReconnect(RECONNECT_DELAY);
    }

    if (msg.includes('outdated_client') || msg.includes('outdated_server') ||
        msg.includes('unsupported') || msg.includes('unsupported protocol') || msg.includes('unsupported version')) {
      safeCloseClient();
      rotateVersionAndReconnect('protocol mismatch');
      return;
    }

    safeCloseClient();
    if (RECONNECT_MODE === 'exit') return shutdown(1);
    scheduleReconnect(RECONNECT_DELAY);
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
    scheduleReconnect(RECONNECT_DELAY);
  });

  client.on('end', () => {
    safeCloseClient();
    if (RECONNECT_MODE === 'exit') return shutdown(1);
    scheduleReconnect(RECONNECT_DELAY);
  });
}

/* ---------------- HUMAN SIMULATION ---------------- */

function startHumanBehavior() {
  if (!client) return;

  console.log('Human simulation started');

  moveTimer = setInterval(() => {
    if (!client?.entity) return;

    const yaw = Math.random() * 360;
    const pitch = (Math.random() * 20) - 10;

    try {
      client.queue('move_player', {
        runtime_id: client.entity.runtime_id,
        position: client.entity.position,
        pitch: pitch,
        yaw: yaw,
        head_yaw: yaw,
        mode: 0,
        on_ground: true,
        ridden_runtime_id: 0
      });
    } catch {}
  }, 20000 + Math.random() * 10000);

  actionTimer = setInterval(() => {
    if (!client?.entity) return;

    const r = Math.random();

    try {
      if (r < 0.4) {
        client.queue('animate', {
          action_id: 1,
          runtime_id: client.entity.runtime_id
        });
      } else if (r < 0.6) {
        client.queue('text', {
          type: 'chat',
          needs_translation: false,
          source_name: BOT_NAME,
          message: 'Я тут 👀',
          xuid: '',
          platform_chat_id: ''
        });
      }
    } catch {}

  }, 120000 + Math.random() * 60000);
}

function stopHumanBehavior() {
  if (moveTimer) clearInterval(moveTimer);
  if (actionTimer) clearInterval(actionTimer);
}

/* -------------------------------------------------- */

tryingIndex = 0;
connectWithCurrentVersion();
