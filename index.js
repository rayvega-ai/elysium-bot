const bedrock = require('bedrock-protocol');
const express = require('express');
const app = express();

// Веб-сервер для поддержки Render
app.get('/', (req, res) => res.send('Elysium Bedrock Bot: OK'));
app.listen(process.env.PORT || 3000);

console.log('Попытка подключения к Bedrock серверу Elysium...');

const client = bedrock.createClient({
  host: 'ТВОЙ_IP.aternos.me', // Максим, впиши сюда свой адрес
  port: 44193,                // Твой актуальный порт из логов
  username: 'Elysium_Guard',
  offline: true               // Обязательно для Cracked (пиратского) режима
});

client.on('join', () => {
  console.log('Максим, успех! Я зашел на Bedrock сервер Elysium!');
  
  // Имитация активности, чтобы не кикнули
  setInterval(() => {
    console.log('Бот активен, стою на посту...');
  }, 60000);
});

client.on('error', (err) => {
  console.log('ОШИБКА ПОДКЛЮЧЕНИЯ:', err.message);
});

client.on('disconnect', (packet) => {
  console.log('Бот отключен от сервера. Причина:', packet.reason);
  // Перезапуск через 30 секунд
  setTimeout(() => process.exit(1), 30000);
});
