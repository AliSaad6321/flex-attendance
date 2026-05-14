const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

let qrInterval = null;
let codeInterval = null;

function generateShortCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function rotateQRToken(intervalMs) {
  const token = uuidv4();
  const expires = new Date(Date.now() + intervalMs + 2000);
  await pool.query(
    `UPDATE active_session SET qr_token = $1, qr_token_expires_at = $2 WHERE is_active = true`,
    [token, expires]
  );
  global.broadcast({ type: 'qr_token', token, expiresAt: expires.toISOString(), intervalMs });
}

async function rotateCodeToken(intervalMs) {
  const code = generateShortCode();
  const expires = new Date(Date.now() + intervalMs + 2000);
  await pool.query(
    `UPDATE active_session SET code_token = $1, code_expires_at = $2 WHERE is_active = true`,
    [code, expires]
  );
  global.broadcast({ type: 'code_token', code, expiresAt: expires.toISOString(), intervalMs });
}

// POST /api/session/start
router.post('/start', async (req, res) => {
  try {
    const { courseName, qrInterval: qrMs, codeInterval: codeMs } = req.body;
    const teacherPassword = process.env.TEACHER_PASSWORD || 'teacher123';

    if (!courseName) return res.status(400).json({ error: 'Course name is required' });

    const qrIntervalMs = Math.min(Math.max(parseInt(qrMs) || 10000, 5000), 60000);
    const codeIntervalMs = Math.min(Math.max(parseInt(codeMs) || 15000, 5000), 60000);

    // Clear any existing session
    await pool.query(`DELETE FROM active_session`);
    await pool.query(`DELETE FROM session_students`);
    await pool.query(`DELETE FROM session_attendance`);
    await pool.query(`DELETE FROM previous_attendance`);

    const initToken = uuidv4();
    const initCode = generateShortCode();
    const now = new Date();

    const hash = await bcrypt.hash(teacherPassword, 10);

    await pool.query(
      `INSERT INTO active_session 
       (course_name, teacher_password_hash, qr_token, qr_token_expires_at, qr_interval_ms, 
        code_token, code_interval_ms, code_expires_at, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
      [
        courseName,
        hash,
        initToken,
        new Date(Date.now() + qrIntervalMs + 2000),
        qrIntervalMs,
        initCode,
        codeIntervalMs,
        new Date(Date.now() + codeIntervalMs + 2000)
      ]
    );

    // Start rotation intervals
    if (qrInterval) clearInterval(qrInterval);
    if (codeInterval) clearInterval(codeInterval);

    qrInterval = setInterval(() => rotateQRToken(qrIntervalMs), qrIntervalMs);
    codeInterval = setInterval(() => rotateCodeToken(codeIntervalMs), codeIntervalMs);

    res.json({
      success: true,
      courseName,
      qrToken: initToken,
      code: initCode,
      qrIntervalMs,
      codeIntervalMs
    });
  } catch (err) {
    console.error('Start session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session/end
router.post('/end', async (req, res) => {
  try {
    if (qrInterval) { clearInterval(qrInterval); qrInterval = null; }
    if (codeInterval) { clearInterval(codeInterval); codeInterval = null; }

    await pool.query(`UPDATE active_session SET is_active = false WHERE is_active = true`);
    global.broadcast({ type: 'session_ended' });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session/status
router.get('/status', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, course_name, qr_token, qr_token_expires_at, qr_interval_ms,
              code_token, code_expires_at, code_interval_ms, date, started_at, is_active
       FROM active_session WHERE is_active = true LIMIT 1`
    );
    if (result.rows.length === 0) return res.json({ active: false });

    const s = result.rows[0];
    res.json({
      active: true,
      courseName: s.course_name,
      qrToken: s.qr_token,
      qrExpiresAt: s.qr_token_expires_at,
      qrIntervalMs: s.qr_interval_ms,
      code: s.code_token,
      codeExpiresAt: s.code_expires_at,
      codeIntervalMs: s.code_interval_ms,
      date: s.date
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session/verify-teacher - just check env password
router.post('/verify-teacher', async (req, res) => {
  const { password } = req.body;
  const teacherPassword = process.env.TEACHER_PASSWORD || 'teacher123';
  if (password === teacherPassword) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

module.exports = router;
