const express = require('express');
const XLSX    = require('xlsx');
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
// Teacher uploads Excel sheet; students are added/synced
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
    console.log('[import] file received:', req.file?.originalname, req.file?.size, 'bytes');

    // ── Use 'xlsx' library to read (ExcelJS fails on some .xlsx formats) ─────
    const xlsxWb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = xlsxWb.SheetNames[0];
    if (!sheetName) return res.status(400).json({ error: 'Could not find any sheet in the uploaded file.' });

    // Convert to array-of-arrays (header:1 means row 0 = first row)
    const rawRows = XLSX.utils.sheet_to_json(xlsxWb.Sheets[sheetName], { header: 1, defval: null });
    if (!rawRows.length) return res.status(400).json({ error: 'The sheet appears to be empty.' });

    // Find header row (look in first 3 rows for Roll No. and Student Name)
    let headerRowIdx = -1;
    let rollCol = -1;
    let nameCol = -1;

    for (let r = 0; r < Math.min(3, rawRows.length); r++) {
      const row = rawRows[r];
      row.forEach((cell, ci) => {
        const val = String(cell || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (val.includes('rollno'))                         rollCol = ci;
        if (val.includes('studentname') || val === 'name') nameCol = ci;
      });
      if (rollCol !== -1 && nameCol !== -1) { headerRowIdx = r; break; }
    }

    if (rollCol === -1 || nameCol === -1) {
      return res.status(400).json({
        error: 'Could not find "Roll No." and "Student Name" columns. Check that row 1 has these exact headers.'
      });
    }

    // Parse student rows
    const students = [];
    for (let r = headerRowIdx + 1; r < rawRows.length; r++) {
      const row     = rawRows[r];
      const rawRoll = row[rollCol];
      const rawName = row[nameCol];

      if (rawRoll === null || rawRoll === undefined) continue;
      if (rawName === null || rawName === undefined) continue;

      // Skip date objects (footer rows like "Page -1 of 1")
      if (rawRoll instanceof Date) continue;

      const rollNo = String(rawRoll).trim();
      const name   = String(rawName).trim();

      if (!rollNo || !name) continue;
      if (rollNo.toLowerCase().includes('page')) continue;
      if (name.toLowerCase().includes('page'))   continue;
      if (rollNo.length < 4) continue;           // real roll numbers are at least 4 chars
      if (/^\d{1,2}$/.test(rollNo)) continue;  // skip plain S# numbers

      students.push({ roll_no: rollNo, name });
    }

    if (!students.length) {
      return res.status(400).json({ error: 'No valid student rows found. Check the file format.' });
    }

    // Upsert students and enroll them
    let added = 0, existing = 0;
    for (const s of students) {
      // Upsert user
      const upsert = await pool.query(
        `INSERT INTO users (name, roll_no, password_hash, role)
         VALUES ($1, $2, $3, 'student')
         ON CONFLICT (roll_no) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [s.name, s.roll_no, s.roll_no] // password = roll_no (not used, roll_no is the "key")
      );
      const userId = upsert.rows[0].id;

      // Enroll
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
    console.error('[import] FULL ERROR:', err);
    res.status(500).json({ error: err.message || 'Import failed', stack: err.stack });
  }
});

// ── GET /api/excel/export/:courseId ─────────────────────────────────────────
// Exports in EXACT same format as the uploaded instructor sheet:
// S# | Roll No. | Student Name | DD/MM/YYYY | DD/MM/YYYY ...
// Plain styling — Arial 10, no colours, row height 12.75 — matches original
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
      `SELECT id, date FROM sessions WHERE course_id=$1 ORDER BY date ASC, started_at ASC`,
      [courseId]
    );
    const sessions = sessionsRes.rows;

    const studentsRes = await pool.query(
      `SELECT u.id, u.roll_no, u.name FROM users u
       JOIN enrollments e ON e.student_id=u.id
       WHERE e.course_id=$1 ORDER BY u.roll_no ASC`,
      [courseId]
    );
    const students = studentsRes.rows;

    const attRes = await pool.query(
      `SELECT a.student_id, a.session_id, a.status FROM attendance a
       JOIN sessions s ON s.id=a.session_id WHERE s.course_id=$1`,
      [courseId]
    );
    const attMap = {};
    attRes.rows.forEach(r => { attMap[r.session_id + '_' + r.student_id] = r.status; });

    // ── Build workbook matching instructor format exactly ─────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator = 'FLEX';
    const ws = wb.addWorksheet('Sheet1');   // same sheet name as original

    // Plain font matching original (Arial 10, no bold, no colour)
    const font     = { name: 'Arial', size: 10 };
    const fontBold = { name: 'Arial', size: 10, bold: true };

    // Column widths matching original
    ws.getColumn(1).width = 6.86;   // S#      — same as original
    ws.getColumn(2).width = 12;     // Roll No.
    ws.getColumn(3).width = 28;     // Student Name
    // Date columns
    for (let i = 4; i <= 3 + sessions.length; i++) ws.getColumn(i).width = 12;

    // All row heights = 12.75 (same as original)
    const ROW_HEIGHT = 12.75;

    // ── Row 1: headers ────────────────────────────────────────────────────────
    const headerRow = ws.getRow(1);
    headerRow.height = ROW_HEIGHT;

    const h1 = ws.getCell(1, 1); h1.value = 'S#';           h1.font = fontBold;
    const h2 = ws.getCell(1, 2); h2.value = 'Roll No.';     h2.font = fontBold;
    const h3 = ws.getCell(1, 3); h3.value = 'Student Name'; h3.font = fontBold;

    sessions.forEach((s, si) => {
      // Format date as DD/MM/YYYY — exactly as instructor requires
      const d     = new Date(s.date);
      const dd    = String(d.getUTCDate()).padStart(2, '0');
      const mm    = String(d.getUTCMonth() + 1).padStart(2, '0');
      const yyyy  = d.getUTCFullYear();
      const cell  = ws.getCell(1, si + 4);
      cell.value  = `${dd}/${mm}/${yyyy}`;
      cell.font   = fontBold;
    });

    // ── Data rows ─────────────────────────────────────────────────────────────
    students.forEach((student, idx) => {
      const rowNum = idx + 2;
      const row    = ws.getRow(rowNum);
      row.height   = ROW_HEIGHT;

      ws.getCell(rowNum, 1).value = idx + 1;          // S#
      ws.getCell(rowNum, 2).value = student.roll_no;  // Roll No.
      ws.getCell(rowNum, 3).value = student.name;     // Student Name

      // Font for data cells
      ws.getCell(rowNum, 1).font = font;
      ws.getCell(rowNum, 2).font = font;
      ws.getCell(rowNum, 3).font = font;

      sessions.forEach((session, si) => {
        const status = attMap[session.id + '_' + student.id];
        const cell   = ws.getCell(rowNum, si + 4);
        cell.font    = font;
        if (status === 'present') {
          cell.value = 'P';
        } else if (status === 'absent') {
          cell.value = 'A';
        } else {
          cell.value = '';   // not yet marked — blank like original
        }
        cell.alignment = { horizontal: 'center' };
      });
    });

    // ── Footer row (date + page marker, same as original) ────────────────────
    const footerRowNum = students.length + 2;
    const footerRow2   = ws.getRow(footerRowNum);
    footerRow2.height  = ROW_HEIGHT;
    const today        = new Date();
    ws.getCell(footerRowNum, 1).value = today;
    ws.getCell(footerRowNum, 1).numFmt = 'DD/MM/YYYY';
    ws.getCell(footerRowNum, 1).font   = font;
    ws.getCell(footerRowNum, 2).value  = 'Page -1 of 1';
    ws.getCell(footerRowNum, 2).font   = font;

    const filename = `Attendance_${course.code}_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// ── GET /api/excel/preview/:courseId ─────────────────────────────────────────
// Returns JSON of attendance grid for the editable table in the UI
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
// Teacher edits a cell in the preview table
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
