const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api'); // <-- ПІДКЛЮЧАЄМО TELEGRAM

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ==========================================
// 🔴 НАЛАШТУВАННЯ TELEGRAM (Встав свої дані)
// ==========================================
const TELEGRAM_TOKEN = 'ТВІЙ_ТОКЕН_ВІД_BOTFATHER'; 
const CHAT_ID = 'ТВІЙ_CHAT_ID';

// Створюємо бота. polling: false, тому що ми тільки відправляємо повідомлення
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false }); 

// ==========================================

// Глобальний стан налаштувань системи
let deviceSettings = {
    armed: true,         // Чи увімкнений радар
    sensitivity: 300,    // Фільтр дистанції в міліметрах
    reboot: false        // Прапорець перезавантаження
}; 

// Константи для контролю статусу
let lastPingTime = 0;
let isSensorOnline = false;
const ESP_SECRET_TOKEN = "RadarView-ESP32-C3-SecretKey-2026";

// Змінні для анти-спаму Телеграм
let lastReportedZone = null;
let clearZoneTimeout = null;

// Налаштування статики: тепер сервер коректно знайде файли і в корені, і в /public
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Головна сторінка
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Таймер перевірки зв'язку (раз на секунду)
setInterval(() => {
    const now = Date.now();
    if (isSensorOnline && (now - lastPingTime > 15000)) {
        isSensorOnline = false;
        console.log('❌ Зв\'язок з ESP32 втрачено!');
        broadcast({ type: 'status', status: 'offline' });
        
        // Опціонально: повідомлення про відключення радара
        // bot.sendMessage(CHAT_ID, '⚠️ Увага: Радар відключився від мережі!').catch(console.error);
    }
}, 1000);

// API для отримання даних від ESP32
app.post('/api/data', (req, res) => {
    const data = req.body;
    
    // 1. Перевірка токена
    if (data.token !== ESP_SECRET_TOKEN) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // 2. Оновлення статусу онлайн
    lastPingTime = Date.now();
    if (!isSensorOnline) {
        isSensorOnline = true;
        console.log('✅ ESP32 знову в мережі!');
        broadcast({ type: 'status', status: 'online' });
    }

    // 3. Логування координат (потрібно для калібрування зон)
    console.log(`📍 Координати: X=${data.x}, Y=${data.y} | Зона: ${data.zone}`);
    
    // ==========================================
    // ЛОГІКА ПОВІДОМЛЕНЬ TELEGRAM
    // ==========================================
    // Якщо система під охороною (armed) і є рух
    if (deviceSettings.armed && data.movement) {
        // Якщо людина перейшла в НОВУ зону (або щойно з'явилася)
        if (data.zone !== lastReportedZone) {
            
            // Відправляємо повідомлення в ТГ
            const msg = `🚨 Виявлено рух!\n📍 Зона: ${data.zone}\n⏱ Час: ${new Date().toLocaleTimeString('uk-UA')}`;
            bot.sendMessage(CHAT_ID, msg).catch(err => console.error("Помилка Telegram:", err.message));
            
            lastReportedZone = data.zone; // Запам'ятовуємо, де зараз людина
        }

        // Скидаємо таймер "тиші" при кожному русі
        clearTimeout(clearZoneTimeout);
        
        // Якщо 10 секунд немає руху — забуваємо зону. 
        // При наступному русі бот знову надішле сповіщення.
        clearZoneTimeout = setTimeout(() => {
            lastReportedZone = null;
            console.log('Тиша. Зону очищено.');
        }, 10000);
    }
    // ==========================================

    // 4. Розсилка даних усім підключеним браузерам
    broadcast(data);
    
    // 5. Відповідь платі з актуальними налаштуваннями
    res.json(deviceSettings);

    // Скидання прапорця перезавантаження після відправки підтвердження
    if (deviceSettings.reboot) {
        deviceSettings.reboot = false; 
    }
});

// WebSocket логіка
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.type === 'settings_update') {
                if (msg.armed !== undefined) deviceSettings.armed = msg.armed;
                // Конвертуємо СМ у ММ для датчика
                if (msg.sensitivity !== undefined) deviceSettings.sensitivity = msg.sensitivity * 10;
                if (msg.reboot !== undefined) deviceSettings.reboot = msg.reboot;
            }
        } catch (e) {}
    });
});

// Функція для масової розсилки повідомлень через WebSocket
function broadcast(payload) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(payload));
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер Pidkamennyi O.M. запущено на порту ${PORT}`);
});