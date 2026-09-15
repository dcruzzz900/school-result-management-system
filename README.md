# School Result Management System

A web app for recording student assessments (CA1 + CA2 + Exam), generating
class broadsheets, and printing/downloading terminal report cards — built with
Flask + SQLite.

## Features

- **Roles:** Admin (full setup access) and Teacher (score entry for assigned subjects only)
- **Setup:** classes, subjects, students, teachers, subject-to-class-teacher assignment — each can be added, reassigned, and deleted from the admin screens
- **Sessions & Terms:** create sessions (e.g. 2025/2026) and terms (1st/2nd/3rd), mark one active at a time
- **Configurable grading:** weighting (default CA1=20, CA2=20, Exam=60) and the full A–F grade scale are both editable from Setup → Grading — add, edit, or delete grade bands directly in the app
- **Score entry:** teachers enter CA1/CA2/Exam per student for their assigned class & subject
- **Broadsheet:** auto-calculated totals, averages, and class rank/position — viewable on screen, printable, and downloadable as PDF
- **Terminal report card (per student):** subject breakdown with grades/remarks, class position, attendance, teacher's & principal's comments, and psychomotor/affective skill ratings — viewable, printable, and downloadable as PDF
- **Change password:** any logged-in user (admin or teacher) can change their own password from the navbar
- **Bulk student import:** upload a CSV to add many students at once instead of one at a time (Setup → Students → Bulk Upload)
- **Clear demo data:** one click on the admin dashboard wipes the seeded sample class/subjects/students/teachers so you can load your real school's data on a clean slate
- **Installable as an app:** works as a PWA — "Add to Home Screen" on Android/Chrome for a full-screen app experience, or package it as a real `.apk` (see PACKAGE_AS_ANDROID_APP.md)
- **School branding:** set your school's name and upload a logo anytime from Setup → School Profile — it appears on the navbar, dashboard, broadsheet, and terminal result (both on-screen and in the downloaded PDFs)
- **Staff self-registration:** teachers can create their own login at "Staff: create your login" on the login page, using a signup code you set from Setup → School Profile (leave the code blank to turn registration off)
- **Password/username recovery:** anyone can self-recover a forgotten password via a security question they set at registration ("Forgot password?" on the login page); admin can also reset any teacher's password directly from Setup → Teachers if needed
- **Position-based result access:** at registration, staff choose their position — Principal, Vice Principal, Exam Officer, Form Teacher, or Subject Teacher. Principals, Vice Principals, and Exam Officers can view every class's broadsheet/results; a Form Teacher (as actually assigned in Setup → Classes) can view their own class's broadsheet/results; a plain Subject Teacher cannot view broadsheets/results at all — only enter scores for their assigned subject
- **Multi-school support:** this one deployment can host many independent schools, each fully isolated from the others. Anyone can register a brand-new school at "New school? Register your school here" on the login page; staff registering afterward pick their school from a dropdown
- **Score change history:** every time a score is entered or edited, who changed it, when, and the old vs. new values are recorded — viewable from Score Entry → "View Change History"
- **Work-offline CSV for scores:** subject teachers can download a CSV pre-filled with their class's current scores, edit it offline, and upload it back — from the Score Entry page
- **Email results to parents:** configure SMTP under Setup → Email Settings, then email an individual result or an entire class's results to parents with one click, straight from the result/broadsheet pages. Requires a parent email on file for each student (Setup → Students, or the form teacher's own "My Class" page)
- **Form teachers manage their own class register:** a form teacher can add and correct their own students' names/details exactly as written in the physical class register, from "My Class" in the navbar — no admin needed for routine name corrections
- **Register number vs. admission number:** admission number is permanent and unique across the whole school; register number is just the class roll number, so "001" can exist in both JSS1 Science 1 and JSS1 Science 2 without conflict
- **Other/middle names:** students can have first, last, and other names, shown consistently everywhere (Surname Firstname Othername)
- **Customizable logo alignment:** choose left, center, or right for the dashboard logo from Setup → School Profile

## Roles & Result Access

- **Admin** — full access to everything, including all setup screens and every class's results.
- **Principal / Vice Principal / Exam Officer** — can view the broadsheet and terminal results for **every** class, but don't get the admin Setup screens.
- **Form Teacher** — can view the broadsheet and terminal results only for the class(es) they're actually assigned to as form teacher (set by admin in Setup → Classes → "Set Form Teacher"). This is checked against the real assignment, not just their self-declared position — so simply selecting "Form Teacher" at registration isn't enough on its own; the admin still has to assign them to a class.
- **Subject Teacher** — can only enter scores for the subject/class they're assigned to teach (Setup → Assign Subjects). No broadsheet/result access, unless they're *also* assigned as a form teacher somewhere — in which case they get access for that class, same as any form teacher.

A teacher's position can be corrected anytime from Setup → Teachers if someone selects the wrong one at registration.

## Setup

1. Install dependencies (Python 3.10+ recommended):
   ```
   pip install -r requirements.txt
   ```

2. Run the app (this creates and seeds the database on first run):
   ```
   python app.py
   ```

3. Open **http://localhost:5050** in your browser.

## Default logins (seeded on first run)

| Role    | Username  | Password    |
|---------|-----------|-------------|
| Admin   | admin     | admin123    |
| Teacher | aokafor   | teacher123  |

**Change these passwords before using this in production** — either through
the admin "Teachers" screen (add new accounts) or by editing directly in the
database.

## Recommended first steps as Admin

1. Go to **Setup → Classes** and add your classes.
2. Go to **Setup → Subjects** and add your subjects.
3. Go to **Setup → Teachers** and create teacher accounts.
4. Go to **Setup → Assign Subjects** to link subjects to classes and assign a teacher to each.
5. Go to **Setup → Students** and add students to their classes — one at a time, or in bulk via the CSV upload on the same page.
6. Go to **Terms**, create a session and term, and mark them active.
7. Go to **Grading** to confirm/adjust the CA1/CA2/Exam weighting and the A–F grade scale.

Teachers can now log in and enter scores for their assigned subject/class from
their dashboard. Once scores are in, use **Classes** in the nav to open a
class's **Broadsheet** or a student's **Terminal Result**, both printable and
downloadable as PDF.

## Moving from demo data to your real school data

The app comes seeded with one sample class, four subjects, and three
students so you can explore it immediately. When you're ready to load your
real school:

1. Go to the **admin dashboard** and use the **Clear Demo Data** button
   (type `RESET` to confirm). This removes the sample class, subjects,
   students, and teacher, along with any scores attached to them — your
   admin login, sessions/terms, and grading setup are kept.
2. Add your real classes, subjects, and teachers as described above.
3. Load your students either one at a time, or all at once via
   **Setup → Students → Bulk Upload** (download the CSV template there first).

## Deploying so teachers can access it from anywhere (free)

See **DEPLOY_PYTHONANYWHERE.md** in this folder for a full step-by-step guide
to hosting this for free on PythonAnywhere, with no command-line or Git
experience needed.

## Using it as an Android app

See **PACKAGE_AS_ANDROID_APP.md** — the app is a PWA (installable web app)
out of the box. Teachers can "Add to Home Screen" from Chrome for a full
app-like experience with zero setup, or you can generate a real `.apk` file
for sideloading/Play Store distribution.

## Notes on the current version

- Sample/demo data (one class, four subjects, three students) is seeded on
  first run so you can explore right away — use the **Clear Demo Data**
  button on the admin dashboard when you're ready to load your real school
  (see above), or delete `instance/school.db` and restart for a fully clean database.
- This uses SQLite, which is fine for a single school on one server. For
  multiple concurrent users at scale, migrating to PostgreSQL is a
  straightforward next step (the schema is plain SQL).
- The built-in server (`python app.py`) is for development. For real
  deployment, run it behind a production WSGI server (e.g. gunicorn) — ask
  if you'd like help setting that up.
