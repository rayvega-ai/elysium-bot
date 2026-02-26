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

// MC_VERSIONS: comma-separated list, e.g. "1.21.131,1.21.124"
// If not provided, uses sensible defaults (tries server's exact version first).
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

// state
let client = null;
let keepAliveTimer = null;
let reconnectTimer = null;
let tryingIndex = 0; // index in MC_VERSIONS

function safeCloseClient() {
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
  console.error('uncaughtException', err && err.stack ? err.stack : err);
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
  shutdown(1);
});
process.on('SIGTERM', () => { console.log('SIGTERM'); shutdown(0); });
process.on('SIGINT', () => { console.log('SIGINT'); shutdown(0); });

function currentVersion() {
  return MC_VERSIONS[tryingIndex] || MC_VERSIONS[0];
}

function scheduleReconnect(delay = RETRY_INTERVAL_MS) {
  if (reconnectTimer) return;
  console.log(`Scheduling reconnect in ${delay} ms (current version index: ${tryingIndex})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWithCurrentVersion();
  }, delay);
}

function rotateVersionAndReconnect(reason) {
  console.warn(`Rotating protocol version due to: ${reason}`);
  tryingIndex = (tryingIndex + 1) % MC_VERSIONS.length;
  // if we did a full cycle, wait a bit longer
  const didFullCycle = tryingIndex === 0;
  scheduleReconnect(didFullCycle ? RETRY_INTERVAL_MS * 2 : 1000);
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
      version: version // explicitly set the protocol candidate
    });
  } catch (err) {
    console.error('createClient threw:', err && err.stack ? err.stack : err);
    // if thrown, try next candidate or exit
    rotateVersionAndReconnect('createClient error');
    return;
  }

  client.on('spawn', () => {
    console.log('Bot spawned and in world — connected successfully. (version used:', version, ')');

    // keepalive
    if (!keepAliveTimer) {
      keepAliveTimer = setInterval(() => {
        try {
          console.log(`[keepalive] ${new Date().toISOString()}`);
          // Optionally send a chat message:
          // if (client && client.queue) client.queue('text', { message: 'привет от бота' });
        } catch (e) {
          console.error('keepalive error', e);
        }
      }, KEEPALIVE_MS);
    }
  });

  client.on('text', pkt => {
    try { console.log('chat:', pkt?.message ?? pkt); } catch (e) {}
  });

  client.on('error', (err) => {
    const msg = (err && (err.message || String(err))).toLowerCase();
    console.error('client error:', err && err.message ? err.message : err);

    if (msg.includes('ping timed out') || msg.includes('timed out')) {
      console.warn('Ping timed out — server unreachable or offline.');
      safeCloseClient();
      if (RECONNECT_MODE === 'exit') return shutdown(1);
      return scheduleReconnect(RETRY_INTERVAL_MS);
    }

    // Protocol/version related messages:
    // server can respond with 'outdated_client' (server newer) or 'outdated_server' (server older)
    if (msg.includes('outdated_client') || msg.includes('outdated_server') ||
        msg.includes('unsupported') || msg.includes('unsupported protocol') || msg.includes('unsupported version')) {
      console.warn('Protocol mismatch detected:', msg);
      // rotate to next candidate
      safeCloseClient();
      rotateVersionAndReconnect('protocol mismatch');
      return;
    }

    // Other errors — retry or exit
    safeCloseClient();
    if (RECONNECT_MODE === 'exit') return shutdown(1);
    scheduleReconnect(RETRY_INTERVAL_MS);
  });

  client.on('disconnect', (packet) => {
    console.warn('disconnect:', packet?.reason ?? packet);
    // Some servers send textual reasons like 'outdated_server' as packet.reason
    const reason = (packet && (packet.reason || packet) + '').toLowerCase();

    if (reason.includes('outdated_server') || reason.includes('outdated_client')) {
      // try next version
      safeCloseClient();
      rotateVersionAndReconnect(`disconnect: ${reason}`);
      return;
    }

    // normal disconnect — schedule reconnect
    safeCloseClient();
    if (RECONNECT_MODE === 'exit') return shutdown(1);
    scheduleReconnect(RETRY_INTERVAL_MS);
  });

  client.on('end', () => {
    console.warn('Connection ended by server.');
    safeCloseClient();
    if (RECONNECT_MODE === 'exit') return shutdown(1);
    scheduleReconnect(RETRY_INTERVAL_MS);
  });

  client.on('close', () => {
    console.warn('Socket closed.');
    // handlers above will schedule reconnect/rotation
  });
}

// start from index 0 (first candidate)
tryingIndex = 0;
connectWithCurrentVersion();
