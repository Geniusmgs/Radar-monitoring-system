const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ==========================================
// 🔴 НАЛАШТУВАННЯ TELEGRAM 
// ==========================================
const TELEGRAM_TOKEN = '8925155619:AAEQXMrXe5XyhrnFbGW-vBhoy3f4d5X_R1U'; 
const CHAT_ID = '1164801711';

// Створюємо бота. polling: false, оскільки ми лише відправляємо повідомлення
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false }); 

// Локальний IP-адрес камери (оновлюється з сайту)
let cameraIP = '192.168.1.50'; 

// Глобальний стан налаштувань системи
let deviceSettings = {
    armed: true,         // Чи увімкнена охорона
    sensitivity: 300,    // Фільтр дистанції в міліметрах (30 см)
    reboot: false,       // Прапорець перезавантаження
    deepSleep: false     // Прапорець режиму сну (за замовчуванням вимкнено для плавного трекінгу)
}; 

// Константи для контролю статусу зв'язку
let lastPingTime = 0;
let isSensorOnline = false;
const ESP_SECRET_TOKEN = "RadarView-ESP32-C3-SecretKey-2026";

// Змінні для антиспаму в Telegram (Тепер об'єкт для 3-х цілей!)
let lastReportedZones = {};
let clearZoneTimeout = null;

// Налаштування роздачі статики (веб-сайту)
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Головна сторінка
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Таймер перевірки зв'язку з радаром (раз на секунду)
setInterval(() => {
    const now = Date.now();
    if (isSensorOnline && (now - lastPingTime > 15000)) {
        isSensorOnline = false;
        console.log('❌ Зв\'язок з ESP32 втрачено!');
        broadcast({ type: 'status', status: 'offline' });
    }
}, 1000);

// API для прийому даних від ESP32-C3
app.post('/api/data', (req, res) => {
    const data = req.body;
    
    if (data.token !== ESP_SECRET_TOKEN) return res.status(403).json({ error: 'Unauthorized' });
    
    lastPingTime = Date.now();
    if (!isSensorOnline) {
        isSensorOnline = true;
        broadcast({ type: 'status', status: 'online' });
    }

    // --- НОВА ЛОГІКА ДЛЯ 3-Х ЦІЛЕЙ ---
    if (deviceSettings.armed && data.movement && data.targets) {
        data.targets.forEach(target => {
            // Перевіряємо, чи ціль валідна (не нульова)
            if (target.zone && target.zone !== 'none' && target.zone !== 'out_of_bounds' && target.x !== 0) {
                
                // Логування в консоль сервера
                console.log(`📍 Ціль ${target.id}: X=${target.x}, Y=${target.y} | Зона: ${target.zone}`);
                
                // Індивідуальний антиспам для КОЖНОЇ цілі
                if (target.zone !== lastReportedZones[target.id]) {
                    const msg = `🚨 Виявлено рух (Ціль ${target.id})!\n📍 Зона: ${target.zone}\n⏱ Час: ${new Date().toLocaleTimeString('uk-UA')}`;
                    bot.sendMessage(CHAT_ID, msg).catch(e => console.error("Помилка відправки в Telegram:", e.message));
                    
                    lastReportedZones[target.id] = target.zone; // Запам'ятовуємо зону для конкретної цілі
                }
            }
        });

        // Скидаємо глобальний таймер тиші при кожному русі
        clearTimeout(clearZoneTimeout);
        clearZoneTimeout = setTimeout(() => {
            lastReportedZones = {}; // Очищуємо пам'ять зон після 10 секунд повної тиші
            console.log('Тиша в приміщенні. Зони очищено.');
        }, 10000);
    }
    
    // Пересилаємо весь масив targets на сайт
    broadcast(data); 
    
    // Відповідаємо платі (200 OK) і віддаємо актуальні налаштування
    res.json(deviceSettings);

    // Скидаємо прапорець перезавантаження після того, як відправили його на плату
    if (deviceSettings.reboot) {
        deviceSettings.reboot = false; 
    }
});

// Логіка WebSocket для налаштувань з сайту
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.type === 'settings_update') {
                if (msg.armed !== undefined) deviceSettings.armed = msg.armed;
                if (msg.sensitivity !== undefined) deviceSettings.sensitivity = msg.sensitivity * 10; // Перевід СМ у ММ
                if (msg.reboot !== undefined) deviceSettings.reboot = msg.reboot;
                if (msg.deepSleep !== undefined) deviceSettings.deepSleep = msg.deepSleep; // Оновлюємо стан режиму сну
                if (msg.cameraIP !== undefined) {
                    cameraIP = msg.cameraIP;
                    console.log(`⚙️ Сервер оновив IP-адресу ESP32-CAM на: ${cameraIP}`);
                }
            }
        } catch (e) {}
    });
});

function broadcast(payload) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(payload));
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер успішно запущено на порту ${PORT}`);
});