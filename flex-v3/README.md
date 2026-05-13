# FLEX Attendance System v3
**No-login QR Attendance · Excel Import/Export · One-Device-Per-Session Anti-Proxy**

---

## What's New in v3

| Feature | Detail |
|---------|--------|
| **No login required** | Toggle button: Teacher mode (password) or Student mode (roll number only) |
| **Excel import** | Upload instructor's sheet — students enrolled automatically |
| **Excel export** | Downloads in exact instructor format: S# \| Roll No. \| Student Name \| DD/MM/YYYY columns |
| **Editable records** | Teacher can view and click-edit any P/A cell across all sessions |
| **Adjustable QR interval** | Slider 5s–60s, changeable live during session |
| **One device per session** | Browser fingerprint blocks same device marking two students |
| **IP logging** | Every scan logs the student's IP address |

---

## How It Works

```
Teacher opens app → clicks Teacher → enters password → sees dashboard
Teacher imports Excel sheet of students → clicks course → sets QR interval → starts session
QR appears → teacher projects on screen
Students open app on phone → click Student → enter roll number → tap course → scan QR
Teacher sees live roster update → can toggle any student manually → exports Excel when done
```

---

## STEP-BY-STEP DEPLOYMENT ON RENDER

---

### STEP 1 — Neon Database (5 min)

1. Go to **https://neon.tech** → create free account
2. New Project → name it `flex-v3`
3. Left sidebar → **SQL Editor**
4. Open `backend/db/schema.sql` from this zip → copy ALL contents → paste → **Run**
5. You should see success messages for CREATE TABLE and INSERT
6. Left sidebar → **Connection Details** → copy the **Connection string**
   - Format: `postgresql://user:pass@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require`

---

### STEP 2 — Push to GitHub (3 min)

1. Create a new repo at **https://github.com** (name: `flex-v3`, set Private)
2. Open terminal in the extracted `flex-v3` folder:

```bash
git init
git add .
git commit -m "FLEX v3 initial"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/flex-v3.git
git push -u origin main
```

---

### STEP 3 — Deploy on Render (5 min)

1. Go to **https://render.com** → sign in with GitHub
2. Click **New +** → **Web Service**
3. Connect your `flex-v3` repository
4. Fill in settings:

| Setting | Value |
|---------|-------|
| Name | `flex-v3` |
| **Root Directory** | `backend` |
| Environment | `Node` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | `Free` |

5. Scroll to **Environment Variables** → Add:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | Your Neon connection string |
| `JWT_SECRET` | Random 64-char string (see below) |
| `TEACHER_PASSWORD` | Any password you want (e.g. `teacher123`) |
| `FRONTEND_URL` | `https://flex-v3.onrender.com` *(update after deploy)* |

**Generating JWT_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

6. Click **Create Web Service** → wait ~3 min
7. Watch Logs — success looks like:
```
🎓 FLEX v3 · http://localhost:10000
📡 WebSocket · ws://localhost:10000/ws
🗄️  Neon DB  · ✓ Configured
```

---

### STEP 4 — Update FRONTEND_URL

Once you have your Render URL (e.g. `https://flex-v3-xxxx.onrender.com`):
- Render Dashboard → Environment → update `FRONTEND_URL` to your actual URL
- Render will auto-redeploy

---

### STEP 5 — Add Your Course

Run in Neon SQL Editor (replace with your real course details):

```sql
-- If teacher id=1 was created by schema.sql:
INSERT INTO courses (name, code, teacher_id) VALUES ('Web Engineering', 'CS-3002', 1);
-- Add more courses:
INSERT INTO courses (name, code, teacher_id) VALUES ('Database Systems', 'CS-3004', 1);
```

---

### STEP 6 — Import Students

1. Open your deployed URL on laptop
2. Click **Teacher** → enter your `TEACHER_PASSWORD`
3. Click **⬆ Import Student List**
4. Select the course
5. Upload the instructor's Excel sheet (the one with Roll No. and Student Name columns)
6. Click **Import** — all students are enrolled automatically

---

## Demo Flow for Presentation

1. **Laptop (Teacher):**
   - Open `https://your-app.onrender.com`
   - Click Teacher → enter password
   - Import student list if not done
   - Click a course → set interval to 10s → Start Session
   - QR appears — show on projector

2. **Phone (Student):**
   - Open same URL on phone
   - Click Student → enter roll number (e.g. `24L-3007`)
   - Tap the course → camera opens → scan QR
   - See green tick

3. **Back on laptop:**
   - See student's name turn green in real time
   - Toggle any student manually if needed
   - Click **⬇ Export Excel** — get attendance sheet in instructor format

---

## Excel Format (Output)

The exported file matches exactly what the instructor wants:

```
| S# | Roll No.  | Student Name       | 14/05/2026 | 15/05/2026 | ...
|  1 | 23L-3007  | Muhammad Abdullah  |     P      |     A      |
|  2 | 24L-3003  | Adina Saqib        |     A      |     P      |
```

- **P** = Present (green cell)
- **A** = Absent (red cell)
- Dates in **DD/MM/YYYY** format
- Students sorted by roll number

---

## Anti-Proxy System

Three layers protect against proxy attendance:

1. **Rotating QR token** — refreshes every N seconds (5–60s, you control it). A screenshot shared over WhatsApp will be expired before the recipient can scan it.

2. **Device fingerprint** — each browser gets a persistent ID stored in localStorage. If Student A's phone marks attendance for Student B, the system checks: "has this device fingerprint already been used for a different student in this session?" If yes → rejected.

3. **IP logging** — every scan records the IP address for the teacher's records.

---

## Project Structure

```
flex-v3/
├── backend/
│   ├── db/
│   │   ├── pool.js           # Neon connection
│   │   └── schema.sql        # Run this in Neon first ← IMPORTANT
│   ├── middleware/
│   │   └── auth.js           # JWT middleware
│   ├── routes/
│   │   ├── auth.js           # Teacher password + student roll-number entry
│   │   ├── attendance.js     # QR engine, sessions, roster, WebSocket
│   │   └── excel.js          # Import .xlsx, export .xlsx, preview/edit
│   ├── server.js
│   ├── package.json
│   └── .env.example          # Copy to .env for local dev
└── frontend/
    └── public/
        ├── index.html        # Single page — no login, toggle button
        ├── css/style.css
        └── js/app.js
```

---

## Running Locally

```bash
cd backend
npm install
cp .env.example .env
# Fill in DATABASE_URL, JWT_SECRET, TEACHER_PASSWORD
node server.js
# Open http://localhost:3000
```

---

## Common Issues

| Problem | Fix |
|---------|-----|
| "Roll number not found" | Import the student list first via Teacher → Import Student List |
| Session crashes on start | Run schema.sql in Neon — all tables must exist |
| Camera doesn't open on phone | Must be HTTPS — Render provides this automatically |
| QR says expired | Normal — scan the latest code. Token rotated. |
| Export downloads empty file | Need at least one session with enrolled students |
| Render free tier slow | First request after 15min idle takes ~30s. Open app before demo. |
| "Not your course" error | Course teacher_id must match the teacher user's id in DB |

---

## Changing Teacher Password

Just update the `TEACHER_PASSWORD` environment variable in Render → Save Changes.
No code change needed.
