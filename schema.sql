-- School Result Management System schema

-- Each school is an independent tenant: its own name, logo, signup code,
-- and email (SMTP) settings for parent notifications. A single deployment
-- of this app can host many schools side by side, fully isolated from
-- each other.
CREATE TABLE IF NOT EXISTS schools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT 'My School',
    logo_filename TEXT,
    logo_align TEXT NOT NULL DEFAULT 'center',   -- left / center / right
    staff_signup_code TEXT,
    smtp_host TEXT,
    smtp_port INTEGER,
    smtp_username TEXT,
    smtp_password TEXT,
    smtp_use_tls INTEGER DEFAULT 1,
    smtp_from_email TEXT,
    smtp_from_name TEXT,
    is_suspended INTEGER DEFAULT 0,
    auto_teacher_comment INTEGER DEFAULT 0,
    auto_principal_comment INTEGER DEFAULT 0,
    cumulative_enabled INTEGER DEFAULT 0,
    web_font TEXT DEFAULT 'system',
    pdf_font TEXT DEFAULT 'Helvetica',
    subdomain TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Notifications: sent by a Super Admin (school_id NULL = every school) or
-- by a School Admin/Sub-Admin (always scoped to their own school), targeted
-- at a role. Read/unread is tracked per-recipient via a simple "last seen
-- notification id" on users/students, rather than a row per recipient.
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_label TEXT NOT NULL,        -- e.g. "Platform Admin: Jane" or "Admin: John"
    school_id INTEGER,                 -- NULL = every school (platform-wide only)
    target_role TEXT NOT NULL,         -- 'all', 'admin', 'teacher', 'student'
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

-- Platform-level Super Admins: completely separate login from school staff
-- and students, since they aren't scoped to any one school.
CREATE TABLE IF NOT EXISTS platform_admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    security_question TEXT,
    security_answer_hash TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Platform-wide audit trail: school suspensions/activations/deletions,
-- platform admin logins, and other high-level moderation actions.
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_type TEXT NOT NULL,      -- 'platform_admin', 'admin', 'sub_admin', etc.
    actor_name TEXT,
    school_id INTEGER,             -- the affected school, if any
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'sub_admin', 'teacher')),
    position TEXT,
    security_question TEXT,
    security_answer_hash TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_notification_seen_id INTEGER DEFAULT 0,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    is_active INTEGER DEFAULT 0,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    UNIQUE(school_id, name)
);

CREATE TABLE IF NOT EXISTS terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    session_id INTEGER NOT NULL,
    is_active INTEGER DEFAULT 0,
    is_published INTEGER DEFAULT 0,
    next_term_begins TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    category TEXT,
    form_teacher_id INTEGER,
    FOREIGN KEY(form_teacher_id) REFERENCES users(id),
    FOREIGN KEY(school_id) REFERENCES schools(id),
    UNIQUE(school_id, name)
);

CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    UNIQUE(school_id, name)
);

CREATE TABLE IF NOT EXISTS class_subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    teacher_id INTEGER,
    FOREIGN KEY(class_id) REFERENCES classes(id),
    FOREIGN KEY(subject_id) REFERENCES subjects(id),
    FOREIGN KEY(teacher_id) REFERENCES users(id),
    UNIQUE(class_id, subject_id)
);

-- admission_no doubles as "Admission No. / Register No." per the school's
-- request to use one field. It only needs to be unique WITHIN a class (arm)
-- — not school-wide — so different arms (e.g. SS1 Science 1 / SS1 Science 2)
-- can reuse the same numbers for different students.
CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admission_no TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    other_names TEXT,
    gender TEXT CHECK(gender IN ('M','F')),
    class_id INTEGER NOT NULL,
    date_of_birth TEXT,
    religion TEXT,
    parent_name TEXT,
    parent_address TEXT,
    parent_email TEXT,
    parent_phone TEXT,
    username TEXT,
    password_hash TEXT,
    last_notification_seen_id INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    FOREIGN KEY(class_id) REFERENCES classes(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_students_class_admission_no
    ON students(class_id, admission_no);

CREATE UNIQUE INDEX IF NOT EXISTS idx_students_username
    ON students(username) WHERE username IS NOT NULL;

-- Which class a student was in during each academic session. This is the
-- source of truth for historical broadsheets/results after a promotion —
-- students.class_id is just their CURRENT class for convenience elsewhere.
CREATE TABLE IF NOT EXISTS enrollments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    session_id INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    FOREIGN KEY(student_id) REFERENCES students(id),
    FOREIGN KEY(session_id) REFERENCES sessions(id),
    FOREIGN KEY(class_id) REFERENCES classes(id),
    UNIQUE(student_id, session_id)
);

CREATE TABLE IF NOT EXISTS grading_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    ca1_max REAL DEFAULT 20,
    ca2_max REAL DEFAULT 20,
    exam_max REAL DEFAULT 60,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

CREATE TABLE IF NOT EXISTS grade_scale (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    grade TEXT NOT NULL,
    min_score REAL NOT NULL,
    max_score REAL NOT NULL,
    remark TEXT,
    FOREIGN KEY(school_id) REFERENCES schools(id)
);

CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    term_id INTEGER NOT NULL,
    ca1 REAL DEFAULT 0,
    ca2 REAL DEFAULT 0,
    exam REAL DEFAULT 0,
    FOREIGN KEY(student_id) REFERENCES students(id),
    FOREIGN KEY(subject_id) REFERENCES subjects(id),
    FOREIGN KEY(term_id) REFERENCES terms(id),
    UNIQUE(student_id, subject_id, term_id)
);

CREATE TABLE IF NOT EXISTS score_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    term_id INTEGER NOT NULL,
    old_ca1 REAL, old_ca2 REAL, old_exam REAL,
    new_ca1 REAL, new_ca2 REAL, new_exam REAL,
    changed_by INTEGER,
    changed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(student_id) REFERENCES students(id),
    FOREIGN KEY(subject_id) REFERENCES subjects(id),
    FOREIGN KEY(term_id) REFERENCES terms(id),
    FOREIGN KEY(changed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS student_term_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    term_id INTEGER NOT NULL,
    days_present INTEGER DEFAULT 0,
    days_absent INTEGER DEFAULT 0,
    days_school_opened INTEGER DEFAULT 0,
    teacher_comment TEXT,
    principal_comment TEXT,
    teacher_signed_date TEXT,
    principal_signed_date TEXT,
    FOREIGN KEY(student_id) REFERENCES students(id),
    FOREIGN KEY(term_id) REFERENCES terms(id),
    UNIQUE(student_id, term_id)
);

CREATE TABLE IF NOT EXISTS skill_traits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    category TEXT CHECK(category IN ('psychomotor','affective')),
    FOREIGN KEY(school_id) REFERENCES schools(id),
    UNIQUE(school_id, name)
);

CREATE TABLE IF NOT EXISTS student_skill_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    term_id INTEGER NOT NULL,
    trait_id INTEGER NOT NULL,
    rating INTEGER CHECK(rating BETWEEN 1 AND 5),
    FOREIGN KEY(student_id) REFERENCES students(id),
    FOREIGN KEY(term_id) REFERENCES terms(id),
    FOREIGN KEY(trait_id) REFERENCES skill_traits(id),
    UNIQUE(student_id, term_id, trait_id)
);

-- Daily roll call, one row per student per calendar date per term. A date
-- is either 'present' or 'absent' — never both — so Days Open, Present and
-- Absent (derived below) can never disagree; there's no way to record an
-- "impossible" attendance state.
CREATE TABLE IF NOT EXISTS attendance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    term_id INTEGER NOT NULL,
    date TEXT NOT NULL,            -- YYYY-MM-DD
    status TEXT NOT NULL CHECK(status IN ('present','absent')),
    recorded_by INTEGER,
    recorded_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(student_id) REFERENCES students(id),
    FOREIGN KEY(class_id) REFERENCES classes(id),
    FOREIGN KEY(term_id) REFERENCES terms(id),
    FOREIGN KEY(recorded_by) REFERENCES users(id),
    UNIQUE(student_id, term_id, date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_class_term_date
    ON attendance_records(class_id, term_id, date);

CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    session_id INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'Notes',
    filename TEXT,
    original_filename TEXT,
    external_url TEXT,
    uploaded_by INTEGER,
    uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(session_id) REFERENCES sessions(id),
    FOREIGN KEY(class_id) REFERENCES classes(id),
    FOREIGN KEY(subject_id) REFERENCES subjects(id),
    FOREIGN KEY(uploaded_by) REFERENCES users(id),
    CHECK (filename IS NOT NULL OR external_url IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_materials_class_subject ON materials(class_id, subject_id);

CREATE TABLE IF NOT EXISTS staff_attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('Present','Absent','Late','Leave')),
    recorded_by INTEGER,
    recorded_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(school_id) REFERENCES schools(id),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(recorded_by) REFERENCES users(id),
    UNIQUE(user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_staff_attendance_school_date ON staff_attendance(school_id, date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_schools_subdomain ON schools(subdomain) WHERE subdomain IS NOT NULL;

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);
