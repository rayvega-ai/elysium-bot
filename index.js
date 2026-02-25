const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Бот Elysium активен!'));
app.listen(process.env.PORT || 3000);
