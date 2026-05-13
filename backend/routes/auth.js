const express = require('express');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');
const router  = express.Router();

// Teacher mode: just a password, no email needed
router.post('/teacher-enter', async (req, res) => {
  const { password } = req.body;
  const expected = process.env.TEACHER_PASSWORD || 'password123';
  if (!password || password !== expected)
    return res.status(401).json({ error: 'Wrong teacher password' });
  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE role='teacher' LIMIT 1"
    );
    const teacher = result.rows[0];
    if (!teacher) return res.status(500).json({ error: 'No teacher account in DB. Run schema.sql.' });
    const token = jwt.sign(
      { id: teacher.id, name: teacher.name, role: 'teacher' },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({ token, user: { id: teacher.id, name: teacher.name, role: 'teacher' } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Student mode: enter roll number only
router.post('/student-enter', async (req, res) => {
  const { roll_no } = req.body;
  if (!roll_no) return res.status(400).json({ error: 'Roll number required' });
  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE LOWER(roll_no)=LOWER($1) AND role='student'",
      [roll_no.trim()]
    );
    const user = result.rows[0];
    if (!user)
      return res.status(404).json({ error: 'Roll number not found. Ask your teacher to upload the class list first.' });
    const token = jwt.sign(
      { id: user.id, name: user.name, roll_no: user.roll_no, role: 'student' },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ token, user: { id: user.id, name: user.name, roll_no: user.roll_no, role: 'student' } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
