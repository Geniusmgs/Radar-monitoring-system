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

// Локальний IP-адрес камери (оновлюється з сайту, але для хмари він потрібен лише для трансляції на клієнті)
let cameraIP = '192.168.1.50'; 

// Глобальний стан налаштувань системи
let deviceSettings = {
    armed: true,         // Чи увімкнена охорона
    sensitivity: 300,    // Фільтр дистанції в міліметрах (30 см)
    reboot: false        // Прапорець перезавантаження
}; 

// Константи для контролю статусу зв'язку
let lastPingTime = 0;
let isSensorOnline = false;
const ESP_SECRET_TOKEN = "RadarView-ESP32-C3-SecretKey-2026";

// Змінні для антиспаму в Telegram
let lastReportedZone = null;
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
        console.log('❌ Связь с ESP32 утеряна!');
        broadcast({ type: 'status', status: 'offline' });
    }
}, 1000);

// API для прийому даних від ESP32-C3
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
        console.log('✅ ESP32 снова в сети!');
        broadcast({ type: 'status', status: 'online' });
    }

    // 3. Логування координат
    console.log(`📍 Координаты: X=${data.rawX || 0}, Y=${data.rawY || 0} | Зона: ${data.zone}`);
    
    // ==========================================
    // ЛОГІКА ТЕКСТОВИХ ПОВІДОМЛЕНЬ TELEGRAM
    // Фото відправляє сама камера напряму (M2M)
    // ==========================================
    if (deviceSettings.armed && data.movement && data.zone && data.zone !== 'none' && data.zone !== 'out_of_bounds') {
        
        // Антиспам: реагуємо, тільки якщо це НОВА зона
        if (data.zone !== lastReportedZone) {
            
            // Відправляємо швидке текстове повідомлення (фото прилетить слідом від самої ESP32-CAM)
            const msg = `🚨 Виявлено рух!\n📍 Зона: ${data.zone}\n⏱ Час: ${new Date().toLocaleTimeString('uk-UA')}`;
            bot.sendMessage(CHAT_ID, msg).catch(err => console.error("Ошибка Telegram отправки текста:", err.message));
            
            lastReportedZone = data.zone; 
        }

        // Скидаємо таймер тиші при кожному русі
        clearTimeout(clearZoneTimeout);
        
        // Якщо 10 секунд повна тиша — скидаємо зону, щоб при наступному русі бот знову надіслав текст
        clearZoneTimeout = setTimeout(() => {
            lastReportedZone = null;
            console.log('Тишина в помещении. Зона очищена.');
        }, 10000);
    }
    // ==========================================

    // 4. Пересилаємо координати на сайт
    broadcast(data);
    
    // 5. Відповідаємо платі (200 OK) і віддаємо актуальні налаштування
    res.json(deviceSettings);

    // Скидаємо прапорець перезавантаження, якщо він був
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