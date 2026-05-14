require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const pool = require('./db/pool');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Broadcast to all WebSocket clients
global.broadcast = (data) => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
};

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

// Serve frontend
app.use(express.static(path.join(__dirname, '../frontend/public')));

// Routes
app.use('/api/session', require('./routes/session'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/excel', require('./routes/excel'));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Initialize DB tables on startup
async function initDB() {
  const fs = require('fs');
  const schema = fs.readFileSync(path.join(__dirname, 'db/schema.sql'), 'utf8');
  try {
    await pool.query(schema);
    console.log('✅ DB tables ready');
  } catch (err) {
    console.error('DB init error:', err.message);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  await initDB();
  console.log(`🚀 FLEX Attendance v4 running on port ${PORT}`);
});

// WebSocket connection
wss.on('connection', (ws) => {
  ws.on('error', console.error);
});
