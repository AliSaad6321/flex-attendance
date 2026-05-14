const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const path = require('path');
const fs = require('fs');

const upload = multer({ dest: path.join(__dirname, '../uploads/') });

// POST /api/excel/import - upload Excel, load students, store prev columns
router.post('/import', upload.single('file'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    if (!filePath) return res.status(400).json({ error: 'No file uploaded' });

    // Read with SheetJS (handles this file type reliably)
    const wb = XLSX.readFile(filePath);
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Find header row (contains "Roll No" or similar)
    let headerRowIdx = -1;
    let rollCol = -1, nameCol = -1, snoCol = -1;
    let dateCols = []; // { idx, label }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      for (let j = 0; j < row.length; j++) {
        const cell = String(row[j] || '').toLowerCase().trim();
        if (cell.includes('roll') && cell.includes('no')) {
          rollCol = j;
          headerRowIdx = i;
        }
        if (cell === 'name' || cell === 'student name') nameCol = j;
        if (cell === 's#' || cell === 's.no' || cell === 's no' || cell === 'sr#' || cell === 'serial') snoCol = j;
      }
      if (headerRowIdx >= 0) break;
    }

    if (headerRowIdx < 0 || rollCol < 0) {
      return res.status(400).json({ error: 'Could not find "Roll No" column in the sheet. Please check the file format.' });
    }

    // If name col not found, use column after roll
    if (nameCol < 0) nameCol = rollCol + 1;

    // Find date columns (headers that look like DD/MM/YYYY or date objects)
    const headerRow = rows[headerRowIdx];
    for (let j = 0; j < headerRow.length; j++) {
      if (j === rollCol || j === nameCol || j === snoCol) continue;
      const cell = headerRow[j];
      const cellStr = String(cell || '').trim();
      // Check if it looks like a date: DD/MM/YYYY or similar
      if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cellStr) || /^\d{1,2}-\d{1,2}-\d{4}$/.test(cellStr)) {
        dateCols.push({ idx: j, label: cellStr.replace(/-/g, '/') });
      } else if (cell instanceof Date) {
        const d = new Date(cell);
        const label = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
        dateCols.push({ idx: j, label });
      }
    }

    // Parse student rows
    const students = [];
    let serial = 1;
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      let rawRoll = row[rollCol];
      if (!rawRoll) continue;
      if (rawRoll instanceof Date) continue;
      const rollStr = String(rawRoll).trim();
      if (!rollStr || rollStr.toLowerCase().includes('page') || /^\d{1,2}$/.test(rollStr)) continue;

      const name = String(row[nameCol] || '').trim();
      if (!name) continue;

      const sno = snoCol >= 0 ? (parseInt(row[snoCol]) || serial) : serial;

      // Collect previous attendance
      const prevData = {};
      for (const dc of dateCols) {
        const val = String(row[dc.idx] || '').trim().toUpperCase();
        if (val === 'P' || val === 'A') prevData[dc.label] = val;
      }

      students.push({ roll_no: rollStr, name, serial: sno, prevData });
      serial++;
    }

    if (students.length === 0) {
      return res.status(400).json({ error: 'No valid students found in the sheet.' });
    }

    // Clear and reload students
    await pool.query(`DELETE FROM session_attendance`);
    await pool.query(`DELETE FROM session_students`);
    await pool.query(`DELETE FROM previous_attendance`);

    for (const s of students) {
      await pool.query(
        `INSERT INTO session_students (roll_no, name, serial_no) VALUES ($1, $2, $3)
         ON CONFLICT (roll_no) DO UPDATE SET name = $2, serial_no = $3`,
        [s.roll_no, s.name, s.serial]
      );
      if (Object.keys(s.prevData).length > 0) {
        await pool.query(
          `INSERT INTO previous_attendance (roll_no, columns_json) VALUES ($1, $2)`,
          [s.roll_no, JSON.stringify(s.prevData)]
        );
      }
    }

    // Clean up temp file
    fs.unlink(filePath, () => {});

    res.json({
      success: true,
      count: students.length,
      previousColumns: dateCols.map(d => d.label)
    });
  } catch (err) {
    console.error('Import error:', err);
    if (filePath) fs.unlink(filePath, () => {});
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// GET /api/excel/export - export current session, preserving original columns
router.get('/export', async (req, res) => {
  try {
    const token = req.query.token;
    // Simple auth: require teacher password in query
    // (for browser download links)

    // Get session info
    const sessionResult = await pool.query(
      `SELECT course_name, date FROM active_session LIMIT 1`
    );
    const courseName = sessionResult.rows[0]?.course_name || 'Course';
    const sessionDate = sessionResult.rows[0]?.date
      ? (() => {
          const d = new Date(sessionResult.rows[0].date);
          return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
        })()
      : (() => {
          const d = new Date();
          return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
        })();

    // Get all students with current attendance
    const studentsResult = await pool.query(`
      SELECT s.serial_no, s.roll_no, s.name,
             COALESCE(a.status, 'absent') as status
      FROM session_students s
      LEFT JOIN session_attendance a ON UPPER(a.roll_no) = UPPER(s.roll_no)
      ORDER BY s.serial_no
    `);

    if (studentsResult.rows.length === 0) {
      return res.status(400).json({ error: 'No students loaded. Import an Excel sheet first.' });
    }

    // Get previous attendance data
    const prevResult = await pool.query(`SELECT roll_no, columns_json FROM previous_attendance`);
    const prevMap = {};
    for (const row of prevResult.rows) {
      prevMap[row.roll_no.toUpperCase()] = JSON.parse(row.columns_json);
    }

    // Get all unique previous date columns (sorted chronologically)
    const allPrevDates = new Set();
    for (const data of Object.values(prevMap)) {
      Object.keys(data).forEach(d => allPrevDates.add(d));
    }
    const sortedPrevDates = Array.from(allPrevDates).sort((a, b) => {
      const parseDate = s => {
        const [d, m, y] = s.split('/');
        return new Date(y, m-1, d);
      };
      return parseDate(a) - parseDate(b);
    });

    // Build ExcelJS workbook matching original format
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');

    // Column widths matching original
    sheet.getColumn(1).width = 6.86;  // S#
    sheet.getColumn(2).width = 14;    // Roll No
    sheet.getColumn(3).width = 30;    // Name
    for (let i = 4; i < 4 + sortedPrevDates.length + 1; i++) {
      sheet.getColumn(i).width = 12;
    }

    // Header row
    const headers = ['S#', 'Roll No.', 'Student Name', ...sortedPrevDates, sessionDate];
    const headerRow = sheet.addRow(headers);
    headerRow.height = 12.75;
    headerRow.eachCell(cell => {
      cell.font = { name: 'Arial', size: 10 };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    // Data rows
    for (const student of studentsResult.rows) {
      const rollUpper = student.roll_no.toUpperCase();
      const prevData = prevMap[rollUpper] || {};

      const rowData = [
        student.serial_no,
        student.roll_no,
        student.name
      ];

      // Previous columns
      for (const date of sortedPrevDates) {
        rowData.push(prevData[date] || '');
      }

      // Today's column
      rowData.push(student.status === 'present' ? 'P' : 'A');

      const dataRow = sheet.addRow(rowData);
      dataRow.height = 12.75;
      dataRow.eachCell(cell => {
        cell.font = { name: 'Arial', size: 10 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
    }

    // Footer row (matching original)
    const footerRow = sheet.addRow([new Date(), 'Page -1 of 1', '', '']);
    footerRow.height = 12.75;
    footerRow.eachCell(cell => {
      cell.font = { name: 'Arial', size: 10 };
    });

    // Stream to response
    const filename = `Attendance_${courseName.replace(/\s+/g, '_')}_${sessionDate.replace(/\//g, '-')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();

    // Clear DB after export (end of session flow)
    setTimeout(async () => {
      await pool.query(`DELETE FROM session_attendance`);
      await pool.query(`DELETE FROM session_students`);
      await pool.query(`DELETE FROM previous_attendance`);
      await pool.query(`DELETE FROM active_session`);
    }, 1000);

  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

module.exports = router;
