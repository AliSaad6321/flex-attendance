// ── STATE ──────────────────────────────────────────────────────────────────────
let authToken    = null;
let currentUser  = null;
let activeSessionId     = null;
let activeSessionCourse = null;
let activeSessionCourseId = null;
let qrPollInterval  = null;
let qrTimerInterval = null;
let wsConn          = null;
let qrIntervalMs    = 10000;
let tokenStart      = null;
let html5Scanner    = null;
let pendingCourseId = null;   // for start-session modal
let importFile      = null;   // for import modal

// ── Device fingerprint (persistent per browser) ───────────────────────────────
function getDeviceFp() {
  let fp = localStorage.getItem('flex_device_fp');
  if (!fp) {
    fp = 'fp_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    localStorage.setItem('flex_device_fp', fp);
  }
  return fp;
}

// ── API helper ────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
      ...opts.headers
    }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Page helpers ──────────────────────────────────────────────────────────────
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function showEl(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function hideEl(id)  { document.getElementById(id)?.classList.add('hidden'); }
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function showErr(id, msg) { const el = document.getElementById(id); if (el) { el.textContent = msg; el.classList.remove('hidden'); } }
function clearErr(id) { hideEl(id); }

// ── HOME — mode toggle ────────────────────────────────────────────────────────
function selectMode(mode) {
  document.getElementById('btn-mode-teacher').classList.toggle('active', mode === 'teacher');
  document.getElementById('btn-mode-student').classList.toggle('active', mode === 'student');
  if (mode === 'teacher') { showEl('mode-teacher-panel'); hideEl('mode-student-panel'); }
  else                    { showEl('mode-student-panel'); hideEl('mode-teacher-panel'); }
}

async function teacherEnter() {
  const pwd = document.getElementById('teacher-pwd').value;
  clearErr('teacher-error');
  if (!pwd) { showErr('teacher-error', 'Enter password'); return; }
  try {
    const data = await api('/api/auth/teacher-enter', { method:'POST', body: JSON.stringify({ password: pwd }) });
    authToken   = data.token;
    currentUser = data.user;
    setText('teacher-name-display', data.user.name);
    showPage('page-teacher');
    loadTeacherCourses();
  } catch (e) { showErr('teacher-error', e.message); }
}

async function studentEnter() {
  const roll = document.getElementById('student-rollno').value.trim().toUpperCase();
  clearErr('student-error');
  if (!roll) { showErr('student-error', 'Enter your roll number'); return; }
  try {
    const data = await api('/api/auth/student-enter', { method:'POST', body: JSON.stringify({ roll_no: roll }) });
    authToken   = data.token;
    currentUser = data.user;
    setText('student-name-display', `${data.user.name} (${data.user.roll_no})`);
    showPage('page-student');
    loadStudentCourses();
  } catch (e) { showErr('student-error', e.message); }
}

function goHome() {
  authToken = null; currentUser = null;
  clearQrTimers(); closeWs(); stopScanner();
  activeSessionId = null;
  hideEl('t-session-panel'); hideEl('t-preview-panel');
  showEl('t-courses-panel');
  document.getElementById('teacher-pwd').value = '';
  document.getElementById('student-rollno').value = '';
  showPage('page-home');
}

// ── TEACHER — courses ─────────────────────────────────────────────────────────
async function loadTeacherCourses() {
  const el = document.getElementById('t-courses-list');
  el.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading…</p></div>';
  try {
    const courses = await api('/api/attendance/courses');
    el.innerHTML = '';
    if (!courses.length) {
      el.innerHTML = '<p style="color:var(--muted)">No courses found. Add courses in the database.</p>';
      return;
    }
    courses.forEach(c => {
      const card = document.createElement('div');
      card.className = 'course-card';
      card.innerHTML = `<div class="course-code">${c.code}</div>
                        <div class="course-name">${c.name}</div>
                        <div class="course-action">Click to start session →</div>`;
      card.onclick = () => openStartModal(c);
      el.appendChild(card);
    });
  } catch (e) { el.innerHTML = `<p style="color:var(--danger)">${e.message}</p>`; }
}

// ── Start session modal ───────────────────────────────────────────────────────
function openStartModal(course) {
  pendingCourseId = course.id;
  activeSessionCourse = course;
  setText('start-modal-title', `Start — ${course.code}: ${course.name}`);
  showEl('start-modal');
}
function hideStartModal() { hideEl('start-modal'); }
async function confirmStartSession() {
  const interval = parseInt(document.getElementById('start-interval').value) || 10;
  hideStartModal();
  await startSession(pendingCourseId, interval);
}

async function startSession(courseId, intervalSec) {
  try {
    const data = await api('/api/attendance/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ course_id: courseId, token_interval: intervalSec })
    });
    activeSessionId       = data.session_id;
    activeSessionCourseId = courseId;
    qrIntervalMs = data.expires_in || intervalSec * 1000;

    setText('t-session-title', `${activeSessionCourse.code} — ${activeSessionCourse.name}`);
    setText('t-session-meta', `Session started · ${new Date().toLocaleTimeString()} · Token rotates every ${intervalSec}s`);
    document.getElementById('qr-img').src = data.qr_data_url;
    document.getElementById('interval-slider').value = intervalSec;
    setText('interval-display', intervalSec);

    hideEl('t-courses-panel');
    showEl('t-session-panel');

    tokenStart = Date.now();
    startQrTimer();
    startQrPoll();
    loadRoster();
    connectWs(activeSessionId);
  } catch (e) { alert('Failed to start session: ' + e.message); }
}

// ── Interval slider (live) ────────────────────────────────────────────────────
function updateIntervalDisplay(val) { setText('interval-display', val); }

async function changeInterval(val) {
  // Restart session with new interval — just restart rotation on server
  if (!activeSessionId) return;
  try {
    // Re-start with same course, new interval
    clearQrTimers();
    const data = await api('/api/attendance/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ course_id: activeSessionCourseId, token_interval: parseInt(val) })
    });
    activeSessionId = data.session_id;
    qrIntervalMs = data.expires_in;
    document.getElementById('qr-img').src = data.qr_data_url;
    tokenStart = Date.now();
    startQrTimer();
    startQrPoll();
    setText('t-session-meta', `Session active · Token rotates every ${val}s`);
    loadRoster();
    closeWs();
    connectWs(activeSessionId);
  } catch (e) { console.error('Change interval error:', e.message); }
}

// ── Roster ────────────────────────────────────────────────────────────────────
async function loadRoster() {
  if (!activeSessionId) return;
  try {
    const roster = await api(`/api/attendance/sessions/${activeSessionId}/roster`);
    renderRoster(roster);
  } catch (e) { console.error('Roster error:', e.message); }
}

function renderRoster(roster) {
  const list = document.getElementById('roster-list');
  let p = 0, a = 0;
  list.innerHTML = '';
  roster.forEach(s => {
    s.status === 'present' ? p++ : a++;
    const item = document.createElement('div');
    item.className = `roster-item ${s.status}`;
    item.id = `ri-${s.id}`;
    item.innerHTML = `
      <div class="ri-info">
        <span class="ri-name">${s.name}</span>
        <span class="ri-roll">${s.roll_no || '—'}</span>
      </div>
      <div class="ri-right">
        <span class="ri-method">${s.method === 'qr' ? 'QR' : s.method === 'manual' ? 'Manual' : ''}</span>
        <span class="status-pill ${s.status}">${s.status}</span>
        <button class="toggle-btn" onclick="manualToggle(${s.id},'${s.status === 'present' ? 'absent' : 'present'}')">
          Mark ${s.status === 'present' ? 'Absent' : 'Present'}
        </button>
      </div>`;
    list.appendChild(item);
  });
  setText('cnt-present', `${p} Present`);
  setText('cnt-absent', `${a} Absent`);
}

function updateRosterItem(u) {
  const item = document.getElementById(`ri-${u.student_id}`);
  if (item) {
    item.className = `roster-item ${u.status}`;
    item.querySelector('.status-pill').className = `status-pill ${u.status}`;
    item.querySelector('.status-pill').textContent = u.status;
    item.querySelector('.toggle-btn').textContent = `Mark ${u.status === 'present' ? 'Absent' : 'Present'}`;
    item.querySelector('.toggle-btn').onclick = () => manualToggle(u.student_id, u.status === 'present' ? 'absent' : 'present');
    item.querySelector('.ri-method').textContent = u.method === 'qr' ? 'QR' : 'Manual';
    recountRoster();
  } else { loadRoster(); }
}

function recountRoster() {
  const items = document.querySelectorAll('.roster-item');
  let p = 0, a = 0;
  items.forEach(i => i.classList.contains('present') ? p++ : a++);
  setText('cnt-present', `${p} Present`);
  setText('cnt-absent',  `${a} Absent`);
}

async function manualToggle(studentId, newStatus) {
  try {
    await api(`/api/attendance/sessions/${activeSessionId}/manual`, {
      method: 'PATCH',
      body: JSON.stringify({ student_id: studentId, status: newStatus })
    });
  } catch (e) { alert('Failed: ' + e.message); }
}

async function endSession() {
  if (!confirm('End this attendance session?')) return;
  try {
    await api(`/api/attendance/sessions/${activeSessionId}/end`, { method: 'POST' });
    activeSessionId = null;
    clearQrTimers(); closeWs();
    hideEl('t-session-panel');
    showEl('t-courses-panel');
  } catch (e) { alert('Error: ' + e.message); }
}

// ── QR timer UI ───────────────────────────────────────────────────────────────
function startQrTimer() {
  clearQrTimers();
  tokenStart = Date.now();
  qrTimerInterval = setInterval(() => {
    const elapsed   = Date.now() - tokenStart;
    const remaining = Math.max(0, qrIntervalMs - elapsed);
    const pct       = (remaining / qrIntervalMs) * 100;
    const fill = document.getElementById('qr-fill');
    if (fill) {
      fill.style.width = pct + '%';
      fill.style.background = pct < 25 ? 'var(--danger)' : pct < 50 ? 'var(--warning)' : 'var(--primary)';
    }
    setText('qr-countdown', Math.ceil(remaining / 1000) + 's');
  }, 100);
}

function startQrPoll() {
  qrPollInterval = setInterval(async () => {
    if (!activeSessionId) return;
    try {
      const data = await api(`/api/attendance/sessions/${activeSessionId}/qr`);
      document.getElementById('qr-img').src = data.qr_data_url;
      tokenStart = Date.now();
      const badge = document.getElementById('qr-badge');
      if (badge) { badge.textContent = '✓ REFRESHED'; setTimeout(() => { badge.textContent = '● LIVE'; }, 800); }
    } catch {}
  }, qrIntervalMs);
}

function clearQrTimers() {
  if (qrPollInterval)  clearInterval(qrPollInterval);
  if (qrTimerInterval) clearInterval(qrTimerInterval);
  qrPollInterval = qrTimerInterval = null;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWs(sessionId) {
  closeWs();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  wsConn = new WebSocket(`${proto}://${location.host}/ws?sessionId=${sessionId}&token=${authToken}`);
  wsConn.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'attendance_update') updateRosterItem(msg);
  };
  wsConn.onerror = () => {};
}
function closeWs() { if (wsConn) { wsConn.close(); wsConn = null; } }

// ── Excel export ──────────────────────────────────────────────────────────────
function exportExcel() {
  if (!activeSessionCourseId) return;
  const btn = document.getElementById('btn-export');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating…'; }
  window.location.href = `/api/excel/export/${activeSessionCourseId}?token=${authToken}`;
  setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = '⬇ Export Excel'; } }, 3000);
}

// ── Attendance preview / edit ─────────────────────────────────────────────────
async function showPreview() {
  if (!activeSessionCourseId) return;
  showEl('t-preview-panel');
  setText('preview-course-name', activeSessionCourse?.name || '');
  const wrap = document.getElementById('preview-table-wrap');
  wrap.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading records…</p></div>';
  try {
    const data = await api(`/api/excel/preview/${activeSessionCourseId}`);
    renderPreviewTable(data);
  } catch (e) { wrap.innerHTML = `<p style="color:var(--danger)">Error: ${e.message}</p>`; }
}

function hidePreview() { hideEl('t-preview-panel'); }

function renderPreviewTable({ sessions, students, attendance }) {
  const wrap = document.getElementById('preview-table-wrap');
  if (!students.length) { wrap.innerHTML = '<p style="color:var(--muted);padding:16px">No students enrolled yet. Import a student list first.</p>'; return; }

  let html = '<table class="prev-table"><thead><tr>';
  html += '<th>#</th><th>Roll No.</th><th>Student Name</th>';
  sessions.forEach(s => {
    const d = new Date(s.date);
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const yyyy = d.getFullYear();
    html += `<th>${dd}/${mm}/${yyyy}</th>`;
  });
  html += '</tr></thead><tbody>';

  students.forEach((st, i) => {
    html += `<tr><td>${i+1}</td><td>${st.roll_no}</td><td class="td-name">${st.name}</td>`;
    sessions.forEach(sess => {
      const key    = `${sess.id}_${st.id}`;
      const status = attendance[key];
      if (status === 'present') {
        html += `<td class="prev-p"><button class="prev-edit" onclick="editCell(${sess.id},${st.id},'absent')">P</button></td>`;
      } else if (status === 'absent') {
        html += `<td class="prev-a"><button class="prev-edit" onclick="editCell(${sess.id},${st.id},'present')">A</button></td>`;
      } else {
        html += `<td><button class="prev-edit" onclick="editCell(${sess.id},${st.id},'present')">—</button></td>`;
      }
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  html += '<p style="font-size:11px;color:var(--muted);margin-top:10px;padding:0 4px">Click any P/A/— cell to toggle the status.</p>';
  wrap.innerHTML = html;
}

async function editCell(sessionId, studentId, newStatus) {
  try {
    await api('/api/excel/attendance', {
      method: 'PATCH',
      body: JSON.stringify({ session_id: sessionId, student_id: studentId, status: newStatus })
    });
    showPreview(); // Refresh table
  } catch (e) { alert('Failed: ' + e.message); }
}

// ── Import modal ──────────────────────────────────────────────────────────────
async function showImportModal() {
  importFile = null;
  setText('upload-filename', '');
  hideEl('import-msg');
  document.getElementById('btn-do-import').disabled = true;
  showEl('import-modal');
  // Populate course select
  try {
    const courses = await api('/api/attendance/courses');
    const sel = document.getElementById('import-course-select');
    sel.innerHTML = courses.map(c => `<option value="${c.id}">${c.code} — ${c.name}</option>`).join('');
  } catch {}
}
function hideImportModal() { hideEl('import-modal'); }

function handleFileSelect(input) {
  if (input.files[0]) {
    importFile = input.files[0];
    setText('upload-filename', importFile.name);
    document.getElementById('btn-do-import').disabled = false;
  }
}
function handleDrop(e) {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f && (f.name.endsWith('.xlsx') || f.name.endsWith('.xls'))) {
    importFile = f;
    setText('upload-filename', f.name);
    document.getElementById('btn-do-import').disabled = false;
  }
}

async function doImport() {
  if (!importFile) return;
  const courseId = document.getElementById('import-course-select').value;
  const btn = document.getElementById('btn-do-import');
  btn.disabled = true; btn.textContent = 'Importing…';
  const fd = new FormData();
  fd.append('sheet', importFile);
  try {
    const res = await fetch(`/api/excel/import/${courseId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` },
      body: fd
    });
    const data = await res.json();
    const msgEl = document.getElementById('import-msg');
    msgEl.className = `import-msg ${res.ok ? 'success' : 'error'}`;
    msgEl.textContent = res.ok ? `✓ ${data.message}` : `✗ ${data.error}`;
    showEl('import-msg');
    if (res.ok) { loadTeacherCourses(); setTimeout(hideImportModal, 1800); }
  } catch (e) {
    const msgEl = document.getElementById('import-msg');
    msgEl.className = 'import-msg error';
    msgEl.textContent = '✗ ' + e.message;
    showEl('import-msg');
  }
  btn.disabled = false; btn.textContent = 'Import';
}

// ── STUDENT ───────────────────────────────────────────────────────────────────
async function loadStudentCourses() {
  const el = document.getElementById('s-courses-list');
  el.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading…</p></div>';
  try {
    const courses = await api('/api/attendance/courses');
    el.innerHTML = '';
    if (!courses.length) {
      el.innerHTML = '<p style="color:var(--muted)">No courses found for your roll number.</p>';
      return;
    }
    courses.forEach(c => {
      const card = document.createElement('div');
      card.className = 'course-card';
      card.innerHTML = `<div class="course-code">${c.code}</div>
                        <div class="course-name">${c.name}</div>
                        <div class="course-action">Tap to mark attendance →</div>`;
      card.onclick = () => openScanner(c);
      el.appendChild(card);
    });
  } catch (e) { el.innerHTML = `<p style="color:var(--danger)">${e.message}</p>`; }
}

async function openScanner(course) {
  activeSessionCourse   = course;
  activeSessionCourseId = course.id;
  setText('s-scanner-title', course.name);
  document.querySelector('.panel').classList.add('hidden'); // hide courses panel
  document.getElementById('s-courses-list').closest('.panel').classList.add('hidden');
  showEl('s-scanner-panel');
  ['s-no-session','s-already','s-ready','scan-msg'].forEach(id => hideEl(id));

  try {
    const data = await api(`/api/attendance/active-session/${course.id}`);
    if (!data.active) {
      showEl('s-no-session');
    } else if (data.already_marked) {
      showEl('s-already');
      setText('s-already-text', `You are marked ${data.current_status}!`);
      setText('s-already-sub', `Session started at ${new Date(data.started_at).toLocaleTimeString()}`);
    } else {
      activeSessionId = data.session_id;
      showEl('s-ready');
      setText('s-scanner-meta', 'Session active — scan the QR code on the projector');
      initScanner();
    }
    loadStudentHistory(course.id);
  } catch {
    showEl('s-no-session');
  }
}

function closeScanner() {
  stopScanner();
  activeSessionId = null;
  hideEl('s-scanner-panel');
  document.getElementById('s-courses-list').closest('.panel').classList.remove('hidden');
}

function initScanner() {
  if (html5Scanner) stopScanner();
  html5Scanner = new Html5Qrcode('qr-reader');
  html5Scanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 240, height: 240 } },
    text => handleScan(text),
    () => {}
  ).catch(() => {
    document.getElementById('qr-reader').innerHTML =
      '<p style="padding:16px;color:var(--muted);text-align:center">Camera unavailable — use manual token entry below.</p>';
  });
}

function stopScanner() {
  if (html5Scanner) { html5Scanner.stop().catch(() => {}); html5Scanner = null; }
}

async function handleScan(text) {
  stopScanner();
  try {
    const payload = JSON.parse(text);
    await submitAttendance(payload.session_id, payload.token);
  } catch { showScanMsg('Invalid QR format. Try manual entry.', 'error'); }
}

async function markManual() {
  const token = document.getElementById('manual-token').value.trim();
  if (!token || !activeSessionId) { showScanMsg('Enter the token.', 'error'); return; }
  await submitAttendance(activeSessionId, token);
}

async function submitAttendance(sessionId, token) {
  try {
    await api('/api/attendance/mark', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, token, device_fp: getDeviceFp() })
    });
    hideEl('s-ready');
    showEl('s-already');
    setText('s-already-text', '✓ Attendance marked!');
    setText('s-already-sub', 'You are marked present for today.');
    loadStudentHistory(activeSessionCourseId);
  } catch (e) {
    showScanMsg(e.message, 'error');
    setTimeout(() => { hideEl('scan-msg'); initScanner(); }, 3000);
  }
}

function showScanMsg(msg, type) {
  const el = document.getElementById('scan-msg');
  el.textContent = msg; el.className = `scan-msg ${type}`; showEl('scan-msg');
}

async function loadStudentHistory(courseId) {
  const wrap = document.getElementById('s-history');
  wrap.innerHTML = '';
  try {
    const data = await api(`/api/attendance/history/${courseId}`);
    if (!data.sessions.length) return;
    const pctColor = data.percentage >= 75 ? 'var(--success)' : 'var(--danger)';
    wrap.innerHTML = `
      <h4>My Attendance History</h4>
      <div class="stat-row">
        <div class="stat-box"><div class="stat-val" style="color:${pctColor}">${data.percentage}%</div><div class="stat-lbl">Rate</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--success)">${data.present}</div><div class="stat-lbl">Present</div></div>
        <div class="stat-box"><div class="stat-val">${data.total}</div><div class="stat-lbl">Total</div></div>
      </div>
      <table class="hist-table">
        <thead><tr><th>Date</th><th>Status</th><th>Method</th></tr></thead>
        <tbody>${data.sessions.map(s => `
          <tr>
            <td>${new Date(s.date).toLocaleDateString('en-PK',{weekday:'short',day:'numeric',month:'short',year:'numeric'})}</td>
            <td><span class="pill-${s.status}">${s.status}</span></td>
            <td style="color:var(--muted)">${s.method || '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch {}
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (document.getElementById('page-home').classList.contains('active')) {
      if (!document.getElementById('mode-teacher-panel').classList.contains('hidden')) teacherEnter();
      else studentEnter();
    }
  }
});
