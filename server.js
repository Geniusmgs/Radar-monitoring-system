const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Глобальное состояние настроек системы
let deviceSettings = {
    armed: true,         // Включен ли радар
    sensitivity: 300,    // Фильтр дистанции в миллиметрах
    reboot: false        // Флаг перезагрузки
}; 

// Константы для контроля статуса
let lastPingTime = 0;
let isSensorOnline = false;
const ESP_SECRET_TOKEN = "RadarView-ESP32-C3-SecretKey-2026";

// Настройка статики: теперь сервер корректно найдет файлы и в корне, и в /public
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Главная страница
app.get('/', (req, res) => {
    // Безопасный способ отправки файла без дублирования заголовков
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Таймер проверки связи (раз в секунду)
setInterval(() => {
    const now = Date.now();
    if (isSensorOnline && (now - lastPingTime > 15000)) {
        isSensorOnline = false;
        console.log('❌ Связь с ESP32 потеряна!');
        
        broadcast({ type: 'status', status: 'offline' });
    }
}, 1000);

// API для получения данных от ESP32
app.post('/api/data', (req, res) => {
    const data = req.body;
    
    // 1. Проверка токена
    if (data.token !== ESP_SECRET_TOKEN) {
        console.log('⚠️ Попытка доступа с неверным токеном!');
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // 2. Обновление статуса онлайн
    lastPingTime = Date.now();
    if (!isSensorOnline) {
        isSensorOnline = true;
        console.log('✅ ESP32 снова в сети!');
        broadcast({ type: 'status', status: 'online' });
    }

    // 3. Логирование координат (нужно для калибровки твоих 10 зон)
    // Теперь ты будешь видеть в логах Render, куда именно ты наступил
    console.log(`📍 Координаты: X=${data.x}, Y=${data.y} | Зона: ${data.zone}`);
    
    // 4. Рассылка данных всем подключенным браузерам
    broadcast(data);
    
    // 5. Ответ плате с актуальными настройками
    res.json(deviceSettings);

    // Сброс флага перезагрузки после отправки подтверждения
    if (deviceSettings.reboot) {
        console.log("🚀 Команда на перезагрузку успешно передана устройству.");
        deviceSettings.reboot = false; 
    }
});

// WebSocket логика
wss.on('connection', (ws) => {
    console.log('🌐 Новый клиент подключился к панели управления');

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.type === 'settings_update') {
                if (msg.armed !== undefined) deviceSettings.armed = msg.armed;
                // Конвертируем СМ в ММ для датчика
                if (msg.sensitivity !== undefined) deviceSettings.sensitivity = msg.sensitivity * 10;
                if (msg.reboot !== undefined) deviceSettings.reboot = msg.reboot;
                
                console.log('⚙️ Настройки обновлены:', deviceSettings);
            }
        } catch (e) {
            console.error("Ошибка парсинга настроек:", e);
        }
    });

    ws.on('close', () => console.log('🔌 Клиент отключился'));
});

// Функция для массовой рассылки сообщений через WebSocket
function broadcast(payload) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(payload));
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер Pidkamennyi O.M. запущен на порту ${PORT}`);
// --- ЛОГИКА ЗУМА КАРТЫ (С памятью) ---
        const mapZoomSlider = document.getElementById('map-zoom-slider');
        const mapScalerObj = document.querySelector('.map-scaler');

        // Читаем сохраненный масштаб из памяти (или ставим 0.6 по умолчанию)
        let currentMapZoom = parseFloat(localStorage.getItem('mapScaleLevel')) || 0.6;
        
        // Применяем сохраненный масштаб при старте страницы
        mapZoomSlider.value = currentMapZoom;
        mapScalerObj.style.transform = `scale(${currentMapZoom})`;

        // Слушаем движения ползунка
        mapZoomSlider.addEventListener('input', (e) => {
            currentMapZoom = e.target.value;
            // Плавно меняем размер
            mapScalerObj.style.transform = `scale(${currentMapZoom})`;
            // Сохраняем настройку, чтобы после F5 зум остался таким же
            localStorage.setItem('mapScaleLevel', currentMapZoom);
        });
});