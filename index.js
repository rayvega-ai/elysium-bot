'use strict';

const bedrock = require('bedrock-protocol');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Express (обязательно для Render) =====
app.get('/', (req, res) => {
  res.send('Bedrock bot is running');
});

app.listen(PORT, () => {
  console.log('Web server started on port', PORT);
});

// ===== ДАННЫЕ ТВОЕГО СЕРВЕРА =====
const SERVER_HOST = 'Elysium-62TP.aternos.me';
const SERVER_PORT = 44193;
const BOT_NAME = 'Elysium_Guard';

// ===== Подключение =====
console.log('Connecting to Bedrock server...');

const client = bedrock.createClient({
  host: SERVER_HOST,
  port: SERVER_PORT,
  username: BOT_NAME,
  offline: true,
  version: '1.21.131'
});

// ===== Успешное подключение =====
client.on('spawn', () => {
  console.log('Bot successfully joined the server');

  // Каждую минуту лог активности
  setInterval(() => {
    console.log('Bot is alive:', new Date().toISOString());
  }, 60000);
});

// ===== Ошибки =====
client.on('error', (err) => {
  console.log('Connection error:', err.message);
  process.exit(1); // Render перезапустит
});

client.on('disconnect', (packet) => {
  console.log('Disconnected:', packet?.reason || packet);
  process.exit(1);
});

client.on('end', () => {
  console.log('Connection ended');
  process.exit(1);
});
