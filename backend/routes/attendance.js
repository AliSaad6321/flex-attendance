const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// POST /api/attendance/scan - mark attendance via QR token
router.post('/scan', async (req, res) => {
  try {
    const { rollNo, token, deviceFingerprint } = req.body;

    if (!rollNo || !token) return res.status(400).json({ error: 'Roll number and token required' });

    // Check session active
    const sessionResult = await pool.query(
      `SELECT id, qr_token, qr_token_expires_at FROM active_session WHERE is_active = true LIMIT 1`
    );
    if (sessionResult.rows.length === 0) return res.status(400).json({ error: 'No active session' });

    const session = sessionResult.rows[0];

    // Validate token
    if (token !== session.qr_token) {
      return res.status(400).json({ error: 'QR code expired. Please scan the latest code from the projector.' });
    }
    if (new Date() > new Date(session.qr_token_expires_at)) {
      return res.status(400).json({ error: 'QR code has expired. Please scan the new code.' });
    }

    return await markAttendance(rollNo, deviceFingerprint, 'qr', res);
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/attendance/code - mark attendance via 6-digit code
router.post('/code', async (req, res) => {
  try {
    const { rollNo, code, deviceFingerprint } = req.body;

    if (!rollNo || !code) return res.status(400).json({ error: 'Roll number and code required' });

    const sessionResult = await pool.query(
      `SELECT id, code_token, code_expires_at FROM active_session WHERE is_active = true LIMIT 1`
    );
    if (sessionResult.rows.length === 0) return res.status(400).json({ error: 'No active session' });

    const session = sessionResult.rows[0];

    if (code.toString() !== session.code_token.toString()) {
      return res.status(400).json({ error: 'Invalid code. Please check the code shown below the QR.' });
    }
    if (new Date() > new Date(session.code_expires_at)) {
      return res.status(400).json({ error: 'Code has expired. Please use the new code.' });
    }

    return await markAttendance(rollNo, deviceFingerprint, 'code', res);
  } catch (err) {
    console.error('Code error:', err);
    res.status(500).json({ error: err.message });
  }
});

async function markAttendance(rollNo, deviceFingerprint, method, res) {
  const normalizedRoll = rollNo.trim().toUpperCase();

  // Check student exists
  const studentResult = await pool.query(
    `SELECT * FROM session_students WHERE UPPER(roll_no) = $1`, [normalizedRoll]
  );
  if (studentResult.rows.length === 0) {
    return res.status(400).json({ error: `Roll number ${rollNo} not found in this class. Please check your roll number.` });
  }
  const student = studentResult.rows[0];

  // Check if already marked present
  const existing = await pool.query(
    `SELECT * FROM session_attendance WHERE UPPER(roll_no) = $1`, [normalizedRoll]
  );

  if (existing.rows.length > 0 && existing.rows[0].status === 'present') {
    return res.status(400).json({ error: `${student.name}, your attendance is already marked.` });
  }

  // Check device fingerprint - one device per session
  if (deviceFingerprint) {
    const deviceCheck = await pool.query(
      `SELECT roll_no FROM session_attendance WHERE device_fingerprint = $1 AND status = 'present'`,
      [deviceFingerprint]
    );
    if (deviceCheck.rows.length > 0 && deviceCheck.rows[0].roll_no.toUpperCase() !== normalizedRoll) {
      return res.status(400).json({
        error: 'This device has already been used to mark attendance for another student this session.'
      });
    }
  }

  // Upsert attendance
  await pool.query(
    `INSERT INTO session_attendance (roll_no, status, marked_at, method, device_fingerprint)
     VALUES ($1, 'present', NOW(), $2, $3)
     ON CONFLICT (roll_no) DO UPDATE SET status = 'present', marked_at = NOW(), method = $2, device_fingerprint = $3`,
    [student.roll_no, method, deviceFingerprint || null]
  );

  // Broadcast update
  const rosterResult = await getRoster();
  global.broadcast({ type: 'attendance_update', roster: rosterResult });

  return res.json({ success: true, message: `✅ Attendance marked for ${student.name}` });
}

// GET /api/attendance/roster
router.get('/roster', async (req, res) => {
  try {
    const roster = await getRoster();
    res.json(roster);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getRoster() {
  const result = await pool.query(`
    SELECT s.serial_no, s.roll_no, s.name,
           COALESCE(a.status, 'absent') as status,
           a.marked_at, a.method
    FROM session_students s
    LEFT JOIN session_attendance a ON UPPER(a.roll_no) = UPPER(s.roll_no)
    ORDER BY s.serial_no
  `);
  return result.rows;
}

// POST /api/attendance/override - manual toggle by teacher
router.post('/override', async (req, res) => {
  try {
    const { rollNo, status } = req.body;
    if (!rollNo || !['present', 'absent'].includes(status)) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const normalizedRoll = rollNo.trim().toUpperCase();
    const studentResult = await pool.query(
      `SELECT * FROM session_students WHERE UPPER(roll_no) = $1`, [normalizedRoll]
    );
    if (studentResult.rows.length === 0) return res.status(404).json({ error: 'Student not found' });

    const student = studentResult.rows[0];

    if (status === 'present') {
      await pool.query(
        `INSERT INTO session_attendance (roll_no, status, marked_at, method)
         VALUES ($1, 'present', NOW(), 'manual')
         ON CONFLICT (roll_no) DO UPDATE SET status = 'present', marked_at = NOW(), method = 'manual'`,
        [student.roll_no]
      );
    } else {
      await pool.query(
        `INSERT INTO session_attendance (roll_no, status, method)
         VALUES ($1, 'absent', 'manual')
         ON CONFLICT (roll_no) DO UPDATE SET status = 'absent', method = 'manual'`,
        [student.roll_no]
      );
    }

    const rosterResult = await getRoster();
    global.broadcast({ type: 'attendance_update', roster: rosterResult });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
