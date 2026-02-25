'use strict';

/**
 * index.js
 * Bedrock bot for Render with retry logic.
 *
 * Env vars:
 *   PORT            - (Render) web port (default 3000)
 *   MC_HOST         - required, example: Elysium-62TP.aternos.me
 *   MC_PORT         - required, example: 44193
 *   BOT_NAME        - optional, default 'BedrockBot'
 *   MC_VERSION      - optional, default '1.21.124' (protocol version used by bedrock-protocol)
 *   RECONNECT_MODE  - 'retry' (default) or 'exit'  -> behavior on network errors
 *   RETRY_INTERVAL_MS - retry delay in ms (default 30000)
 */

const bedrock = require('bedrock-protocol');
const express = require('express');

const APP_PORT = process.env.PORT || 3000;
const MC_HOST = process.env.MC_HOST || '';
const MC_PORT = process.env.MC_PORT ? Number(process.env.MC_PORT) : NaN;
const BOT_NAME = process.env.BOT_NAME || 'BedrockBot';
const MC_VERSION = process.env.MC_VERSION || '1.21.124';
const RECONNECT_MODE = (process.env.RECONNECT_MODE || 'retry').toLowerCase(); // 'retry' or 'exit'
const RETRY_INTERVAL_MS = process.env.RETRY_INTERVAL_MS ? Number(process.env.RETRY_INTERVAL_MS) : 30000;

if (!MC_HOST || Number.isNaN(MC_PORT)) {
  console.error('FATAL: MC_HOST and MC_PORT must be set in environment variables.');
  console.error('Example: MC_HOST=Elysium-62TP.aternos.me MC_PORT=44193 BOT_NAME=Elysium_Guard');
  process.exit(1);
}

/* --- Express server (keep process alive on Render) --- */
const app = express();
app.get('/', (req, res) => res.send('Bedrock bot: OK'));
app.listen(APP_PORT, () => console.log(`Express started on port ${APP_PORT}`));

/* --- State --- */
let client = null;
let keepAliveTimer = null;
let connecting = false;

/* --- Safe cleanup --- */
function safeCloseClient() {
  try {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    if (client) {
      // try to remove listeners and close socket if possible
      try { client.removeAllListeners && client.removeAllListeners(); } catch (e) {}
      try { client.close && client.close(); } catch (e) {}
      client = null;
    }
  } catch (e) {
    console.error('safeCloseClient error:', e);
  }
}

/* --- Shutdown helper --- */
function shutdown(code = 1) {
  console.log(`Shutting down with code ${code}`);
  safeCloseClient();
  process.exit(code);
}

/* --- Uncaught handlers --- */
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err && err.stack ? err.stack : err);
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
  shutdown(1);
});
process.on('SIGTERM', () => { console.log('SIGTERM'); shutdown(0); });
process.on('SIGINT', () => { console.log('SIGINT'); shutdown(0); });

/* --- Start client (with retry logic) --- */
function startClient() {
  if (connecting) return;
  connecting = true;

  console.log(`Attempting connection to ${MC_HOST}:${MC_PORT} as "${BOT_NAME}" (version: ${MC_VERSION}) — reconnect mode: ${RECONNECT_MODE}`);

  try {
    client = bedrock.createClient({
      host: MC_HOST,
      port: MC_PORT,
      username: BOT_NAME,
      offline: true,
      version: MC_VERSION
    });
  } catch (err) {
    console.error('createClient throw:', err && err.stack ? err.stack : err);
    connecting = false;
    handleConnectFailure(err);
    return;
  }

  client.on('spawn', () => {
    connecting = false;
    console.log('Bot spawned and in world. Connected successfully.');

    // Keepalive: log every minute (can be replaced by chat messages if allowed)
    if (!keepAliveTimer) {
      keepAliveTimer = setInterval(() => {
        try {
          console.log(`[keepalive] ${new Date().toISOString()} - bot active`);
          // Example: send chat message (uncomment if you want)
          // if (client && client.queue) client.queue('text', { message: 'Привет от бота' });
        } catch (e) {
          console.error('keepalive error:', e);
        }
      }, 60 * 1000);
    }
  });

  client.on('text', pkt => {
    // log chat for debugging (optional)
    try { console.log('chat packet:', pkt?.message ?? pkt); } catch (e) {}
  });

  client.on('error', (err) => {
    console.error('client error:', err && err.message ? err.message : err);

    // If it's a network/ping timeout we treat differently
    const msg = (err && (err.message || String(err))).toLowerCase();
    if (msg.includes('ping timed out') || msg.includes('ping timeout') || msg.includes('timed out')) {
      console.error('Detected ping timeout — server likely offline or unreachable.');
      // Close client and either retry or exit depending on mode
      safeCloseClient();
      connecting = false;
      if (RECONNECT_MODE === 'exit') return shutdown(1);
      console.log(`Will retry in ${RETRY_INTERVAL_MS} ms...`);
      return setTimeout(startClient, RETRY_INTERVAL_MS);
    }

    // Unsupported version (protocol mismatch)
    if (msg.includes('unsupported') && msg.includes('version')) {
      console.error('Unsupported protocol version — try changing MC_VERSION to a supported value.');
      safeCloseClient();
      connecting = false;
      // In case of protocol mismatch, it's sensible to exit so you can change code/config.
      return shutdown(1);
    }

    // Other errors: either retry or exit
    safeCloseClient();
    connecting = false;
    if (RECONNECT_MODE === 'exit') return shutdown(1);
    console.log(`Unknown error — retrying in ${RETRY_INTERVAL_MS} ms...`);
    setTimeout(startClient, RETRY_INTERVAL_MS);
  });

  client.on('disconnect', (packet) => {
    console.error('disconnect:', packet?.reason ?? packet);
    safeCloseClient();
    connecting = false;
    if (RECONNECT_MODE === 'exit') return shutdown(1);
    console.log(`Disconnected — will retry in ${RETRY_INTERVAL_MS} ms...`);
    setTimeout(startClient, RETRY_INTERVAL_MS);
  });

  client.on('end', () => {
    console.error('Connection ended by server.');
    safeCloseClient();
    connecting = false;
    if (RECONNECT_MODE === 'exit') return shutdown(1);
    console.log(`Connection ended — retrying in ${RETRY_INTERVAL_MS} ms...`);
    setTimeout(startClient, RETRY_INTERVAL_MS);
  });

  client.on('close', () => {
    console.error('Socket closed.');
    // handlers above will deal with scheduling retries
  });
}

/* --- handle createClient throw or immediate failures --- */
function handleConnectFailure(err) {
  const msg = (err && err.message ? err.message : String(err)).toLowerCase();
  if (msg.includes('unsupported') && msg.includes('version')) {
    console.error('Fatal: unsupported protocol version. Change MC_VERSION to a supported value and redeploy.');
    return shutdown(1);
  }
  console.error('Failed to create client:', err);
  connecting = false;
  if (RECONNECT_MODE === 'exit') return shutdown(1);
  console.log(`Retrying connection in ${RETRY_INTERVAL_MS} ms...`);
  setTimeout(startClient, RETRY_INTERVAL_MS);
}

/* --- Start first attempt --- */
startClient();
