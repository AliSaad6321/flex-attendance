-- FLEX Attendance v4 Schema
-- All data is ephemeral per-upload session, cleared on end

CREATE TABLE IF NOT EXISTS active_session (
    id SERIAL PRIMARY KEY,
    course_name TEXT NOT NULL,
    teacher_password_hash TEXT NOT NULL,
    qr_token TEXT NOT NULL,
    qr_token_expires_at TIMESTAMPTZ NOT NULL,
    qr_interval_ms INTEGER NOT NULL DEFAULT 10000,
    code_token TEXT NOT NULL,
    code_interval_ms INTEGER NOT NULL DEFAULT 15000,
    code_expires_at TIMESTAMPTZ NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE
);

-- Students loaded from uploaded Excel (cleared on session end)
CREATE TABLE IF NOT EXISTS session_students (
    id SERIAL PRIMARY KEY,
    roll_no TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    serial_no INTEGER
);

-- Attendance for current session
CREATE TABLE IF NOT EXISTS session_attendance (
    id SERIAL PRIMARY KEY,
    roll_no TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'absent' CHECK (status IN ('present', 'absent')),
    marked_at TIMESTAMPTZ,
    method TEXT DEFAULT 'qr' CHECK (method IN ('qr', 'manual', 'code')),
    device_fingerprint TEXT
);

-- Previous attendance columns from uploaded Excel (stored as JSON)
CREATE TABLE IF NOT EXISTS previous_attendance (
    id SERIAL PRIMARY KEY,
    roll_no TEXT NOT NULL,
    columns_json TEXT NOT NULL  -- JSON: {"14/05/2026": "P", "13/05/2026": "A", ...}
);
