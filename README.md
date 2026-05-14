# FLEX Attendance v4 - Deploy Guide

## What's new in v4
- **No login at all** — toggle between Teacher/Student on the home screen
- **No permanent DB** — DB is cleared when session ends / sheet is exported. Students exist only for the duration of a session
- **Upload-to-Export flow** — Teacher uploads Excel → students mark attendance → teacher exports updated Excel → DB clears automatically
- **Previous attendance preserved** — if the uploaded sheet already has date columns (P/A data), those columns carry through to the exported sheet unchanged
- **Dynamic 6-digit manual code** — shown below the QR. Separate refresh interval controllable by teacher (5–60s)
- **QR interval slider** — teacher sets QR refresh rate (5–60s) when starting session
- **Teacher enters course name** when starting — no pre-registration needed
- **One device per session** — device fingerprint prevents one phone from marking two students
- **Student enters roll number** before scanning — validated against uploaded sheet

---

## Step 1: Neon Database

1. Go to https://neon.tech → create free account → New Project
2. Open **SQL Editor**
3. Paste the contents of `backend/db/schema.sql` → click **Run**
4. Copy your **Connection String** (looks like `postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require`)

---

## Step 2: GitHub

1. Create a new repository on GitHub (can be private)
2. Push this folder:
```bash
cd flex-v4
git init
git add .
git commit -m "FLEX Attendance v4"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

---

## Step 3: Render

1. Go to https://render.com → New → **Web Service**
2. Connect your GitHub repo
3. Settings:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free

4. Under **Environment Variables**, add:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | Your Neon connection string |
| `SESSION_SECRET` | Run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and paste result |
| `TEACHER_PASSWORD` | Any password you want (e.g. `myclass2026`) |
| `NODE_ENV` | `production` |

5. Click **Deploy**. Wait ~2 min. Your app will be at `https://your-app.onrender.com`

---

## How to Use (Demo Day)

### Teacher Flow
1. Open the app → click **Teacher**
2. Enter the teacher password (whatever you set in `TEACHER_PASSWORD`)
3. Enter course name (e.g. "Web Engineering CS-3002")
4. Set QR and Code refresh intervals using sliders
5. Upload the student Excel sheet (your instructor's format)
6. Click **Start Session**
7. Project the QR + 6-digit code on screen
8. Watch the live roster update as students scan
9. Manually toggle any student's status with the Toggle button
10. When class is done → **Export Sheet** (downloads updated Excel) → **End Session**

### Student Flow
1. Open the app (on phone) → click **Student**
2. If session is active: enter roll number
3. **Tab 1 - Scan QR:** point camera at projector
4. **Tab 2 - Enter Code:** type the 6-digit code shown below the QR

### Anti-Proxy Mechanisms
- QR token changes every N seconds (teacher-configurable)
- Manual code changes at a separate interval
- One device fingerprint per student per session
- Student must be logged into portal (authenticated session)
- Roll number validated against uploaded student list

---

## Excel Format

The uploaded sheet must have:
- A column with "Roll No" in the header (any spelling variation)
- A column with "Name" or "Student Name"
- Optional: date columns (DD/MM/YYYY format) with P/A values

The exported sheet:
- Preserves all previous date columns unchanged
- Adds today's date as a new column
- Matches original plain Arial 10 format
- Filename: `Attendance_CourseName_DD-MM-YYYY.xlsx`

---

## Troubleshooting

**Server crash on start:** Check DATABASE_URL is correct in Render env vars. Check Neon schema was run.

**Import fails:** Make sure the Excel has a "Roll No" column header. The file must be .xlsx format.

**QR not scanning on mobile:** The app must be served over HTTPS (Render provides this automatically). Camera won't work on plain HTTP.

**Students not found:** Make sure students scanned after the sheet was imported. Restarting a session clears the student list — re-import the sheet.

**Export downloads empty sheet:** Students must be imported first. Check that `/api/excel/import` returned success after upload.
