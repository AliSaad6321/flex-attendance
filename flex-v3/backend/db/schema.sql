-- FLEX v3 Schema — Run once in Neon SQL Editor
DROP TABLE IF EXISTS attendance CASCADE;
DROP TABLE IF EXISTS sessions    CASCADE;
DROP TABLE IF EXISTS enrollments CASCADE;
DROP TABLE IF EXISTS courses     CASCADE;
DROP TABLE IF EXISTS users       CASCADE;

CREATE TABLE users (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    roll_no       TEXT UNIQUE,
    email         TEXT UNIQUE,
    password_hash TEXT,
    role          TEXT CHECK (role IN ('teacher','student')),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE courses (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    code       TEXT UNIQUE NOT NULL,
    teacher_id INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE enrollments (
    id         SERIAL PRIMARY KEY,
    student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    course_id  INTEGER REFERENCES courses(id) ON DELETE CASCADE,
    UNIQUE(student_id, course_id)
);

CREATE TABLE sessions (
    id               SERIAL PRIMARY KEY,
    course_id        INTEGER REFERENCES courses(id) ON DELETE CASCADE,
    teacher_id       INTEGER REFERENCES users(id),
    date             DATE NOT NULL DEFAULT CURRENT_DATE,
    started_at       TIMESTAMPTZ DEFAULT NOW(),
    ended_at         TIMESTAMPTZ,
    is_active        BOOLEAN DEFAULT TRUE,
    current_token    TEXT,
    token_expires_at TIMESTAMPTZ,
    token_interval   INTEGER DEFAULT 10
);

CREATE TABLE attendance (
    id         SERIAL PRIMARY KEY,
    session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
    student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present','absent')),
    marked_at  TIMESTAMPTZ DEFAULT NOW(),
    method     TEXT DEFAULT 'qr' CHECK (method IN ('qr','manual')),
    device_fp  TEXT,
    ip_address TEXT,
    UNIQUE(session_id, student_id)
);

-- Demo teacher (no-login mode — password only needed for teacher toggle)
INSERT INTO users (name, email, password_hash, role)
VALUES ('Demo Teacher','teacher@nu.edu.pk','password123','teacher');

-- Demo course
INSERT INTO courses (name, code, teacher_id)
VALUES ('Web Engineering','CS-3002',1);
