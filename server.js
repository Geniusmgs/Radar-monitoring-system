const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express(); 
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Разрешаем серверу брать статические файлы отовсюду
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

// Прямой приказ: что делать при заходе на главную страницу (/)
app.get('/', (req, res) => {
    // Сначала пробуем найти index.html в папке public
    const publicPath = path.join(__dirname, 'public', 'index.html');
    const rootPath = path.join(__dirname, 'index.html');

    res.sendFile(publicPath, (err) => {
        if (err) {
            // Если в public не нашли, берем из корня
            res.sendFile(rootPath); 
        }
    });
});
app.use(express.json());


// Змінні для контролю статусу
let lastPingTime = 0;
let isSensorOnline = false;
const ESP_SECRET_TOKEN = "RadarView-ESP32-C3-SecretKey-2026";

// Таймер (працює кожну секунду), який перевіряє зв'язок
setInterval(() => {
    const now = Date.now();
    // Якщо даних не було більше 15 секунд, вважаємо, що датчик відключився
    if (isSensorOnline && (now - lastPingTime > 15000)) {
        isSensorOnline = false;
        console.log('Помилка: Зв\'язок з ESP32 втрачено!');
        
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'status', status: 'offline' }));
            }
        });
    }
}, 1000);

app.post('/api/data', (req, res) => {
    const data = req.body;
    
    // ПРОВЕРКА БЕЗОПАСНОСТИ
    if (data.token !== ESP_SECRET_TOKEN) {
        console.log('⚠️ Внимание! Попытка взлома или неверный токен устройства!');
        return res.status(403).send({ error: 'Unauthorized. Wrong token.' });
    }
    
    // Оновлюємо час останнього сигналу
    lastPingTime = Date.now();
    
    if (!isSensorOnline) {
        isSensorOnline = true;
        console.log('Зв\'язок з ESP32 відновлено!');
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'status', status: 'online' }));
            }
        });
    }

    console.log('Дані від ESP32:', data);
    
    // Розсилаємо самі дані про рух
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
    
    res.status(200).send({ status: 'ok' });
});

wss.on('connection', (ws) => {
    console.log('Новий клієнт підключився до сайту');
    ws.send(JSON.stringify({ 
        type: 'status', 
        status: isSensorOnline ? 'online' : 'offline' 
    }));
});

// Render сам передаст нужный порт в переменную PORT
const PORT = process.env.PORT || 3000;

// Важно: на Render нужно слушать адрес '0.0.0.0'
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущено на порту ${PORT}`);
});