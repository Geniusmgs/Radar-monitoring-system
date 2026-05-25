const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios'); // Используется для безопасного запроса фото с ESP32-CAM

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ==========================================
// 🔴 НАСТРОЙКИ TELEGRAM (Встав свои данные)
// ==========================================
const TELEGRAM_TOKEN = 'ТВІЙ_ТОКЕН_ВІД_BOTFATHER'; 
const CHAT_ID = 'ТВІЙ_CHAT_ID';

// Создаем бота. polling: false, так как мы только отправляем сообщения
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false }); 

// Локальный IP-адрес твоей ESP32-CAM (можно будет менять прямо с сайта)
let cameraIP = '192.168.1.50'; 

// Глобальное состояние настроек системы
let deviceSettings = {
    armed: true,         // Включена ли охрана
    sensitivity: 300,    // Фильтр дистанции в миллиметрах (30 см)
    reboot: false        // Флаг перезагрузки
}; 

// Константы для контроля статуса связи
let lastPingTime = 0;
let isSensorOnline = false;
const ESP_SECRET_TOKEN = "RadarView-ESP32-C3-SecretKey-2026";

// Переменные для анти-спама Телеграм
let lastReportedZone = null;
let clearZoneTimeout = null;

// Настройка отдачи статических файлов (твоего сайта)
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Главная страница веб-интерфейса
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Таймер проверки связи с радаром (раз в секунду)
setInterval(() => {
    const now = Date.now();
    if (isSensorOnline && (now - lastPingTime > 15000)) {
        isSensorOnline = false;
        console.log('❌ Связь с ESP32 утеряна!');
        broadcast({ type: 'status', status: 'offline' });
    }
}, 1000);

// API для приема данных от твоей ESP32-C3
app.post('/api/data', (req, res) => {
    const data = req.body;
    
    // 1. Проверка секретного токена безопасности
    if (data.token !== ESP_SECRET_TOKEN) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // 2. Обновление статуса онлайн для датчика
    lastPingTime = Date.now();
    if (!isSensorOnline) {
        isSensorOnline = true;
        console.log('✅ ESP32 снова в сети!');
        broadcast({ type: 'status', status: 'online' });
    }

    // 3. Логирование входящих координат в консоль Render
    console.log(`📍 Координаты: X=${data.rawX || 0}, Y=${data.rawY || 0} | Зона: ${data.zone}`);
    
    // ==========================================
    // ЛОГІКА ПОВІДОМЛЕНЬ ТА ФОТОФІКСАЦІЇ TELEGRAM
    // ==========================================
    if (deviceSettings.armed && data.movement && data.zone && data.zone !== 'none' && data.zone !== 'out_of_bounds') {
        
        // Антиспам-фильтр: реагируем только если это НОВАЯ зона
        if (data.zone !== lastReportedZone) {
            
            // А) Отправляем быстрое текстовое сообщение в Telegram
            const msg = `🚨 Виявлено рух!\n📍 Зона: ${data.zone}\n⏱ Час: ${new Date().toLocaleTimeString('uk-UA')}`;
            bot.sendMessage(CHAT_ID, msg).catch(err => console.error("Ошибка Telegram отправки текста:", err.message));
            
            // Б) Запрашиваем стоп-кадр с ESP32-CAM (если она в сети)
            if (cameraIP) {
                axios({
                    method: 'get',
                    url: `http://${cameraIP}:80/capture`,
                    responseType: 'stream',
                    timeout: 4000 // Если камера недоступна, сервер не зависнет дольше 4 секунд
                })
                .then(response => {
                    bot.sendPhoto(CHAT_ID, response.data, { 
                        caption: `📸 Фіксація об'єкта у зоні: ${data.zone}` 
                    }).catch(pErr => console.error("Ошибка отправки фото в ТГ:", pErr.message));
                })
                .catch(camErr => {
                    console.log(`📷 Камера [${cameraIP}] не ответила (локальный IP недоступен из облака, это нормально)`);
                });
            }
            
            lastReportedZone = data.zone; 
        }

        // Сбрасываем таймер "тишины" при каждом шевелении
        clearTimeout(clearZoneTimeout);
        
        // Дебаунсинг: если 10 секунд полная тишина — сбрасываем триггер зоны
        clearZoneTimeout = setTimeout(() => {
            lastReportedZone = null;
            console.log('Тишина в помещении. Зона очищена.');
        }, 10000);
    }
    // ==========================================

    // 4. Пересылаем координаты на сайт через веб-сокеты
    broadcast(data);
    
    // 5. Отвечаем плате кодом 200 OK и отдаем ей новые настройки из памяти
    res.json(deviceSettings);

    // Если была команда на ребут, сбрасываем флаг после того, как плата его прочитала
    if (deviceSettings.reboot) {
        deviceSettings.reboot = false; 
    }
});

// Логика WebSocket для обработки команд с сайта
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.type === 'settings_update') {
                if (msg.armed !== undefined) deviceSettings.armed = msg.armed;
                if (msg.sensitivity !== undefined) deviceSettings.sensitivity = msg.sensitivity * 10; // СМ в ММ
                if (msg.reboot !== undefined) deviceSettings.reboot = msg.reboot;
                if (msg.cameraIP !== undefined) {
                    cameraIP = msg.cameraIP;
                    console.log(`⚙️ Сервер обновил IP-адрес ESP32-CAM на: ${cameraIP}`);
                }
            }
        } catch (e) {}
    });
});

// Функция вещания для WebSocket
function broadcast(payload) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(payload));
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер успешно запущен на порту ${PORT}`);
});