// ===== FLEX Attendance v4 - Frontend App =====

const API = '';
let ws = null;
let qrCode = null;
let qrExpiresAt = null, codeExpiresAt = null;
let qrIntervalMs = 10000, codeIntervalMs = 15000;
let timerTick = null;

// Device fingerprint (anti-proxy: one device per session)
function getDeviceFingerprint() {
  let fp = localStorage.getItem('flex_device_fp');
  if (!fp) {
    fp = 'fp_' + Math.random().toString(36).substr(2, 12) + '_' + Date.now();
    localStorage.setItem('flex_device_fp', fp);
  }
  return fp;
}

// ===== PAGE NAVIGATION =====
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

document.getElementById('btn-teacher-mode').onclick = () => {
  showPage('teacher-page');
  checkExistingSession();
};
document.getElementById('btn-student-mode').onclick = () => {
  showPage('student-page');
  checkStudentSession();
};
document.getElementById('teacher-back').onclick = () => showPage('toggle-page');
document.getElementById('student-back').onclick = () => showPage('toggle-page');

// ===== TEACHER AUTH =====
document.getElementById('teacher-auth-btn').onclick = async () => {
  const pw = document.getElementById('teacher-pw').value;
  const err = document.getElementById('teacher-auth-error');
  err.textContent = '';
  try {
    const r = await fetch(`${API}/api/session/verify-teacher`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    const data = await r.json();
    if (!r.ok) { err.textContent = data.error || 'Wrong password'; return; }
    show('teacher-auth', false);
    show('session-setup', true);
  } catch (e) { err.textContent = 'Connection error'; }
};
document.getElementById('teacher-pw').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('teacher-auth-btn').click(); });

// ===== SLIDERS =====
document.getElementById('qr-interval').oninput = function() {
  document.getElementById('qr-interval-val').textContent = this.value + 's';
};
document.getElementById('code-interval').oninput = function() {
  document.getElementById('code-interval-val').textContent = this.value + 's';
};

// ===== FILE UPLOAD =====
document.getElementById('excel-upload').onchange = function() {
  const name = this.files[0]?.name || 'No file chosen';
  document.getElementById('upload-filename').textContent = name;
};

// ===== START SESSION =====
document.getElementById('start-session-btn').onclick = async () => {
  const courseName = document.getElementById('course-name').value.trim();
  const qrMs = parseInt(document.getElementById('qr-interval').value) * 1000;
  const codeMs = parseInt(document.getElementById('code-interval').value) * 1000;
  const file = document.getElementById('excel-upload').files[0];
  const err = document.getElementById('session-setup-error');
  err.textContent = '';

  if (!courseName) { err.textContent = 'Please enter a course name'; return; }
  if (!file) { err.textContent = 'Please upload the student Excel sheet'; return; }

  const btn = document.getElementById('start-session-btn');
  btn.textContent = 'Starting...'; btn.disabled = true;

  try {
    // 1. Start session
    const sessionRes = await fetch(`${API}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseName, qrInterval: qrMs, codeInterval: codeMs })
    });
    const sessionData = await sessionRes.json();
    if (!sessionRes.ok) { err.textContent = sessionData.error; btn.textContent = 'Start Session'; btn.disabled = false; return; }

    // 2. Import Excel
    const formData = new FormData();
    formData.append('file', file);
    const importRes = await fetch(`${API}/api/excel/import`, { method: 'POST', body: formData });
    const importData = await importRes.json();
    if (!importRes.ok) { err.textContent = importData.error; btn.textContent = 'Start Session'; btn.disabled = false; return; }

    // 3. Load active session UI
    qrIntervalMs = sessionData.qrIntervalMs;
    codeIntervalMs = sessionData.codeIntervalMs;
    loadActiveSessionUI(sessionData);

    // 4. Connect WebSocket
    connectWS();

    // 5. Load roster
    loadRoster();

  } catch (e) {
    err.textContent = 'Error: ' + e.message;
  }
  btn.textContent = 'Start Session'; btn.disabled = false;
};

// ===== CHECK EXISTING SESSION (teacher refresh) =====
async function checkExistingSession() {
  try {
    const r = await fetch(`${API}/api/session/status`);
    const data = await r.json();
    if (data.active) {
      show('teacher-auth', false);
      show('session-setup', false);
      qrIntervalMs = data.qrIntervalMs;
      codeIntervalMs = data.codeIntervalMs;
      loadActiveSessionUI(data);
      connectWS();
      loadRoster();
    }
  } catch (e) {}
}

function loadActiveSessionUI(data) {
  show('teacher-auth', false);
  show('session-setup', false);
  show('active-session', true);

  document.getElementById('session-course-name').textContent = data.courseName;
  const d = new Date();
  document.getElementById('session-date').textContent =
    `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;

  updateQR(data.qrToken || data.qr_token, data.qrExpiresAt || data.qr_token_expires_at);
  updateCode(data.code || data.code_token, data.codeExpiresAt || data.code_expires_at);

  if (!timerTick) timerTick = setInterval(tickTimers, 1000);
}

// ===== QR CODE =====
function updateQR(token, expiresAt) {
  if (!token) return;
  qrExpiresAt = new Date(expiresAt);
  const container = document.getElementById('qr-code-display');
  container.innerHTML = '';
  try {
    qrCode = new QRCode(container, {
      text: token,
      width: 200, height: 200,
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch (e) {}
}

function updateCode(code, expiresAt) {
  if (!code) return;
  codeExpiresAt = new Date(expiresAt);
  document.getElementById('manual-code-display').textContent = code;
}

function tickTimers() {
  const now = Date.now();

  if (qrExpiresAt) {
    const remaining = Math.max(0, Math.ceil((qrExpiresAt - now) / 1000));
    const pct = Math.min(100, (remaining / (qrIntervalMs / 1000)) * 100);
    const bar = document.getElementById('qr-timer-bar');
    const txt = document.getElementById('qr-timer-text');
    if (bar && txt) {
      bar.style.width = pct + '%';
      bar.className = 'timer-bar' + (pct < 30 ? ' danger' : pct < 60 ? ' warning' : '');
      txt.textContent = remaining + 's';
    }
  }

  if (codeExpiresAt) {
    const remaining = Math.max(0, Math.ceil((codeExpiresAt - now) / 1000));
    const pct = Math.min(100, (remaining / (codeIntervalMs / 1000)) * 100);
    const bar = document.getElementById('code-timer-bar');
    const txt = document.getElementById('code-timer-text');
    if (bar && txt) {
      bar.style.width = pct + '%';
      bar.className = 'timer-bar' + (pct < 30 ? ' danger' : pct < 60 ? ' warning' : '');
      txt.textContent = remaining + 's';
    }
  }
}

// ===== END SESSION =====
document.getElementById('end-session-btn').onclick = async () => {
  if (!confirm('End this session? This will stop attendance marking.')) return;
  await fetch(`${API}/api/session/end`, { method: 'POST' });
  if (timerTick) { clearInterval(timerTick); timerTick = null; }
  show('active-session', false);
  show('session-setup', true);
  document.getElementById('course-name').value = '';
  document.getElementById('excel-upload').value = '';
  document.getElementById('upload-filename').textContent = 'No file chosen';
};

// ===== EXPORT =====
document.getElementById('export-btn').onclick = () => {
  window.location.href = `${API}/api/excel/export`;
};

// ===== ROSTER =====
async function loadRoster() {
  try {
    const r = await fetch(`${API}/api/attendance/roster`);
    const data = await r.json();
    if (Array.isArray(data)) renderRoster(data);
  } catch (e) {}
}

function renderRoster(roster) {
  const tbody = document.getElementById('roster-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  let presentCount = 0, absentCount = 0;
  for (const s of roster) {
    if (s.status === 'present') presentCount++;
    else absentCount++;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.serial_no || ''}</td>
      <td><strong>${s.roll_no}</strong></td>
      <td>${s.name}</td>
      <td><span class="badge badge-${s.status}">${s.status === 'present' ? 'P' : 'A'}</span></td>
      <td style="color:var(--muted);font-size:0.75rem">${s.method || ''}</td>
      <td><button class="toggle-btn" onclick="toggleStudent('${s.roll_no}','${s.status}')">${s.status === 'present' ? 'Mark Absent' : 'Mark Present'}</button></td>
    `;
    tbody.appendChild(tr);
  }

  document.getElementById('stat-present').textContent = `Present: ${presentCount}`;
  document.getElementById('stat-absent').textContent = `Absent: ${absentCount}`;
}

async function toggleStudent(rollNo, currentStatus) {
  const newStatus = currentStatus === 'present' ? 'absent' : 'present';
  await fetch(`${API}/api/attendance/override`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rollNo, status: newStatus })
  });
  loadRoster();
}

// ===== WEBSOCKET =====
function connectWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}`);

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'qr_token') {
      qrIntervalMs = msg.intervalMs || qrIntervalMs;
      updateQR(msg.token, msg.expiresAt);
    } else if (msg.type === 'code_token') {
      codeIntervalMs = msg.intervalMs || codeIntervalMs;
      updateCode(msg.code, msg.expiresAt);
    } else if (msg.type === 'attendance_update') {
      renderRoster(msg.roster);
    } else if (msg.type === 'session_ended') {
      // Student side
      show('student-form', false);
      show('no-session', true);
    }
  };

  ws.onclose = () => { setTimeout(connectWS, 3000); };
  ws.onerror = () => ws.close();
}

// ===== STUDENT SIDE =====
async function checkStudentSession() {
  connectWS();
  try {
    const r = await fetch(`${API}/api/session/status`);
    const data = await r.json();
    if (data.active) {
      show('no-session', false);
      show('student-form', true);
      document.getElementById('student-course-name').textContent = data.courseName;
      const d = new Date();
      document.getElementById('student-date').textContent =
        `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
    } else {
      show('no-session', true);
      show('student-form', false);
    }
  } catch (e) {
    show('no-session', true);
    show('student-form', false);
  }
}

// ===== TABS =====
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  };
});

// ===== QR SCANNER =====
let scanning = false;
document.getElementById('start-camera-btn').onclick = async () => {
  const video = document.getElementById('qr-video');
  const btn = document.getElementById('start-camera-btn');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream;
    video.style.display = 'block';
    btn.style.display = 'none';
    scanning = true;
    scanLoop(video);
  } catch (e) {
    document.getElementById('qr-scan-status').textContent = '❌ Camera access denied. Use the code tab instead.';
    document.getElementById('qr-scan-status').className = 'status-msg status-err';
  }
};

async function scanLoop(video) {
  if (!scanning) return;
  if (video.readyState < 2) { requestAnimationFrame(() => scanLoop(video)); return; }

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);

  try {
    if ('BarcodeDetector' in window) {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const codes = await detector.detect(canvas);
      if (codes.length > 0) {
        const token = codes[0].rawValue;
        await submitQRToken(token);
        return;
      }
    }
  } catch (e) {}

  if (scanning) setTimeout(() => scanLoop(video), 200);
}

async function submitQRToken(token) {
  scanning = false;
  const rollNo = document.getElementById('student-roll-qr').value.trim();
  const status = document.getElementById('qr-scan-status');

  if (!rollNo) {
    status.textContent = 'Please enter your roll number first.';
    status.className = 'status-msg status-err';
    scanning = true;
    return;
  }

  status.textContent = 'Verifying...';
  status.className = 'status-msg';

  try {
    const r = await fetch(`${API}/api/attendance/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rollNo, token, deviceFingerprint: getDeviceFingerprint() })
    });
    const data = await r.json();
    if (r.ok) {
      showSuccess(data.message);
      stopCamera();
    } else {
      status.textContent = '❌ ' + data.error;
      status.className = 'status-msg status-err';
      setTimeout(() => {
        scanning = true;
        const video = document.getElementById('qr-video');
        if (video.srcObject) scanLoop(video);
      }, 2000);
    }
  } catch (e) {
    status.textContent = '❌ Network error';
    status.className = 'status-msg status-err';
    scanning = true;
  }
}

function stopCamera() {
  scanning = false;
  const video = document.getElementById('qr-video');
  if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
  video.style.display = 'none';
  document.getElementById('start-camera-btn').style.display = 'block';
}

// ===== MANUAL CODE SUBMIT =====
document.getElementById('submit-code-btn').onclick = async () => {
  const rollNo = document.getElementById('student-roll-code').value.trim();
  const code = document.getElementById('manual-code-input').value.trim();
  const status = document.getElementById('code-status');
  status.textContent = '';

  if (!rollNo) { status.textContent = 'Enter your roll number'; status.className = 'status-msg status-err'; return; }
  if (!code || code.length !== 6) { status.textContent = 'Enter the 6-digit code'; status.className = 'status-msg status-err'; return; }

  const btn = document.getElementById('submit-code-btn');
  btn.textContent = 'Verifying...'; btn.disabled = true;

  try {
    const r = await fetch(`${API}/api/attendance/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rollNo, code, deviceFingerprint: getDeviceFingerprint() })
    });
    const data = await r.json();
    if (r.ok) {
      showSuccess(data.message);
    } else {
      status.textContent = '❌ ' + data.error;
      status.className = 'status-msg status-err';
    }
  } catch (e) {
    status.textContent = '❌ Network error';
    status.className = 'status-msg status-err';
  }
  btn.textContent = 'Mark Attendance'; btn.disabled = false;
};

function showSuccess(msg) {
  document.getElementById('student-form').querySelectorAll('.tabs, .tab-content, .session-info-banner').forEach(el => el.style.opacity = '0.4');
  const banner = document.getElementById('attendance-success');
  document.getElementById('success-msg').textContent = msg;
  banner.classList.remove('hidden');
}

// ===== UTILS =====
function show(id, visible) {
  const el = document.getElementById(id);
  if (!el) return;
  if (visible) el.classList.remove('hidden');
  else el.classList.add('hidden');
}
