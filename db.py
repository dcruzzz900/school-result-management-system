import sqlite3
import os
import datetime as _dt
import secrets as _secrets
from werkzeug.security import generate_password_hash

INSTANCE_DIR = os.path.join(os.path.dirname(__file__), "instance")
DB_PATH = os.path.join(INSTANCE_DIR, "school.db")


def format_dmy(value):
    """Formats an ISO date ('YYYY-MM-DD') or a SQLite timestamp
    ('YYYY-MM-DD HH:MM:SS') as DD/MM/YYYY, with HH:MM appended for
    timestamps — the date format required throughout the system. Anything
    that isn't one of those two shapes (blank, already-formatted, or
    unexpected) is returned exactly as given rather than guessed at."""
    if not value:
        return value
    s = str(value).strip()
    date_part, _, time_part = s.partition(" ")
    try:
        d = _dt.date.fromisoformat(date_part)
    except ValueError:
        return value
    formatted = d.strftime("%d/%m/%Y")
    if time_part:
        try:
            t = _dt.datetime.strptime(time_part[:8], "%H:%M:%S").time()
            formatted += f" {t.strftime('%H:%M')}"
        except ValueError:
            pass
    return formatted


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


def migration_018_learning_materials(conn):
    """Learning Materials module: a material is uploaded (or linked, for
    things like a YouTube video) against one specific session + class +
    subject. Since a class already carries its own arm and Science/Arts/
    Commercial category, scoping by class_id automatically scopes by
    arm/category too — a student only ever sees materials for their own
    class, so Science/Arts/Commercial students naturally only see their
    own materials without any extra filtering logic."""
    conn.execute("""
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
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_materials_class_subject ON materials(class_id, subject_id)")


def migration_019_staff_attendance(conn):
    """Staff Attendance: Present/Absent/Late/Leave per staff member per
    day, recorded by an admin/sub_admin. Separate from the student roll
    call — staff aren't tied to a single class, so this is scoped to the
    whole school rather than one Form Teacher's classroom."""
    conn.execute("""
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
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_staff_attendance_school_date ON staff_attendance(school_id, date)")


def migration_020_font_customization(conn):
    """Per-school font customization: `web_font` picks the app's UI
    typeface (a curated Google Font, or the system default), and
    `pdf_font` picks which of reportlab's base font families the printed
    result sheets, broadsheets and reports use."""
    ensure_column(conn, "schools", "web_font", "TEXT DEFAULT 'system'")
    ensure_column(conn, "schools", "pdf_font", "TEXT DEFAULT 'Helvetica'")


def migration_021_school_subdomain(conn):
    """Each school can claim a unique subdomain slug (e.g. 'greenwood').
    This column, plus the app's own host-header check, is the whole of
    what the application layer can do here — actually routing traffic
    like greenwood.yourdomain.com to this app is a DNS/hosting-level
    setup outside anything a database migration can configure; see the
    Custom Subdomain section on Setup → School Profile for what's needed."""
    ensure_column(conn, "schools", "subdomain", "TEXT")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_schools_subdomain ON schools(subdomain) WHERE subdomain IS NOT NULL")


def migration_022_result_date_toggle(conn):
    """Per-school 'Show Automatic Date on Result' toggle: when on, the
    current date (in the system's DD/MM/YYYY format) is stamped on the
    printed/downloaded result. When off, no automatic date appears there
    — this is separate from the dashboard's live clock, which must never
    itself appear on a printed/downloaded result."""
    ensure_column(conn, "schools", "show_result_date", "INTEGER DEFAULT 0")


def migration_023_school_activation(conn):
    """New-school onboarding via Super Admin: a school starts 'pending'
    until its School Admin enters a time-limited, single-use 6-digit code
    (sent to the school's registered email and/or shown to the Super
    Admin) on the public activation page. Also adds an 'archived' status
    distinct from suspension, and a force-logout timestamp so the Super
    Admin can invalidate a school's active sessions without a server-side
    session store — any session whose login predates this timestamp is
    treated as stale and signed out on its next request."""
    ensure_column(conn, "schools", "registered_email", "TEXT")
    ensure_column(conn, "schools", "activation_status", "TEXT DEFAULT 'active'")
    ensure_column(conn, "schools", "activated_at", "TEXT")
    ensure_column(conn, "schools", "is_archived", "INTEGER DEFAULT 0")
    ensure_column(conn, "schools", "force_logout_at", "TEXT")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS activation_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL,
            code TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT NOT NULL,
            used_at TEXT,
            invalidated INTEGER DEFAULT 0,
            created_by TEXT,
            FOREIGN KEY(school_id) REFERENCES schools(id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_activation_codes_school ON activation_codes(school_id)")


def migration_024_offline_sync(conn):
    """Offline-first support.

    Every table a device is allowed to create/edit while offline gets three
    extra columns:
      - client_uuid: generated on the device the record was first created
        on (server-side too, for rows that already existed before this
        migration). This — not the integer id — is what offline sync uses
        to identify a record, because an offline device can't know what
        integer id a brand-new row will get until it has synced; using a
        client-generated UUID as the idempotency key means retrying a push
        (e.g. after a dropped connection mid-sync) safely upserts instead
        of creating a duplicate.
      - updated_at: last-write timestamp, used for conflict detection
        (last-write-wins with a surfaced warning — see sync_api.py).
      - is_deleted: soft-delete flag, so a deletion made on one device can
        be propagated to others on their next pull instead of the row just
        silently disappearing from a diff.

    Also adds device_credentials (one row per device a user has enrolled
    for offline access — see sync_api.py's /api/offline/enroll) and
    sync_conflicts (a durable record of any push that lost a conflict, so
    an admin can review and manually reconcile it instead of data being
    quietly dropped).
    """
    syncable_tables = [
        "students", "scores", "attendance_records", "staff_attendance",
        "student_term_info", "classes", "subjects", "users",
        # Read-only reference data an offline device needs cached locally
        # to build its own dropdowns (current term, which subjects a class
        # has, etc.) even though it never writes these tables itself.
        "sessions", "terms", "class_subjects",
    ]
    for table in syncable_tables:
        ensure_column(conn, table, "client_uuid", "TEXT")
        ensure_column(conn, table, "updated_at", "TEXT")
        ensure_column(conn, table, "is_deleted", "INTEGER DEFAULT 0")
        # Backfill: every pre-existing row needs a stable client_uuid so it
        # can be referenced by future offline pulls/pushes, and an
        # updated_at so it isn't treated as "changed right now" on every
        # device's very first pull.
        conn.execute(
            f"UPDATE {table} SET client_uuid = lower(hex(randomblob(16))) "
            f"WHERE client_uuid IS NULL"
        )
        conn.execute(
            f"UPDATE {table} SET updated_at = COALESCE(updated_at, "
            f"CASE WHEN created_at IS NOT NULL THEN created_at ELSE CURRENT_TIMESTAMP END) "
            f"WHERE updated_at IS NULL"
            if "created_at" in column_names(conn, table)
            else f"UPDATE {table} SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL"
        )
        conn.execute(
            f"CREATE UNIQUE INDEX IF NOT EXISTS idx_{table}_client_uuid "
            f"ON {table}(client_uuid) WHERE client_uuid IS NOT NULL"
        )

    conn.execute("""
        CREATE TABLE IF NOT EXISTS device_credentials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            device_id TEXT NOT NULL UNIQUE,
            device_label TEXT,
            secret_hash TEXT NOT NULL,
            role_snapshot TEXT NOT NULL,
            position_snapshot TEXT,
            issued_at TEXT DEFAULT CURRENT_TIMESTAMP,
            last_verified_at TEXT,
            expires_at TEXT NOT NULL,
            revoked INTEGER DEFAULT 0,
            revoked_reason TEXT,
            FOREIGN KEY(school_id) REFERENCES schools(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_device_credentials_user ON device_credentials(user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_device_credentials_school ON device_credentials(school_id)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS sync_conflicts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL,
            entity TEXT NOT NULL,
            client_uuid TEXT NOT NULL,
            device_id TEXT,
            client_payload TEXT NOT NULL,
            server_payload TEXT NOT NULL,
            detected_at TEXT DEFAULT CURRENT_TIMESTAMP,
            resolved INTEGER DEFAULT 0,
            resolved_at TEXT,
            resolution TEXT,
            FOREIGN KEY(school_id) REFERENCES schools(id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sync_conflicts_school ON sync_conflicts(school_id, resolved)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS sync_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL,
            device_id TEXT NOT NULL,
            user_id INTEGER,
            direction TEXT NOT NULL,   -- 'push' or 'pull'
            entity TEXT,
            record_count INTEGER DEFAULT 0,
            conflict_count INTEGER DEFAULT 0,
            error_count INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sync_log_school ON sync_log(school_id, created_at)")


def migration_025_deferred_actions(conn):
    """Support for the 'Functions Requiring Internet' part of the offline
    spec: things like emailing results to parents genuinely need a live
    connection (SMTP) and are never done purely locally, but a device can
    still QUEUE the request while offline, and it runs automatically the
    moment the device is back online and syncs — see /api/actions/queue in
    app.py and SyncEngine.queueAction/pushActions in sync-engine.js.

    This is a log of one-shot commands, not sync-able data: unlike the
    tables migration_024_offline_sync touches, there's nothing to pull
    back down to other devices and no "conflict" concept — an action
    either ran or it didn't."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS deferred_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL,
            device_id TEXT,
            user_id INTEGER,
            client_uuid TEXT UNIQUE NOT NULL,
            action_type TEXT NOT NULL,
            payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
            result_message TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            processed_at TEXT,
            FOREIGN KEY(school_id) REFERENCES schools(id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_deferred_actions_school ON deferred_actions(school_id, created_at)")


def migration_026_sync_triggers(conn):
    """migration_024_offline_sync added client_uuid/updated_at/is_deleted
    to every syncable table and backfilled existing rows — but that
    backfill only covered rows that existed AT THAT MOMENT. Every one of
    this app's existing add-student/add-class/add-teacher/enter-scores/
    take-attendance/add-comment routes was written before offline sync
    existed and simply doesn't set these columns on INSERT, and doesn't
    bump updated_at on UPDATE either. Two concrete failures that causes:

      1. A record created through the normal online UI has client_uuid
         IS NULL. Pulled to an offline device, IndexedDB rejects it (NULL
         is not a valid key for a keyPath store) — sync breaks for that
         row.
      2. A record edited through the normal online UI doesn't bump
         updated_at. The offline conflict check in sync_api.py compares
         a device's last-known updated_at to the server's current one;
         if an online edit doesn't change it, a stale offline edit would
         look "not conflicting" and silently overwrite the online one.

    Auditing and fixing every INSERT/UPDATE site across this codebase
    would be fragile (easy to miss one, easy for a future route to
    reintroduce the gap). Triggers fix it at the one place it can't be
    bypassed: the table itself, regardless of which code path writes to
    it, sync-aware or not.

    The UPDATE trigger only fires `WHEN NEW.updated_at IS OLD.updated_at`
    — i.e. only when the UPDATE statement didn't already set updated_at
    itself — so it never clobbers the value sync_api.py's push endpoint
    explicitly computes and returns to the client.
    """
    tables = [
        "students", "scores", "attendance_records", "staff_attendance",
        "student_term_info", "classes", "subjects", "users",
        "sessions", "terms", "class_subjects",
    ]
    for table in tables:
        # One more backfill sweep — covers any row inserted between
        # migration_024 and now through a not-yet-trigger-protected path
        # (e.g. seed() running after migration_024's one-time backfill).
        conn.execute(f"UPDATE {table} SET client_uuid = lower(hex(randomblob(16))) WHERE client_uuid IS NULL")
        conn.execute(f"UPDATE {table} SET updated_at = strftime('%Y-%m-%dT%H:%M:%S','now') WHERE updated_at IS NULL")

        conn.execute(f"""
            CREATE TRIGGER IF NOT EXISTS trg_{table}_sync_defaults
            AFTER INSERT ON {table}
            FOR EACH ROW
            WHEN NEW.client_uuid IS NULL OR NEW.updated_at IS NULL
            BEGIN
                UPDATE {table} SET
                    client_uuid = COALESCE(NEW.client_uuid, lower(hex(randomblob(16)))),
                    updated_at = COALESCE(NEW.updated_at, strftime('%Y-%m-%dT%H:%M:%S','now'))
                WHERE id = NEW.id;
            END
        """)
        conn.execute(f"""
            CREATE TRIGGER IF NOT EXISTS trg_{table}_sync_touch
            AFTER UPDATE ON {table}
            FOR EACH ROW
            WHEN NEW.updated_at IS OLD.updated_at
            BEGIN
                UPDATE {table} SET updated_at = strftime('%Y-%m-%dT%H:%M:%S','now') WHERE id = NEW.id;
            END
        """)


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
    migration_018_learning_materials,
    migration_019_staff_attendance,
    migration_020_font_customization,
    migration_021_school_subdomain,
    migration_022_result_date_toggle,
    migration_023_school_activation,
    migration_024_offline_sync,
    migration_025_deferred_actions,
    migration_026_sync_triggers,
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
MATERIAL_KINDS = ["Notes", "Assignment", "Study Guide", "Other"]
STAFF_ATTENDANCE_STATUSES = ["Present", "Absent", "Late", "Leave"]

PDF_FONT_CHOICES = ["Helvetica", "Times-Roman", "Courier"]

# Per-school web UI font. "system" needs no external request; the rest are
# loaded from Google Fonts by the browser, keyed by the exact family+weight
# query string fonts.googleapis.com expects.
WEB_FONTS = {
    "system": {"label": "System Default", "google": None,
               "css": "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"},
    "inter": {"label": "Inter", "google": "Inter:wght@400;600;700", "css": "'Inter', sans-serif"},
    "roboto": {"label": "Roboto", "google": "Roboto:wght@400;500;700", "css": "'Roboto', sans-serif"},
    "merriweather": {"label": "Merriweather (serif)", "google": "Merriweather:wght@400;700", "css": "'Merriweather', serif"},
    "poppins": {"label": "Poppins", "google": "Poppins:wght@400;600;700", "css": "'Poppins', sans-serif"},
}


ACTIVATION_CODE_EXPIRY_HOURS = 48


def generate_activation_code(conn, school_id, created_by=None, expiry_hours=ACTIVATION_CODE_EXPIRY_HOURS):
    """Invalidates any still-valid code for this school and issues a new
    one — regenerating always supersedes the old code, per spec, rather
    than letting two codes be valid at once."""
    conn.execute(
        "UPDATE activation_codes SET invalidated=1 WHERE school_id=? AND used_at IS NULL AND invalidated=0",
        (school_id,),
    )
    code = f"{_secrets.randbelow(1000000):06d}"
    expires_at = (_dt.datetime.utcnow() + _dt.timedelta(hours=expiry_hours)).isoformat(timespec="seconds")
    conn.execute(
        "INSERT INTO activation_codes (school_id, code, expires_at, created_by) VALUES (?,?,?,?)",
        (school_id, code, expires_at, created_by),
    )
    return code, expires_at


def current_activation_code_status(conn, school_id):
    """The most recent code issued for a school, and whether it's still
    usable — used to show 'Activation-code status' on the Super Admin
    dashboard without exposing the code itself once issued."""
    row = conn.execute(
        "SELECT * FROM activation_codes WHERE school_id=? ORDER BY id DESC LIMIT 1", (school_id,)
    ).fetchone()
    if not row:
        return "none"
    if row["used_at"]:
        return "used"
    if row["invalidated"]:
        return "invalidated"
    if row["expires_at"] < _dt.datetime.utcnow().isoformat(timespec="seconds"):
        return "expired"
    return "valid"


def verify_activation_code(conn, school_id, submitted_code):
    """Single-use, time-limited, school-specific check. Returns (ok, reason)."""
    row = conn.execute(
        "SELECT * FROM activation_codes WHERE school_id=? AND used_at IS NULL AND invalidated=0 "
        "ORDER BY id DESC LIMIT 1",
        (school_id,),
    ).fetchone()
    if not row:
        return False, "No active activation code for this school. Ask the Super Admin to issue one."
    if row["expires_at"] < _dt.datetime.utcnow().isoformat(timespec="seconds"):
        return False, "This activation code has expired. Ask the Super Admin to regenerate it."
    if submitted_code.strip() != row["code"]:
        return False, "Incorrect activation code."
    conn.execute("UPDATE activation_codes SET used_at=? WHERE id=?",
                 (_dt.datetime.utcnow().isoformat(timespec="seconds"), row["id"]))
    return True, "ok"


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
# Auto-generated comments are intentionally brief, name-free, and mapped
# by the school's own grade-scale "remark" (e.g. "Excellent", "Fail") so
# they always match whatever grading system (Nigerian, British, or
# custom) the school has configured — the same remark text that already
# drives per-subject grades. The same short comment is used for both the
# teacher's and principal's remark; there's no separate "formal" register.
_COMMENT_BANK = {
    "excellent": "Excellent performance. Keep it up.",
    "very good": "Very good performance. Keep it up.",
    "good": "Good performance. More effort is encouraged.",
    "fair": "Satisfactory performance. There is room for improvement.",
    "pass": "Needs more effort and consistent study.",
    "fail": "Significant improvement is needed.",
}


def _bank_comment(remark, average, subjects_written):
    if not subjects_written:
        return "No scores recorded yet for this term."
    text = _COMMENT_BANK.get((remark or "").strip().lower())
    if text:
        return text
    if average >= 70:
        return _COMMENT_BANK["excellent"]
    if average >= 60:
        return _COMMENT_BANK["very good"]
    if average >= 50:
        return _COMMENT_BANK["good"]
    if average >= 45:
        return _COMMENT_BANK["fair"]
    if average >= 40:
        return _COMMENT_BANK["pass"]
    return _COMMENT_BANK["fail"]


def generate_teacher_comment(remark, average, subjects_written):
    return _bank_comment(remark, average, subjects_written)


def generate_principal_comment(remark, average, subjects_written):
    return _bank_comment(remark, average, subjects_written)


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


# ---------------------------------------------------------------------------
# Offline sync helpers — used by sync_api.py. Kept here alongside the rest
# of the data-access layer rather than duplicated in the blueprint.
# ---------------------------------------------------------------------------

OFFLINE_CREDENTIAL_LIFETIME_DAYS = 21  # hard expiry if a device never reconnects
OFFLINE_SESSION_MAX_HOURS = 12         # how long a decrypted offline unlock is trusted before re-entering the PIN


def new_client_uuid():
    return _secrets.token_hex(16)


def now_iso():
    return _dt.datetime.utcnow().isoformat(timespec="seconds")


def issue_device_credential(conn, school_id, user_id, role, position, device_label=None, device_id=None):
    """Called while the user has a normal, online, authenticated session
    (see /api/offline/enroll). Generates a random secret that the device
    will use to prove itself offline; only its hash is kept server-side, so
    a stolen database dump can't be replayed as a working offline
    credential. Returns the plaintext secret ONCE — the caller must return
    it to the device immediately; it is never retrievable again (only
    re-issuable via a fresh online enrollment)."""
    device_id = device_id or _secrets.token_hex(12)
    secret = _secrets.token_urlsafe(32)
    expires_at = (_dt.datetime.utcnow() + _dt.timedelta(days=OFFLINE_CREDENTIAL_LIFETIME_DAYS)).isoformat(timespec="seconds")
    conn.execute(
        "INSERT INTO device_credentials "
        "(school_id, user_id, device_id, device_label, secret_hash, role_snapshot, position_snapshot, expires_at, last_verified_at) "
        "VALUES (?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(device_id) DO UPDATE SET secret_hash=excluded.secret_hash, "
        "role_snapshot=excluded.role_snapshot, position_snapshot=excluded.position_snapshot, "
        "expires_at=excluded.expires_at, revoked=0, revoked_reason=NULL, last_verified_at=excluded.last_verified_at",
        (school_id, user_id, device_id, device_label, generate_password_hash(secret), role, position, expires_at, now_iso()),
    )
    conn.commit()
    return {"device_id": device_id, "secret": secret, "expires_at": expires_at}


def verify_device_credential(conn, device_id, secret):
    """Checks an offline credential presented by a device trying to sync or
    re-verify itself. Returns (status, credential_row_or_none).
    status is one of: 'ok', 'not_found', 'bad_secret', 'revoked', 'expired',
    'school_suspended', 'school_archived'. On 'ok', extends the credential's
    expiry (a sliding window — a device that keeps reconnecting periodically
    never has to fully re-enroll) and records last_verified_at."""
    from werkzeug.security import check_password_hash as _check
    cred = conn.execute("SELECT * FROM device_credentials WHERE device_id=?", (device_id,)).fetchone()
    if not cred:
        return "not_found", None
    if not _check(cred["secret_hash"], secret):
        return "bad_secret", cred
    if cred["revoked"]:
        return "revoked", cred
    if cred["expires_at"] and cred["expires_at"] < now_iso():
        return "expired", cred
    school = get_school(conn, cred["school_id"])
    if school and school["is_suspended"]:
        return "school_suspended", cred
    if school and school["is_archived"]:
        return "school_archived", cred
    if school and school["activation_status"] != "active":
        return "school_suspended", cred
    new_expiry = (_dt.datetime.utcnow() + _dt.timedelta(days=OFFLINE_CREDENTIAL_LIFETIME_DAYS)).isoformat(timespec="seconds")
    conn.execute(
        "UPDATE device_credentials SET last_verified_at=?, expires_at=? WHERE id=?",
        (now_iso(), new_expiry, cred["id"]),
    )
    conn.commit()
    return "ok", cred


def revoke_device_credentials_for_user(conn, user_id, reason="revoked by admin"):
    conn.execute(
        "UPDATE device_credentials SET revoked=1, revoked_reason=? WHERE user_id=?",
        (reason, user_id),
    )
    conn.commit()


def revoke_device_credentials_for_school(conn, school_id, reason="school suspended"):
    conn.execute(
        "UPDATE device_credentials SET revoked=1, revoked_reason=? WHERE school_id=?",
        (reason, school_id),
    )
    conn.commit()


def record_sync_conflict(conn, school_id, entity, client_uuid, device_id, client_payload, server_payload):
    import json as _json
    conn.execute(
        "INSERT INTO sync_conflicts (school_id, entity, client_uuid, device_id, client_payload, server_payload) "
        "VALUES (?,?,?,?,?,?)",
        (school_id, entity, client_uuid, device_id,
         _json.dumps(client_payload, default=str), _json.dumps(server_payload, default=str)),
    )
    conn.commit()


def record_sync_log(conn, school_id, device_id, user_id, direction, entity, record_count=0, conflict_count=0, error_count=0):
    conn.execute(
        "INSERT INTO sync_log (school_id, device_id, user_id, direction, entity, record_count, conflict_count, error_count) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (school_id, device_id, user_id, direction, entity, record_count, conflict_count, error_count),
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
