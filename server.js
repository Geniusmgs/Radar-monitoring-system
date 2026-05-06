const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
// Глобальное состояние настроек системы
let deviceSettings = {
    armed: true,         // Включен ли радар
    sensitivity: 300,    // Фильтр дистанции в миллиметрах (по умолчанию 30 см)
    reboot: false        // Флаг перезагрузки
}; 
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
    
// Отправляем плате текущие настройки вместо пустого "ОК"
    res.json(deviceSettings);

    // Если была команда на перезагрузку, сбрасываем флаг, чтобы плата не ушла в бесконечный ребут
    if (deviceSettings.reboot) {
        console.log("Reboot command sent to ESP32!");
        deviceSettings.reboot = false; 
    }
});

wss.on('connection', (ws) => {
    console.log('New client connected');

    // СЛУШАЕМ КОМАНДЫ ОТ САЙТА
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.type === 'settings_update') {
                // Обновляем настройки на сервере
                if (msg.armed !== undefined) deviceSettings.armed = msg.armed;
                if (msg.sensitivity !== undefined) deviceSettings.sensitivity = msg.sensitivity * 10; // Переводим см в мм для ESP32
                if (msg.reboot !== undefined) deviceSettings.reboot = msg.reboot;
                
                console.log('New settings applied:', deviceSettings);
            }
        } catch (e) {
            console.error("Error parsing settings:", e);
        }
    });

    ws.on('close', () => console.log('Client disconnected'));
});

// Render сам передаст нужный порт в переменную PORT
const PORT = process.env.PORT || 3000;

// Важно: на Render нужно слушать адрес '0.0.0.0'
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущено на порту ${PORT}`);
});