const express  = require('express');
const QRCode   = require('qrcode');
const { v4: uuid } = require('uuid');
const pool     = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// In-memory: sessionId -> { token, expiresAt, intervalMs, handle }
const activeSessions = new Map();
// In-memory: sessionId -> Set<deviceFp>  (one device per session)
const sessionDevices = new Map();
// WebSocket clients: sessionId -> Set<ws>
const wsClients = new Map();

function broadcastToSession(sessionId, msg) {
  const clients = wsClients.get(sessionId);
  if (!clients) return;
  const data = JSON.stringify(msg);
  clients.forEach(ws => { if (ws.readyState === 1) ws.send(data); });
}

function startRotation(sessionId, intervalMs) {
  stopRotation(sessionId);
  const rotate = async () => {
    const token     = uuid();
    const expiresAt = new Date(Date.now() + intervalMs + 2000);
    const existing  = activeSessions.get(sessionId) || {};
    activeSessions.set(sessionId, { token, expiresAt, intervalMs, handle: existing.handle });
    try {
      await pool.query(
        'UPDATE sessions SET current_token=$1, token_expires_at=$2 WHERE id=$3',
        [token, expiresAt, sessionId]
      );
    } catch (e) { console.error('Token update error:', e.message); }
    broadcastToSession(sessionId, { type: 'token_update', token });
  };
  rotate();
  const handle = setInterval(rotate, intervalMs);
  const s = activeSessions.get(sessionId) || {};
  s.handle = handle;
  activeSessions.set(sessionId, s);
}

function stopRotation(sessionId) {
  const s = activeSessions.get(sessionId);
  if (s?.handle) clearInterval(s.handle);
  activeSessions.delete(sessionId);
}

// Expose for server.js
router.registerWsClient = (sessionId, ws) => {
  if (!wsClients.has(sessionId)) wsClients.set(sessionId, new Set());
  wsClients.get(sessionId).add(ws);
  ws.on('close', () => wsClients.get(sessionId)?.delete(ws));
};
router.broadcastToSession   = broadcastToSession;
router.stopRotation         = stopRotation;

// ── GET /api/attendance/courses ──────────────────────────────────────────────
router.get('/courses', authenticate, async (req, res) => {
  try {
    let rows;
    if (req.user.role === 'teacher') {
      rows = (await pool.query(
        'SELECT * FROM courses WHERE teacher_id=$1 ORDER BY name', [req.user.id]
      )).rows;
    } else {
      rows = (await pool.query(
        `SELECT c.* FROM courses c JOIN enrollments e ON e.course_id=c.id
         WHERE e.student_id=$1 ORDER BY c.name`, [req.user.id]
      )).rows;
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/attendance/sessions/start ─────────────────────────────────────
router.post('/sessions/start', authenticate, requireRole('teacher'), async (req, res) => {
  const { course_id, token_interval } = req.body;
  if (!course_id) return res.status(400).json({ error: 'course_id required' });

  const intervalSec = Math.min(60, Math.max(5, parseInt(token_interval) || 10));
  const intervalMs  = intervalSec * 1000;

  try {
    // Verify ownership
    const c = await pool.query('SELECT id FROM courses WHERE id=$1 AND teacher_id=$2', [course_id, req.user.id]);
    if (!c.rows.length) return res.status(403).json({ error: 'Not your course' });

    // End any existing active sessions for this course
    const old = await pool.query('SELECT id FROM sessions WHERE course_id=$1 AND is_active=TRUE', [course_id]);
    for (const s of old.rows) {
      stopRotation(s.id);
      sessionDevices.delete(s.id);
      await pool.query('UPDATE sessions SET is_active=FALSE, ended_at=NOW() WHERE id=$1', [s.id]);
    }

    // Create session
    const sess = (await pool.query(
      `INSERT INTO sessions (course_id, teacher_id, is_active, token_interval)
       VALUES ($1,$2,TRUE,$3) RETURNING *`,
      [course_id, req.user.id, intervalSec]
    )).rows[0];

    sessionDevices.set(sess.id, new Set());
    startRotation(sess.id, intervalMs);

    // Wait briefly for first token
    await new Promise(r => setTimeout(r, 250));
    const s = activeSessions.get(sess.id);

    const qrPayload  = JSON.stringify({ session_id: sess.id, token: s?.token });
    const qrDataUrl  = await QRCode.toDataURL(qrPayload, { width: 300, margin: 2, color: { dark: '#1a1a2e', light: '#ffffff' } });

    res.json({ session_id: sess.id, token: s?.token, qr_data_url: qrDataUrl, token_interval: intervalSec, expires_in: intervalMs });
  } catch (err) {
    console.error('Start session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/attendance/sessions/:id/qr ──────────────────────────────────────
router.get('/sessions/:id/qr', authenticate, requireRole('teacher'), async (req, res) => {
  const sid = parseInt(req.params.id);
  const s   = activeSessions.get(sid);
  if (!s) return res.status(404).json({ error: 'No active session' });
  const qrPayload = JSON.stringify({ session_id: sid, token: s.token });
  const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 300, margin: 2, color: { dark: '#1a1a2e', light: '#ffffff' } });
  res.json({ token: s.token, qr_data_url: qrDataUrl, token_interval: s.intervalMs / 1000 });
});

// ── GET /api/attendance/sessions/:id/roster ───────────────────────────────────
router.get('/sessions/:id/roster', authenticate, requireRole('teacher'), async (req, res) => {
  const sid = req.params.id;
  try {
    const sess = await pool.query('SELECT * FROM sessions WHERE id=$1 AND teacher_id=$2', [sid, req.user.id]);
    if (!sess.rows.length) return res.status(404).json({ error: 'Session not found' });

    const roster = (await pool.query(
      `SELECT u.id, u.name, u.roll_no,
              COALESCE(a.status,'absent') AS status,
              a.marked_at, a.method
       FROM enrollments e
       JOIN users u ON u.id=e.student_id
       LEFT JOIN attendance a ON a.student_id=e.student_id AND a.session_id=$1
       WHERE e.course_id=(SELECT course_id FROM sessions WHERE id=$1)
       ORDER BY u.roll_no`,
      [sid]
    )).rows;
    res.json(roster);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /api/attendance/sessions/:id/manual ────────────────────────────────
router.patch('/sessions/:id/manual', authenticate, requireRole('teacher'), async (req, res) => {
  const { student_id, status } = req.body;
  const sid = req.params.id;
  if (!['present','absent'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    await pool.query(
      `INSERT INTO attendance (session_id,student_id,status,method)
       VALUES ($1,$2,$3,'manual')
       ON CONFLICT(session_id,student_id) DO UPDATE SET status=$3,method='manual',marked_at=NOW()`,
      [sid, student_id, status]
    );
    const info = (await pool.query('SELECT name,roll_no FROM users WHERE id=$1',[student_id])).rows[0];
    const update = { student_id, student_name: info?.name, roll_no: info?.roll_no, status, method:'manual', marked_at: new Date().toISOString() };
    broadcastToSession(parseInt(sid), { type:'attendance_update', ...update });
    res.json(update);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/attendance/sessions/:id/end ────────────────────────────────────
router.post('/sessions/:id/end', authenticate, requireRole('teacher'), async (req, res) => {
  const sid = parseInt(req.params.id);
  stopRotation(sid);
  sessionDevices.delete(sid);
  await pool.query('UPDATE sessions SET is_active=FALSE,ended_at=NOW() WHERE id=$1',[sid]);
  res.json({ ok: true });
});

// ── GET /api/attendance/active-session/:courseId ──────────────────────────────
router.get('/active-session/:courseId', authenticate, async (req, res) => {
  try {
    const sess = (await pool.query(
      'SELECT id,started_at FROM sessions WHERE course_id=$1 AND is_active=TRUE LIMIT 1',
      [req.params.courseId]
    )).rows[0];
    if (!sess) return res.json({ active: false });

    // Check if student already marked
    let already = null;
    if (req.user.role === 'student') {
      const a = (await pool.query(
        'SELECT status FROM attendance WHERE session_id=$1 AND student_id=$2',
        [sess.id, req.user.id]
      )).rows[0];
      already = a?.status || null;
    }
    res.json({ active: true, session_id: sess.id, started_at: sess.started_at, already_marked: !!already, current_status: already });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/attendance/mark ─────────────────────────────────────────────────
// Student marks attendance — device fingerprint enforced (one device per session)
router.post('/mark', authenticate, requireRole('student'), async (req, res) => {
  const { session_id, token, device_fp } = req.body;
  if (!session_id || !token) return res.status(400).json({ error: 'session_id and token required' });

  try {
    // Check session active
    const sess = (await pool.query(
      'SELECT * FROM sessions WHERE id=$1 AND is_active=TRUE', [session_id]
    )).rows[0];
    if (!sess) return res.status(400).json({ error: 'Session not active' });

    // Validate token
    const live = activeSessions.get(session_id);
    const validToken = live?.token || sess.current_token;
    if (token !== validToken)
      return res.status(400).json({ error: 'QR code expired — please scan the latest code on the projector.' });

    // Token expiry
    const exp = live?.expiresAt || new Date(sess.token_expires_at);
    if (new Date() > exp)
      return res.status(400).json({ error: 'QR token expired. Scan the current code.' });

    // Verify enrolled
    const enroll = await pool.query(
      'SELECT id FROM enrollments WHERE student_id=$1 AND course_id=$2',
      [req.user.id, sess.course_id]
    );
    if (!enroll.rows.length) return res.status(403).json({ error: 'You are not enrolled in this course.' });

    // ── One device per session guard ──────────────────────────────────────────
    if (device_fp) {
      const devices = sessionDevices.get(session_id) || new Set();
      // Check if THIS student's fp is already mapped to another student
      const existing = (await pool.query(
        'SELECT student_id FROM attendance WHERE session_id=$1 AND device_fp=$2',
        [session_id, device_fp]
      )).rows[0];
      if (existing && existing.student_id !== req.user.id) {
        return res.status(403).json({ error: 'This device has already been used to mark attendance for another student in this session.' });
      }
      devices.add(device_fp);
      sessionDevices.set(session_id, devices);
    }

    // Get client IP
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';

    // Mark attendance
    await pool.query(
      `INSERT INTO attendance (session_id,student_id,status,method,device_fp,ip_address)
       VALUES ($1,$2,'present','qr',$3,$4)
       ON CONFLICT(session_id,student_id) DO UPDATE SET status='present',method='qr',marked_at=NOW(),device_fp=$3,ip_address=$4`,
      [session_id, req.user.id, device_fp || null, ip]
    );

    broadcastToSession(session_id, {
      type:'attendance_update',
      student_id: req.user.id,
      student_name: req.user.name,
      roll_no: req.user.roll_no,
      status: 'present',
      method: 'qr',
      marked_at: new Date().toISOString()
    });

    res.json({ ok: true, message: 'Attendance marked!' });
  } catch (err) {
    console.error('Mark error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/attendance/history/:courseId ─────────────────────────────────────
router.get('/history/:courseId', authenticate, requireRole('student'), async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT s.date, s.started_at, COALESCE(a.status,'absent') AS status, a.method
       FROM sessions s
       LEFT JOIN attendance a ON a.session_id=s.id AND a.student_id=$1
       WHERE s.course_id=$2 ORDER BY s.date DESC`,
      [req.user.id, req.params.courseId]
    )).rows;
    const total   = rows.length;
    const present = rows.filter(r => r.status==='present').length;
    res.json({ sessions: rows, total, present, percentage: total > 0 ? Math.round((present/total)*100) : 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
