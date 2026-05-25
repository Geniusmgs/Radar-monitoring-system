const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api'); // <-- ПІДКЛЮЧАЄМО TELEGRAM
const axios = require('axios'); // <-- НОВЕ: ПІДКЛЮЧАЄМО AXIOS ДЛЯ РОБОТИ З КАМЕРОЮ

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ==========================================
// 🔴 НАЛАШТУВАННЯ СИСТЕМИ (Встав свої дані)
// ==========================================
const TELEGRAM_TOKEN = 'ТВІЙ_ТОКЕН_ВІД_BOTFATHER'; 
const CHAT_ID = 'ТВІЙ_CHAT_ID';

// Локальна IP-адреса твоєї ESP32-CAM (вкажи ту, яку видасть роутер)
let cameraIP = '192.168.1.50'; 
// ==========================================

// Глобальний стан налаштувань системи
let deviceSettings = {
    armed: true,         // Чи увімкнений радар
    sensitivity: 300,    // Фільтр дистанції в міліметрах
    reboot: false        // Прапорець перезавантаження
}; 

// Константи для контролю статусу зв'язку
let lastPingTime = 0;
let isSensorOnline = false;
const ESP_SECRET_TOKEN = "RadarView-ESP32-C3-SecretKey-2026";

// Змінні для анти-спаму Телеграм
let lastReportedZone = null;
let clearZoneTimeout = null;

// Налаштування статики для Express
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Головна сторінка веб-інтерфейсу
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

// API для отримання даних від ESP32-C3 (радара)
app.post('/api/data', (req, res) => {
    const data = req.body;
    
    // 1. Перевірка секретного токена безпеки
    if (data.token !== ESP_SECRET_TOKEN) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // 2. Оновлення статусу онлайн для залізяки
    lastPingTime = Date.now();
    if (!isSensorOnline) {
        isSensorOnline = true;
        console.log('✅ ESP32 знову в мережі!');
        broadcast({ type: 'status', status: 'online' });
    }

    // 3. Логування координат у консоль сервера
    console.log(`📍 Координати: X=${data.x}, Y=${data.y} | Зона: ${data.zone}`);
    
    // ==========================================
    // ЛОГІКА ПОВІДОМЛЕНЬ ТА ФОТОФІКСАЦІЇ TELEGRAM
    // ==========================================
    if (deviceSettings.armed && data.movement) {
        // Якщо людина перейшла в НОВУ зону (захист від повторних сповіщень)
        if (data.zone !== lastReportedZone) {
            
            // А) Спочатку надсилаємо швидке текстове повідомлення
            const msg = `🚨 Виявлено рух!\n📍 Зона: ${data.zone}\n⏱ Час: ${new Date().toLocaleTimeString('uk-UA')}`;
            bot.sendMessage(CHAT_ID, msg).catch(err => console.error("Помилка Telegram бота:", err.message));
            
            // Б) Робимо асинхронний запит до камери для отримання стоп-кадру
            if (cameraIP) {
                console.log(`📸 Запит фотофіксації з камери: http://${cameraIP}/capture`);
                
                axios({
                    method: 'get',
                    url: `http://${cameraIP}:80/capture`, // Стандартний ендпоінт скетчу ESP32-CAM для одиночного фото
                    responseType: 'stream',               // Отримуємо як бінарний потік
                    timeout: 5000                         // Таймаут 5 секунд, якщо камера зависла
                })
                .then(response => {
                    // Перенаправляємо отриманий потік даних прямо в Telegram API
                    bot.sendPhoto(CHAT_ID, response.data, { 
                        caption: `📸 Фіксація об'єкта у зоні: ${data.zone}` 
                    })
                    .then(() => console.log(`✅ Фото успішно надіслано в Telegram`))
                    .catch(photoErr => console.error("Не вдалося надіслати фото в ТГ чат:", photoErr.message));
                })
                .catch(camErr => {
                    console.error(`❌ Не вдалося отримати кадр з ESP32-CAM (${camErr.message}). Перевірте IP або живлення камери.`);
                });
            }
            
            lastReportedZone = data.zone; // Фіксуємо поточну зону
        }

        // Скидаємо таймер "тиші" при кожному новому русі
        clearTimeout(clearZoneTimeout);
        
        // Дебаунсинг: якщо 10 секунд повна тиша — скидаємо тригер зони
        clearZoneTimeout = setTimeout(() => {
            lastReportedZone = null;
            console.log('Тиша в приміщенні. Зону очищено.');
        }, 10000);
    }
    // ==========================================

    // 4. Ретрансляція координат браузерам через WebSocket
    broadcast(data);
    
    // 5. Відповідь радіомодулю з актуальною конфігурацією охорони
    res.json(deviceSettings);

    if (deviceSettings.reboot) {
        deviceSettings.reboot = false; 
    }
});

// Логіка WebSocket для обробки налаштувань з сайту
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.type === 'settings_update') {
                if (msg.armed !== undefined) deviceSettings.armed = msg.armed;
                if (msg.sensitivity !== undefined) deviceSettings.sensitivity = msg.sensitivity * 10;
                if (msg.reboot !== undefined) deviceSettings.reboot = msg.reboot;
                
                // НОВЕ: можливість динамічно оновлювати IP камери прямо з сайту
                if (msg.cameraIP !== undefined) {
                    cameraIP = msg.cameraIP;
                    console.log(`⚙️ Сервер оновив IP-адресу ESP32-CAM на: ${cameraIP}`);
                }
            }
        } catch (e) {}
    });
});

// Функція широкомовної розсилки для WebSocket
function broadcast(payload) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(payload));
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер системи безпеки запущено на порту ${PORT}`);
});