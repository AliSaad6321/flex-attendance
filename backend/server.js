require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');
const jwt        = require('jsonwebtoken');

const authRoutes       = require('./routes/auth');
const attendanceRoutes = require('./routes/attendance');
const excelRoutes      = require('./routes/excel');

const app    = express();
const server = http.createServer(app);

app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

app.use('/api/auth',       authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/excel',      excelRoutes);
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date() }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// WebSocket
const wss = new WebSocket.Server({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url       = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = parseInt(url.searchParams.get('sessionId'));
  const token     = url.searchParams.get('token');
  if (!sessionId || !token) { ws.close(1008, 'Bad params'); return; }
  try { jwt.verify(token, process.env.JWT_SECRET); }
  catch { ws.close(1008, 'Bad token'); return; }
  attendanceRoutes.registerWsClient(sessionId, ws);
  ws.send(JSON.stringify({ type: 'connected', session_id: sessionId }));
  ws.on('error', console.error);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎓 FLEX v3 · http://localhost:${PORT}`);
  console.log(`📡 WebSocket · ws://localhost:${PORT}/ws`);
  console.log(`🗄️  Neon DB  · ${process.env.DATABASE_URL ? '✓ Configured' : '✗ NOT SET'}\n`);
});
