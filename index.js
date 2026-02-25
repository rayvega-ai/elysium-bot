const mineflayer = require('mineflayer');
const express = require('express');
const app = express();

// Веб-сервер для Render
app.get('/', (req, res) => res.send('Elysium Bot is Online!'));
app.listen(process.env.PORT || 3000);

const bot = mineflayer.createBot({
  host: 'ТВОЙ_IP.aternos.me', // Максим, тут впиши свой адрес еще раз
  port: 19132,
  username: 'Elysium_Guard',
  offline: true,
  version: '1.21.1' // Оставляем именно так, это "общая" версия для 1.21
});

bot.on('spawn', () => {
  console.log('Максим, я зашел на сервер!');
  setInterval(() => {
    bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 500);
    bot.look(Math.random() * 360, 0);
  }, 60000); 
});

bot.on('error', (err) => console.log('Ошибка:', err));

bot.on('end', () => {
  console.log('Вылет! Перезапуск через 1 минуту...');
  setTimeout(() => process.exit(1), 60000); 
});
