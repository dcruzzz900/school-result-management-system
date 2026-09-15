import sqlite3
import os
from werkzeug.security import generate_password_hash

INSTANCE_DIR = os.path.join(os.path.dirname(__file__), "instance")
DB_PATH = os.path.join(INSTANCE_DIR, "school.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = OFF")
    return conn


# ---------------------------------------------------------------------------
# Migration framework — each function runs exactly once, in order, tracked
# by a version number, so a database from any earlier version of this app
# upgrades in place safely without losing data.
# ---------------------------------------------------------------------------

def table_exists(conn, table):
    return conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is not None


def column_names(conn, table):
    return [row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]


def ensure_column(conn, table, column, coltype):
    if column not in column_names(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}")


def table_sql(conn, table):
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row["sql"] if row else ""


def migration_001_baseline(conn):
    with open(os.path.join(os.path.dirname(__file__), "schema.sql")) as f:
        conn.executescript(f.read())


def migration_002_multi_school(conn):
    for table in ("users", "classes", "subjects", "sessions", "grading_config", "grade_scale", "skill_traits"):
        ensure_column(conn, table, "school_id", "INTEGER")

    needs_backfill = any(
        conn.execute(f"SELECT COUNT(*) c FROM {table} WHERE school_id IS NULL").fetchone()["c"] > 0
        for table in ("users", "classes", "subjects", "sessions", "grading_config", "grade_scale", "skill_traits")
    )
    if not needs_backfill:
        return

    existing_school = conn.execute("SELECT id FROM schools LIMIT 1").fetchone()
    if existing_school:
        default_school_id = existing_school["id"]
    else:
        name, logo_filename, staff_signup_code = "My School", None, None
        if table_exists(conn, "school_settings"):
            row = conn.execute("SELECT * FROM school_settings WHERE id=1").fetchone()
            if row:
                name = row["school_name"] or name
                logo_filename = row["logo_filename"]
                if "staff_signup_code" in column_names(conn, "school_settings"):
                    staff_signup_code = row["staff_signup_code"]
        cur = conn.execute(
            "INSERT INTO schools (name, logo_filename, staff_signup_code) VALUES (?,?,?)",
            (name, logo_filename, staff_signup_code),
        )
        default_school_id = cur.lastrowid

    for table in ("users", "classes", "subjects", "sessions", "grading_config", "grade_scale", "skill_traits"):
        conn.execute(f"UPDATE {table} SET school_id=? WHERE school_id IS NULL", (default_school_id,))

    if table_exists(conn, "school_settings"):
        conn.execute("DROP TABLE school_settings")


def migration_003_student_fields(conn):
    for column, coltype in [
        ("other_names", "TEXT"),
        ("parent_name", "TEXT"),
        ("parent_email", "TEXT"),
        ("parent_phone", "TEXT"),
    ]:
        ensure_column(conn, "students", column, coltype)
    # register_no existed briefly in an earlier version of this migration;
    # it's superseded by migration_006, which merges it into admission_no.


def migration_004_school_email_and_logo_settings(conn):
    for column, coltype in [
        ("logo_align", "TEXT NOT NULL DEFAULT 'center'"),
        ("smtp_host", "TEXT"),
        ("smtp_port", "INTEGER"),
        ("smtp_username", "TEXT"),
        ("smtp_password", "TEXT"),
        ("smtp_use_tls", "INTEGER DEFAULT 1"),
        ("smtp_from_email", "TEXT"),
        ("smtp_from_name", "TEXT"),
    ]:
        ensure_column(conn, "schools", column, coltype)


def migration_005_expand_user_roles(conn):
    """Add a 'sub_admin' role who can manage everything about their own
    school except promoting/managing other admins or sub-admins."""
    if "'sub_admin'" in table_sql(conn, "users"):
        return  # already has the expanded CHECK constraint

    conn.execute("ALTER TABLE users RENAME TO users_old")
    conn.execute("""
        CREATE TABLE users (
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
            FOREIGN KEY(school_id) REFERENCES schools(id)
        )
    """)
    conn.execute("""
        INSERT INTO users (id, school_id, name, username, password_hash, role,
            position, security_question, security_answer_hash, created_at)
        SELECT id, school_id, name, username, password_hash, role,
            position, security_question, security_answer_hash, created_at
        FROM users_old
    """)
    conn.execute("DROP TABLE users_old")


def migration_006_merge_admission_register(conn):
    """Merge the separate Register No. field into Admission No. (shown as
    "Admission No. / Register No." throughout), unique only within a class
    (arm) rather than school-wide — so two arms of the same class (e.g. SS1
    Science 1 and SS1 Science 2) can reuse the same numbers for different
    students. Also adds religion and parent address fields."""
    needs_rebuild = "admission_no TEXT UNIQUE NOT NULL" in table_sql(conn, "students")

    if needs_rebuild:
        conn.execute("ALTER TABLE students RENAME TO students_old")
        conn.execute("""
            CREATE TABLE students (
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
                is_active INTEGER DEFAULT 1,
                FOREIGN KEY(class_id) REFERENCES classes(id)
            )
        """)
        conn.execute("""
            INSERT INTO students (id, admission_no, first_name, last_name, other_names,
                gender, class_id, date_of_birth, parent_name, parent_email, parent_phone, is_active)
            SELECT id, admission_no, first_name, last_name, other_names,
                gender, class_id, date_of_birth, parent_name, parent_email, parent_phone, is_active
            FROM students_old
        """)
        conn.execute("DROP TABLE students_old")

    for column, coltype in [("religion", "TEXT"), ("parent_address", "TEXT")]:
        ensure_column(conn, "students", column, coltype)

    conn.execute("DROP INDEX IF EXISTS idx_students_class_register_no")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_students_class_admission_no "
        "ON students(class_id, admission_no)"
    )


def migration_007_terms_publish_flag(conn):
    """Terms must be explicitly 'published' before results can be emailed
    to parents, so parents are only notified once a final result is ready
    — not on every CA/score update."""
    ensure_column(conn, "terms", "is_published", "INTEGER DEFAULT 0")


def migration_008_more_skill_traits(conn):
    new_traits = [("Club & Societies", "psychomotor"), ("Emotional Stability", "affective")]
    school_ids = [r["id"] for r in conn.execute("SELECT id FROM schools").fetchall()]
    for sid in school_ids:
        for name, cat in new_traits:
            conn.execute(
                "INSERT OR IGNORE INTO skill_traits (school_id, name, category) VALUES (?,?,?)",
                (sid, name, cat),
            )


def migration_009_signature_dates(conn):
    ensure_column(conn, "student_term_info", "teacher_signed_date", "TEXT")
    ensure_column(conn, "student_term_info", "principal_signed_date", "TEXT")


def migration_010_enrollments(conn):
    """Track which class a student was in during each academic session, so
    promoting a student to a new class doesn't rewrite their history —
    past terms' broadsheets/results still reflect the class they were
    actually in at the time."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS enrollments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            session_id INTEGER NOT NULL,
            class_id INTEGER NOT NULL,
            FOREIGN KEY(student_id) REFERENCES students(id),
            FOREIGN KEY(session_id) REFERENCES sessions(id),
            FOREIGN KEY(class_id) REFERENCES classes(id),
            UNIQUE(student_id, session_id)
        )
    """)
    # Backfill: every existing student is enrolled in their school's
    # currently active session, under their current class.
    schools = conn.execute("SELECT id FROM schools").fetchall()
    for school in schools:
        active_session = conn.execute(
            "SELECT id FROM sessions WHERE school_id=? AND is_active=1 LIMIT 1", (school["id"],)
        ).fetchone()
        if not active_session:
            continue
        students = conn.execute(
            "SELECT s.id, s.class_id FROM students s JOIN classes c ON c.id=s.class_id WHERE c.school_id=?",
            (school["id"],),
        ).fetchall()
        for st in students:
            conn.execute(
                "INSERT OR IGNORE INTO enrollments (student_id, session_id, class_id) VALUES (?,?,?)",
                (st["id"], active_session["id"], st["class_id"]),
            )


def migration_011_student_login(conn):
    """Optional student login: a student can be given a username/password
    (set by admin/sub-admin/form teacher) to view their own published
    results."""
    ensure_column(conn, "students", "username", "TEXT")
    ensure_column(conn, "students", "password_hash", "TEXT")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_students_username "
        "ON students(username) WHERE username IS NOT NULL"
    )


def migration_012_platform_tier(conn):
    """Adds the Super Admin / platform-level tier: platform_admins (a login
    completely separate from school staff/students), a per-school suspend
    flag, and a basic audit log for platform-level moderation actions."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS platform_admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            security_question TEXT,
            security_answer_hash TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_type TEXT NOT NULL,
            actor_name TEXT,
            school_id INTEGER,
            action TEXT NOT NULL,
            details TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    ensure_column(conn, "schools", "is_suspended", "INTEGER DEFAULT 0")


def migration_013_notifications(conn):
    """In-app notifications: sent by Super Admin (platform-wide or to one
    school) or by a School Admin/Sub-Admin (to their own school), targeted
    at a role. Read/unread is tracked via a simple 'last seen' id."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_label TEXT NOT NULL,
            school_id INTEGER,
            target_role TEXT NOT NULL,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(school_id) REFERENCES schools(id)
        )
    """)
    ensure_column(conn, "users", "last_notification_seen_id", "INTEGER DEFAULT 0")
    ensure_column(conn, "students", "last_notification_seen_id", "INTEGER DEFAULT 0")


def migration_014_attendance_records(conn):
    """Daily roll call: one row per student per date per term, marked
    'present' or 'absent' by the Form Teacher. Days Open/Present/Absent and
    the attendance percentage shown on results are derived from these rows
    (see recompute_attendance below) rather than typed in by hand, so an
    "impossible" attendance value can no longer be entered."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS attendance_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            class_id INTEGER NOT NULL,
            term_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('present','absent')),
            recorded_by INTEGER,
            recorded_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(student_id) REFERENCES students(id),
            FOREIGN KEY(class_id) REFERENCES classes(id),
            FOREIGN KEY(term_id) REFERENCES terms(id),
            FOREIGN KEY(recorded_by) REFERENCES users(id),
            UNIQUE(student_id, term_id, date)
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_attendance_class_term_date "
        "ON attendance_records(class_id, term_id, date)"
    )


def migration_015_auto_comments(conn):
    """Per-school toggles: when on, the teacher's/principal's comment on a
    terminal result is generated from the student's grade for that term
    instead of relying on a manually typed comment — useful when scores
    come in via offline CSV and nobody types a comment at all."""
    ensure_column(conn, "schools", "auto_teacher_comment", "INTEGER DEFAULT 0")
    ensure_column(conn, "schools", "auto_principal_comment", "INTEGER DEFAULT 0")


def migration_016_cumulative_results(conn):
    """Per-school 'Enable Cumulative Result' toggle. When on, an
    Annual/Cumulative Result averages each subject across every term in a
    session (1st/2nd/3rd Term) that has a score recorded. When off, terms
    keep operating completely independently, exactly as before."""
    ensure_column(conn, "schools", "cumulative_enabled", "INTEGER DEFAULT 0")


def migration_017_class_category(conn):
    """Science/Arts/Commercial as a real, structured field on a class (a
    specific arm like 'SS1 Science A') instead of something only implied by
    typing it into the free-text class name — so it can be shown reliably
    on results/broadsheets and used later to scope Learning Materials by
    category, without changing how classes are identified elsewhere."""
    ensure_column(conn, "classes", "category", "TEXT")


MIGRATIONS = [
    migration_001_baseline,
    migration_002_multi_school,
    migration_003_student_fields,
    migration_004_school_email_and_logo_settings,
    migration_005_expand_user_roles,
    migration_006_merge_admission_register,
    migration_007_terms_publish_flag,
    migration_008_more_skill_traits,
    migration_009_signature_dates,
    migration_010_enrollments,
    migration_011_student_login,
    migration_012_platform_tier,
    migration_013_notifications,
    migration_014_attendance_records,
    migration_015_auto_comments,
    migration_016_cumulative_results,
    migration_017_class_category,
]


def run_migrations(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    row = conn.execute("SELECT version FROM schema_version").fetchone()
    if row is None:
        conn.execute("INSERT INTO schema_version (version) VALUES (0)")
        version = 0
    else:
        version = row["version"]

    for i, fn in enumerate(MIGRATIONS, start=1):
        if version < i:
            fn(conn)
            conn.execute("UPDATE schema_version SET version=?", (i,))
            conn.commit()


def init_db(reset=False):
    os.makedirs(INSTANCE_DIR, exist_ok=True)
    if reset and os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    fresh = not os.path.exists(DB_PATH)
    conn = get_db()
    run_migrations(conn)

    if fresh:
        seed(conn)
    conn.close()


def seed_school_defaults(conn, school_id):
    """Sensible starting defaults for a brand-new school: grading weights,
    a standard A-F grade scale, and common skill-rating traits."""
    conn.execute(
        "INSERT INTO grading_config (school_id, ca1_max, ca2_max, exam_max) VALUES (?,20,20,60)",
        (school_id,),
    )
    scale = [
        ("A", 70, 100, "Excellent"),
        ("B", 60, 69.99, "Very Good"),
        ("C", 50, 59.99, "Good"),
        ("D", 45, 49.99, "Fair"),
        ("E", 40, 44.99, "Pass"),
        ("F", 0, 39.99, "Fail"),
    ]
    conn.executemany(
        "INSERT INTO grade_scale (school_id, grade, min_score, max_score, remark) VALUES (?,?,?,?,?)",
        [(school_id, *s) for s in scale],
    )
    psychomotor = ["Handwriting", "Sports/Games", "Handling of Tools", "Club & Societies"]
    affective = ["Punctuality", "Neatness", "Honesty", "Relationship with Others", "Leadership", "Emotional Stability"]
    for t in psychomotor:
        conn.execute("INSERT INTO skill_traits (school_id, name, category) VALUES (?,?, 'psychomotor')", (school_id, t))
    for t in affective:
        conn.execute("INSERT INTO skill_traits (school_id, name, category) VALUES (?,?, 'affective')", (school_id, t))
    conn.commit()


def seed(conn):
    cur = conn.cursor()

    cur.execute(
        "INSERT INTO schools (name, logo_filename, staff_signup_code) VALUES ('My School', NULL, NULL)"
    )
    school_id = cur.lastrowid

    cur.execute(
        "INSERT INTO users (school_id, name, username, password_hash, role) VALUES (?,?,?,?,?)",
        (school_id, "Administrator", "admin", generate_password_hash("admin123"), "admin"),
    )

    cur.execute(
        "INSERT INTO users (school_id, name, username, password_hash, role, position) VALUES (?,?,?,?,?,?)",
        (school_id, "Mrs. Ada Okafor", "aokafor", generate_password_hash("teacher123"), "teacher", "form_teacher"),
    )
    teacher_id = cur.lastrowid

    cur.execute("INSERT INTO sessions (school_id, name, is_active) VALUES (?,?,1)", (school_id, "2025/2026"))
    session_id = cur.lastrowid
    cur.execute(
        "INSERT INTO terms (name, session_id, is_active) VALUES (?,?,1)",
        ("1st Term", session_id),
    )

    conn.commit()
    seed_school_defaults(conn, school_id)

    cur.execute("INSERT INTO classes (school_id, name) VALUES (?, 'JSS1A')", (school_id,))
    class_id = cur.lastrowid
    cur.execute("UPDATE classes SET form_teacher_id=? WHERE id=?", (teacher_id, class_id))

    subjects = ["Mathematics", "English Language", "Basic Science", "Social Studies"]
    subject_ids = []
    for s in subjects:
        cur.execute("INSERT INTO subjects (school_id, name) VALUES (?,?)", (school_id, s))
        subject_ids.append(cur.lastrowid)

    for sid in subject_ids:
        cur.execute(
            "INSERT INTO class_subjects (class_id, subject_id, teacher_id) VALUES (?,?,?)",
            (class_id, sid, teacher_id),
        )

    students = [
        ("001", "Chinedu", "Obi", "M"),
        ("002", "Amaka", "Eze", "F"),
        ("003", "Tunde", "Bakare", "M"),
    ]
    for adm, fn, ln, g in students:
        cur.execute(
            "INSERT INTO students (admission_no, first_name, last_name, gender, class_id) VALUES (?,?,?,?,?)",
            (adm, fn, ln, g, class_id),
        )
        cur.execute(
            "INSERT INTO enrollments (student_id, session_id, class_id) VALUES (?,?,?)",
            (cur.lastrowid, session_id, class_id),
        )

    conn.commit()


def grade_for(score, conn, school_id):
    row = conn.execute(
        "SELECT grade, remark FROM grade_scale WHERE school_id=? AND ? BETWEEN min_score AND max_score",
        (school_id, score),
    ).fetchone()
    if row:
        return row["grade"], row["remark"]
    return "-", "-"


CLASS_CATEGORIES = ["Science", "Arts", "Commercial"]


def get_school(conn, school_id):
    return conn.execute("SELECT * FROM schools WHERE id=?", (school_id,)).fetchone()


def recompute_attendance(conn, student_id, term_id):
    """Derives Days Open / Present / Absent for a student's term from their
    attendance_records and writes them into student_term_info, preserving
    any comments/signed dates already stored there. Present + Absent can
    never exceed Days Open here, since each date holds exactly one status."""
    row = conn.execute(
        "SELECT "
        "COUNT(*) AS opened, "
        "SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) AS present, "
        "SUM(CASE WHEN status='absent' THEN 1 ELSE 0 END) AS absent "
        "FROM attendance_records WHERE student_id=? AND term_id=?",
        (student_id, term_id),
    ).fetchone()
    opened = row["opened"] or 0
    present = row["present"] or 0
    absent = row["absent"] or 0
    conn.execute(
        "INSERT INTO student_term_info (student_id, term_id, days_present, days_absent, days_school_opened) "
        "VALUES (?,?,?,?,?) "
        "ON CONFLICT(student_id, term_id) DO UPDATE SET "
        "days_present=excluded.days_present, days_absent=excluded.days_absent, "
        "days_school_opened=excluded.days_school_opened",
        (student_id, term_id, present, absent, opened),
    )


def attendance_percentage(present, opened):
    if not opened:
        return 0.0
    return round((present / opened) * 100, 1)


# Comment banks are keyed by the school's own grade-scale "remark" (e.g.
# "Excellent", "Fail") so auto-generated comments always match whatever
# grading system (Nigerian, British, or custom) the school has configured
# — the same remark text that already drives per-subject grades.
_TEACHER_COMMENT_BANK = {
    "excellent": "{name} has performed excellently this term, applying themselves consistently across all subjects. Keep up the outstanding work.",
    "very good": "{name} turned in a very good performance this term and shows real commitment to their studies.",
    "good": "{name} had a good term overall. With a little more consistency, even better results are within reach.",
    "fair": "{name}'s performance this term was fair. More effort and regular practice will help raise the results.",
    "pass": "{name} managed to pass this term but needs to put in significantly more effort going forward.",
    "fail": "{name} struggled this term and did not meet the pass mark. Extra support and closer supervision at home are strongly recommended.",
}
_PRINCIPAL_COMMENT_BANK = {
    "excellent": "An excellent result. {name} is commended for this level of performance and should be encouraged to keep it up.",
    "very good": "A very good result this term. {name} is doing well and should keep striving for the very best.",
    "good": "A good result. {name} is capable of even more with greater consistency and effort.",
    "fair": "A fair result. {name} needs to devote more time and attention to studies next term.",
    "pass": "{name} has passed, but a much greater commitment to studies is required going forward.",
    "fail": "This is a poor result. Parents/guardians are urged to give {name} closer supervision and support at home.",
}


def _bank_comment(bank, name, remark, average, subjects_written):
    if not subjects_written:
        return f"{name} has no scores recorded for this term yet."
    text = bank.get((remark or "").strip().lower())
    if text:
        return text.format(name=name)
    return f"{name} attained an average of {average:.1f}% this term."


def generate_teacher_comment(name, remark, average, subjects_written):
    return _bank_comment(_TEACHER_COMMENT_BANK, name, remark, average, subjects_written)


def generate_principal_comment(name, remark, average, subjects_written):
    return _bank_comment(_PRINCIPAL_COMMENT_BANK, name, remark, average, subjects_written)


POSITION_LABELS = {
    "principal": "Principal",
    "vice_principal": "Vice Principal",
    "exam_officer": "Exam Officer",
    "subject_teacher": "Subject Teacher",
    "form_teacher": "Form Teacher",
}

FULL_ACCESS_POSITIONS = {"principal", "vice_principal", "exam_officer"}

# Roles that can manage their school's setup (classes, subjects, teachers,
# grading, school profile, etc.) — sub_admin has all of this EXCEPT managing
# other admins/sub-admins, which is reserved for the main admin only.
SCHOOL_MANAGER_ROLES = {"admin", "sub_admin"}


def is_main_admin(role):
    return role == "admin"


def can_manage_school(role):
    return role in SCHOOL_MANAGER_ROLES


def form_teacher_class_ids(conn, user_id):
    rows = conn.execute("SELECT id FROM classes WHERE form_teacher_id=?", (user_id,)).fetchall()
    return [r["id"] for r in rows]


def can_view_all_results(role, position):
    return role in SCHOOL_MANAGER_ROLES or position in FULL_ACCESS_POSITIONS


def can_view_class_results(conn, role, position, user_id, class_id):
    if can_view_all_results(role, position):
        return True
    return class_id in form_teacher_class_ids(conn, user_id)


def notification_target_role(role):
    """Normalizes admin/sub_admin into one 'admin' targeting bucket, since
    a notification aimed at "admins" should reach both."""
    return "admin" if role in ("admin", "sub_admin") else role


def get_visible_notifications(conn, role, school_id, limit=50):
    target = notification_target_role(role)
    return conn.execute(
        "SELECT n.*, s.name as school_name FROM notifications n LEFT JOIN schools s ON s.id=n.school_id "
        "WHERE (n.school_id IS NULL OR n.school_id=?) AND (n.target_role='all' OR n.target_role=?) "
        "ORDER BY n.id DESC LIMIT ?",
        (school_id, target, limit),
    ).fetchall()


def get_unread_notification_count(conn, last_seen_id, role, school_id):
    target = notification_target_role(role)
    row = conn.execute(
        "SELECT COUNT(*) c FROM notifications WHERE id > ? AND (school_id IS NULL OR school_id=?) "
        "AND (target_role='all' OR target_role=?)",
        (last_seen_id or 0, school_id, target),
    ).fetchone()
    return row["c"]


def log_audit(conn, actor_type, actor_name, action, details=None, school_id=None):
    conn.execute(
        "INSERT INTO audit_log (actor_type, actor_name, school_id, action, details) VALUES (?,?,?,?,?)",
        (actor_type, actor_name, school_id, action, details),
    )
    conn.commit()


def upsert_enrollment(conn, student_id, class_id):
    """Record that this student is in this class for their school's
    CURRENTLY ACTIVE session — used whenever a student is added to a class
    or promoted. Past sessions' enrollment rows are never touched, so
    historical broadsheets/results stay accurate."""
    row = conn.execute(
        "SELECT s.id FROM sessions s JOIN classes c ON c.school_id=s.school_id "
        "WHERE c.id=? AND s.is_active=1 LIMIT 1", (class_id,)
    ).fetchone()
    if not row:
        return
    conn.execute(
        "INSERT INTO enrollments (student_id, session_id, class_id) VALUES (?,?,?) "
        "ON CONFLICT(student_id, session_id) DO UPDATE SET class_id=excluded.class_id",
        (student_id, row["id"], class_id),
    )


def student_full_name(student):
    parts = [student["last_name"], student["first_name"]]
    if student["other_names"]:
        parts.append(student["other_names"])
    return " ".join(p for p in parts if p)
