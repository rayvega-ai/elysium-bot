'use strict';

const bedrock = require('bedrock-protocol');
const express = require('express');

/* ========= CONFIG ========= */

const PORT = process.env.PORT || 3000;

const MC_HOST = process.env.MC_HOST;
const MC_PORT = Number(process.env.MC_PORT);
const BOT_NAME = process.env.BOT_NAME || 'Elysium_Guard';

const RETRY_DELAY = 30000; // 30 секунд

if (!MC_HOST || !MC_PORT) {
  console.error('MC_HOST and MC_PORT must be set in Render Environment Variables');
  process.exit(1);
}

/* ========= EXPRESS ========= */

const app = express();

app.get('/', (req, res) => {
  res.send('Bedrock bot is running');
});

app.listen(PORT, () => {
  console.log('Express started on port', PORT);
});

/* ========= BOT ========= */

let client = null;
let reconnectTimer = null;
let keepAliveTimer = null;

function connect() {
  console.log(`Connecting to ${MC_HOST}:${MC_PORT} as ${BOT_NAME}...`);

  client = bedrock.createClient({
    host: MC_HOST,
    port: MC_PORT,
    username: BOT_NAME,
    offline: true
    // version intentionally removed
  });

  client.on('spawn', () => {
    console.log('Bot joined the server successfully');

    if (!keepAliveTimer) {
      keepAliveTimer = setInterval(() => {
        console.log('Bot alive:', new Date().toISOString());
      }, 60000);
    }
  });

  client.on('error', handleDisconnect);
  client.on('disconnect', handleDisconnect);
  client.on('end', handleDisconnect);
}

function handleDisconnect(reason) {
  console.log('Disconnected:', reason?.reason || reason);

  if (client) {
    try { client.close(); } catch (e) {}
    client = null;
  }

  if (!reconnectTimer) {
    console.log(`Reconnecting in ${RETRY_DELAY / 1000} seconds...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RETRY_DELAY);
  }
}

/* ========= START ========= */

connect();
