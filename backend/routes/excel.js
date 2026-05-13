const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// Multer: store uploads in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') cb(null, true);
    else cb(new Error('Only .xlsx or .xls files allowed'));
  }
});

// ── POST /api/excel/import/:courseId ─────────────────────────────────────────
router.post('/import/:courseId', authenticate, requireRole('teacher'), upload.single('sheet'), async (req, res) => {
  const { courseId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    // Verify teacher owns course
    const courseRes = await pool.query(
      'SELECT * FROM courses WHERE id = $1 AND teacher_id = $2',
      [courseId, req.user.id]
    );
    if (!courseRes.rows.length) return res.status(403).json({ error: 'Not your course' });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    
    // SAFETY CHECK: Fixes "Cannot read properties of undefined (reading 'getRow')"
    if (!wb.worksheets || wb.worksheets.length === 0) {
      return res.status(400).json({ error: 'The uploaded Excel file contains no readable worksheets.' });
    }
    
    const ws = wb.worksheets[0];

    // Detect header row — look for "Roll No" or "Student Name" in first 3 rows
    let headerRow = 1;
    let rollCol = null, nameCol = null;

    for (let r = 1; r <= 3; r++) {
      const row = ws.getRow(r);
      if (!row) continue; // Skip if row doesn't exist

      row.eachCell((cell, colNum) => {
        const val = String(cell.value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (val.includes('rollno')) rollCol = colNum;
        if (val.includes('studentname') || val.includes('name')) nameCol = colNum;
        if (rollCol && nameCol) headerRow = r;
      });
      if (rollCol && nameCol) break;
    }

    if (!rollCol || !nameCol) {
      return res.status(400).json({ error: 'Could not find "Roll No." and "Student Name" columns. Please ensure they are in the first 3 rows.' });
    }

    // Parse student rows
    const students = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum <= headerRow) return;
      
      const rollVal = row.getCell(rollCol).value;
      const nameVal = row.getCell(nameCol).value;
      
      if (!rollVal || !nameVal) return;
      
      const rollNo = String(rollVal).trim();
      const name = String(nameVal).trim();
      
      // Skip footer/utility rows
      if (rollNo.toLowerCase().includes('page') || name.toLowerCase().includes('page')) return;
      if (rollNo.length < 3) return;
      
      students.push({ roll_no: rollNo, name });
    });

    if (!students.length) {
      return res.status(400).json({ error: 'No student rows found in the sheet.' });
    }

    // Upsert and Enroll
    let added = 0, existing = 0;
    for (const s of students) {
      const upsert = await pool.query(
        `INSERT INTO users (name, roll_no, password_hash, role)
         VALUES ($1, $2, $3, 'student')
         ON CONFLICT (roll_no) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [s.name, s.roll_no, s.roll_no]
      );
      const userId = upsert.rows[0].id;

      const enroll = await pool.query(
        `INSERT INTO enrollments (student_id, course_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, courseId]
      );
      if (enroll.rowCount > 0) added++;
      else existing++;
    }

    res.json({ message: `Import complete: ${added} new, ${existing} already enrolled`, total: students.length });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: err.message || 'Import failed' });
  }
});

// ── GET /api/excel/export/:courseId ─────────────────────────────────────────
router.get('/export/:courseId', authenticate, requireRole('teacher'), async (req, res) => {
  const { courseId } = req.params;

  try {
    const courseRes = await pool.query(
      `SELECT c.*, u.name AS teacher_name FROM courses c
       JOIN users u ON u.id = c.teacher_id
       WHERE c.id = $1 AND c.teacher_id = $2`,
      [courseId, req.user.id]
    );
    if (!courseRes.rows.length) return res.status(404).json({ error: 'Course not found' });
    const course = courseRes.rows[0];

    const sessionsRes = await pool.query(
      `SELECT id, date, started_at FROM sessions
       WHERE course_id = $1 ORDER BY date ASC, started_at ASC`,
      [courseId]
    );
    const sessions = sessionsRes.rows;

    const studentsRes = await pool.query(
      `SELECT u.id, u.roll_no, u.name FROM users u
       JOIN enrollments e ON e.student_id = u.id
       WHERE e.course_id = $1
       ORDER BY u.roll_no ASC`,
      [courseId]
    );
    const students = studentsRes.rows;

    const attRes = await pool.query(
      `SELECT a.student_id, a.session_id, a.status FROM attendance a
       JOIN sessions s ON s.id = a.session_id WHERE s.course_id = $1`,
      [courseId]
    );
    const attMap = {};
    attRes.rows.forEach(r => { attMap[`${r.session_id}_${r.student_id}`] = r.status; });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Attendance');

    // Styles Configuration
    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    const dateFill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
    const presentFill= { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
    const absentFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
    const altFill    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    const whiteFill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    const border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };

    // Set Column Widths
    ws.getColumn(1).width = 5;
    ws.getColumn(2).width = 15;
    ws.getColumn(3).width = 30;
    for (let i = 4; i <= 3 + sessions.length; i++) ws.getColumn(i).width = 12;

    // Row 1: Title
    ws.mergeCells(1, 1, 1, Math.max(3 + sessions.length, 4));
    const titleCell = ws.getCell('A1');
    titleCell.value = `FLEX Attendance — ${course.name} (${course.code})`;
    titleCell.font = { size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = headerFill;
    titleCell.alignment = { horizontal: 'center' };

    // Row 2: Headers
    const headers = ['S#', 'Roll No.', 'Student Name'];
    sessions.forEach(s => {
      const d = new Date(s.date);
      headers.push(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`);
    });

    headers.forEach((h, i) => {
      const cell = ws.getCell(2, i + 1);
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = i >= 3 ? dateFill : headerFill;
      cell.border = border;
      cell.alignment = { horizontal: 'center' };
    });

    // Data rows
    students.forEach((student, si) => {
      const rowNum = si + 3;
      const rowFill = si % 2 === 0 ? whiteFill : altFill;

      // Basic Info
      const cells = [si + 1, student.roll_no, student.name];
      cells.forEach((val, i) => {
        const cell = ws.getCell(rowNum, i + 1);
        cell.value = val;
        cell.fill = rowFill;
        cell.border = border;
      });

      // Attendance Status
      sessions.forEach((session, sessionIdx) => {
        const status = attMap[`${session.id}_${student.id}`];
        const cell = ws.getCell(rowNum, sessionIdx + 4);
        cell.border = border;
        
        if (status === 'present') {
          cell.value = 'P';
          cell.fill = presentFill;
        } else {
          cell.value = 'A';
          cell.fill = absentFill;
        }
        cell.alignment = { horizontal: 'center' };
      });
    });

    const filename = `Attendance_${course.code}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    await wb.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── GET /api/excel/preview/:courseId ─────────────────────────────────────────
router.get('/preview/:courseId', authenticate, requireRole('teacher'), async (req, res) => {
  const { courseId } = req.params;
  try {
    const sessionsRes = await pool.query(
      `SELECT id, date, started_at FROM sessions WHERE course_id = $1 ORDER BY date ASC, started_at ASC`,
      [courseId]
    );
    const studentsRes = await pool.query(
      `SELECT u.id, u.roll_no, u.name FROM users u
       JOIN enrollments e ON e.student_id = u.id
       WHERE e.course_id = $1 ORDER BY u.roll_no ASC`,
      [courseId]
    );
    const attRes = await pool.query(
      `SELECT a.student_id, a.session_id, a.status FROM attendance a
       JOIN sessions s ON s.id = a.session_id WHERE s.course_id = $1`,
      [courseId]
    );
    const attMap = {};
    attRes.rows.forEach(r => { attMap[`${r.session_id}_${r.student_id}`] = r.status; });

    res.json({
      sessions: sessionsRes.rows,
      students: studentsRes.rows,
      attendance: attMap
    });
  } catch (err) {
    res.status(500).json({ error: 'Preview failed' });
  }
});

// ── PATCH /api/excel/attendance ───────────────────────────────────────────────
router.patch('/attendance', authenticate, requireRole('teacher'), async (req, res) => {
  const { session_id, student_id, status } = req.body;
  if (!['present', 'absent'].includes(status))
    return res.status(400).json({ error: 'Status must be present or absent' });
  try {
    await pool.query(
      `INSERT INTO attendance (session_id, student_id, status, method)
       VALUES ($1, $2, $3, 'manual')
       ON CONFLICT (session_id, student_id) DO UPDATE SET status=$3, method='manual', marked_at=NOW()`,
      [session_id, student_id, status]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

module.exports = router;