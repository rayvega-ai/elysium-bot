const mineflayer = require('mineflayer');
const express = require('express');
const app = express();

// Веб-сервер для Render
app.get('/', (req, res) => res.send('Elysium Bot is Online!'));
app.listen(process.env.PORT || 3000);

const bot = mineflayer.createBot({
  host: 'Elysium-62TP.aternos.me', // ВПИШИ СВОЙ АДРЕС ТУТ
  port: 44193,
  username: 'Elysium-62TP',
  offline: true,
  version: '1.21.131.1'
});

bot.on('spawn', () => {
  console.log('Максим, бот зашел!');
  setInterval(() => {
    const actions = ['jump', 'sneak'];
    const act = actions[Math.floor(Math.random() * actions.length)];
    bot.setControlState(act, true);
    setTimeout(() => bot.setControlState(act, false), 1000);
    bot.look(Math.random() * 360, 0);
  }, 60000); 
});

bot.on('chat', (username, message) => {
  if (message.toLowerCase().includes('привет')) {
    bot.chat('Привет! Я охранник Elysium.');
  }
});

bot.on('end', () => {
  console.log('Вылет! Перезапуск через 1 минуту...');
  setTimeout(() => process.exit(1), 60000); // Render сам перезапустит процесс
});
