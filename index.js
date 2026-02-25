const mineflayer = require('mineflayer');
const express = require('express');
const app = express();

app.get('/', (req, res) => res.send('Elysium Bot Status: OK'));
app.listen(process.env.PORT || 3000);

console.log('Попытка подключения к Elysium...');

const bot = mineflayer.createBot({
  host: 'ТВОЙ_IP.aternos.me', // ПРОВЕРЬ ЕЩЕ РАЗ!
  port: 44193, // Твой последний порт из логов
  username: 'Elysium_Guard',
  offline: true,
  version: false // Бот сам подберет версию протокола
});

bot.on('login', () => {
  console.log('Бот успешно вошел в аккаунт!');
});

bot.on('spawn', () => {
  console.log('Максим, я заспавнился в мире!');
});

bot.on('error', (err) => {
  console.log('ОШИБКА ПОДКЛЮЧЕНИЯ:', err.message);
});

bot.on('kicked', (reason) => {
  console.log('Бот был КИКНУТ сервером:', reason);
});

bot.on('end', () => {
  console.log('Соединение закрыто. Перезапуск через 30 сек...');
  setTimeout(() => process.exit(1), 30000);
});
