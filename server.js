// server.js - Main Backend Server
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

// Import services
const mqttService = require('./services/mqttService');
const websocketService = require('./services/websocketService');
const { logger } = require('./utils/logger');

// Import routes
const apiRoutes = require('./routes/api');
const machineRoutes = require('./routes/machines');
const alertRoutes = require('./routes/alerts');
const authRoutes = require('./routes/auth');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
        methods: ["GET", "POST", "PUT", "DELETE"],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

// ============================================
// MIDDLEWARE
// ============================================

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
}));

// Compression
app.use(compression());

// CORS
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
app.use(express.static('public'));

// Global rate limiter
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) || 60000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', limiter);

// Request logging
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.url} - ${req.ip}`);
    next();
});

// ============================================
// DATABASE CONNECTION
// ============================================

mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => logger.info('✅ MongoDB connected successfully'))
.catch(err => logger.error('❌ MongoDB connection error:', err));

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        services: {
            mqtt: mqttService.isConnected(),
            mongodb: mongoose.connection.readyState === 1,
            websocket: true
        }
    });
});

// API Routes
app.use('/api', apiRoutes);
app.use('/api/machines', machineRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/auth', authRoutes);

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
    logger.error(err.stack);
    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// ============================================
// WEB SOCKET SERVICE
// ============================================

websocketService.init(io);

// ============================================
// MQTT SERVICE
// ============================================

mqttService.connect();

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logger.info(`
    ╔══════════════════════════════════════════════════════════╗
    ║                                                          ║
    ║     🛡️ YANTRA KAVACH BACKEND SERVER 🛡️                   ║
    ║                                                          ║
    ║     Server: http://localhost:${PORT}                      ║
    ║     WebSocket: ws://localhost:${PORT}                     ║
    ║     Health: http://localhost:${PORT}/health               ║
    ║                                                          ║
    ║     Environment: ${process.env.NODE_ENV || 'development'}                   ║
    ║     MongoDB: ${mongoose.connection.readyState === 1 ? '✅' : '❌'}                     ║
    ║                                                          ║
    ╚══════════════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        logger.info('HTTP server closed');
        mongoose.connection.close(false, () => {
            logger.info('MongoDB connection closed');
            process.exit(0);
        });
    });
});