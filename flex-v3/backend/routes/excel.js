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

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];

    // Detect header row — look for "Roll No" or "Roll No." in first 3 rows
    let headerRow = 1;
    let rollCol = null, nameCol = null;

    for (let r = 1; r <= 3; r++) {
      ws.getRow(r).eachCell((cell, colNum) => {
        const val = String(cell.value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (val.includes('rollno')) rollCol = colNum;
        if (val.includes('studentname') || val.includes('name')) nameCol = colNum;
        if (rollCol && nameCol) headerRow = r;
      });
      if (rollCol && nameCol) break;
    }

    if (!rollCol || !nameCol) {
      return res.status(400).json({ error: 'Could not find "Roll No." and "Student Name" columns in the sheet. Make sure row 1 has these headers.' });
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
      // Skip footer rows (date rows, page markers)
      if (rollNo.toLowerCase().includes('page') || name.toLowerCase().includes('page')) return;
      if (rollNo.length < 3) return;
      students.push({ roll_no: rollNo, name });
    });

    if (!students.length) {
      return res.status(400).json({ error: 'No student rows found in the sheet.' });
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
    console.error('Import error:', err);
    res.status(500).json({ error: err.message || 'Import failed' });
  }
});

// ── GET /api/excel/export/:courseId ─────────────────────────────────────────
// Downloads attendance sheet in EXACT instructor format:
// S# | Roll No. | Student Name | DD/MM/YYYY | DD/MM/YYYY | ...
// Each date column = one session; P = Present, A = Absent
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

    // All sessions sorted by date
    const sessionsRes = await pool.query(
      `SELECT id, date, started_at FROM sessions
       WHERE course_id = $1 ORDER BY date ASC, started_at ASC`,
      [courseId]
    );
    const sessions = sessionsRes.rows;

    // All students enrolled, sorted by roll_no
    const studentsRes = await pool.query(
      `SELECT u.id, u.roll_no, u.name FROM users u
       JOIN enrollments e ON e.student_id = u.id
       WHERE e.course_id = $1
       ORDER BY u.roll_no ASC`,
      [courseId]
    );
    const students = studentsRes.rows;

    // All attendance records
    const attRes = await pool.query(
      `SELECT a.student_id, a.session_id, a.status FROM attendance a
       JOIN sessions s ON s.id = a.session_id WHERE s.course_id = $1`,
      [courseId]
    );
    const attMap = {};
    attRes.rows.forEach(r => { attMap[`${r.session_id}_${r.student_id}`] = r.status; });

    // ── Build workbook ────────────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Attendance');

    // Styles
    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    const dateFill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
    const presentFill= { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
    const absentFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
    const altFill    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    const whiteFill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    const thin = { style: 'thin', color: { argb: 'FFE2E8F0' } };
    const border = { top: thin, left: thin, bottom: thin, right: thin };
    const headerFont = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    const bodyFont   = { name: 'Arial', size: 10 };

    // Column setup: S# | Roll No. | Student Name | [date cols...]
    ws.getColumn(1).width = 5;
    ws.getColumn(2).width = 14;
    ws.getColumn(3).width = 28;
    for (let i = 4; i <= 3 + sessions.length; i++) ws.getColumn(i).width = 13;

    // ── Row 1: Course title ───────────────────────────────────────────────────
    const titleCols = 3 + sessions.length;
    ws.mergeCells(1, 1, 1, Math.max(titleCols, 4));
    const titleCell = ws.getCell('A1');
    titleCell.value = `FAST NU — ${course.name} (${course.code}) — Attendance Sheet`;
    titleCell.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = headerFill;
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 24;

    // ── Row 2: Column headers (S# | Roll No. | Student Name | dates...) ──────
    const headers = ['S#', 'Roll No.', 'Student Name'];
    sessions.forEach(s => {
      const d = new Date(s.date);
      // DD/MM/YYYY format as required by instructor
      const day   = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const year  = d.getFullYear();
      headers.push(`${day}/${month}/${year}`);
    });

    headers.forEach((h, i) => {
      const cell = ws.getCell(2, i + 1);
      cell.value = h;
      cell.font = headerFont;
      cell.fill = i >= 3 ? dateFill : headerFill;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = border;
    });
    ws.getRow(2).height = 22;

    // ── Data rows ─────────────────────────────────────────────────────────────
    students.forEach((student, si) => {
      const rowNum = si + 3;
      const rowFill = si % 2 === 0 ? whiteFill : altFill;

      // S#
      const snCell = ws.getCell(rowNum, 1);
      snCell.value = si + 1;
      snCell.font = bodyFont;
      snCell.fill = rowFill;
      snCell.alignment = { horizontal: 'center', vertical: 'middle' };
      snCell.border = border;

      // Roll No.
      const rollCell = ws.getCell(rowNum, 2);
      rollCell.value = student.roll_no;
      rollCell.font = bodyFont;
      rollCell.fill = rowFill;
      rollCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      rollCell.border = border;

      // Student Name
      const nameCell = ws.getCell(rowNum, 3);
      nameCell.value = student.name;
      nameCell.font = bodyFont;
      nameCell.fill = rowFill;
      nameCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      nameCell.border = border;

      // Attendance per session
      sessions.forEach((session, si2) => {
        const status = attMap[`${session.id}_${student.id}`];
        const cell = ws.getCell(rowNum, si2 + 4);
        if (status === 'present') {
          cell.value = 'P';
          cell.fill = presentFill;
          cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF16A34A' } };
        } else if (status === 'absent') {
          cell.value = 'A';
          cell.fill = absentFill;
          cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFDC2626' } };
        } else {
          cell.value = '';
          cell.fill = rowFill;
          cell.font = bodyFont;
        }
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = border;
      });

      ws.getRow(rowNum).height = 16;
    });

    // ── Footer ────────────────────────────────────────────────────────────────
    const footerRow = students.length + 3;
    ws.mergeCells(footerRow, 1, footerRow, Math.max(titleCols, 4));
    const footer = ws.getCell(footerRow, 1);
    footer.value = `Generated by FLEX Attendance System · ${new Date().toLocaleDateString('en-PK')} · P = Present, A = Absent`;
    footer.font = { name: 'Arial', size: 9, italic: true, color: { argb: 'FF94A3B8' } };
    footer.alignment = { horizontal: 'center' };

    const filename = `Attendance_${course.code}_${new Date().toISOString().split('T')[0]}.xlsx`;
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
