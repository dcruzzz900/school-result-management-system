"""
Offline sync API.

This module is intentionally kept separate from app.py's page routes: it
speaks JSON only, is used by the offline-capable JS (static/js/offline-*.js)
running in the browser/PWA shell, and is the ONE place that decides what an
offline device is allowed to read or write. Every function in here treats
the request body as untrusted and re-derives the caller's school_id/role
from either their Flask session or their verified device credential —
never from anything the client sent — which is what makes multi-school
isolation hold even if a device's local database were tampered with.

------------------------------------------------------------------------
Identity
------------------------------------------------------------------------
A caller is authenticated one of two ways:
  1. A normal online Flask session (cookie) — same as every other route.
  2. An offline device credential presented as two headers:
       X-Device-Id:     the device_id returned by /api/offline/enroll
       X-Device-Secret: the plaintext secret returned at enrollment time
     (kept encrypted at rest on the device — see offline-auth.js — and
     only held in memory after the user unlocks it with their PIN).
Either way, resolve_identity() below is the only source of truth for
{user_id, school_id, role, position}. Route handlers never read school_id
from query params or JSON bodies.

------------------------------------------------------------------------
Entity registry
------------------------------------------------------------------------
ENTITIES describes every table that can be synced, and is the single place
that would need a new entry to bring another part of the app offline (see
OFFLINE_ARCHITECTURE.md for the migration checklist). Each entry says:
  table            - the SQLite table
  fields           - columns an offline client may set directly
  school_col       - 'direct' if the table has its own school_id column,
                     or a callable(conn, row_dict) -> school_id | None that
                     resolves it via a join, used to validate a write
                     before it touches the database
  scope_ids        - callable(conn, identity) -> 'all' | set(of allowed
                     foreign-key ids) used to restrict which rows a
                     non-admin caller may read/write (e.g. a teacher's own
                     classes). Returning 'all' means no extra restriction
                     beyond school_id.
  scope_col        - the column on `table` that scope_ids restricts (e.g.
                     'class_id'), or None if scope_ids always returns 'all'
                     for every role this entity permits
  can_write        - set of roles allowed to push changes
  can_read         - set of roles allowed to pull/bootstrap this entity
  before_write     - optional callable(conn, identity, fields_dict) that
                     may mutate fields_dict (e.g. hash a password) or raise
                     SyncValidationError to reject the record
"""
import datetime
import json
import sqlite3
from functools import wraps

from flask import Blueprint, request, session, jsonify, g

from db import (
    get_db, new_client_uuid, now_iso, issue_device_credential,
    verify_device_credential, record_sync_conflict, record_sync_log,
    form_teacher_class_ids, is_main_admin, get_school, POSITION_LABELS,
)
from werkzeug.security import generate_password_hash

sync_bp = Blueprint("sync_api", __name__)

STAFF_ROLES = ("admin", "sub_admin", "teacher")
ADMIN_ROLES = ("admin", "sub_admin")


class SyncValidationError(Exception):
    pass


# ---------------------------------------------------------------------------
# Identity resolution
# ---------------------------------------------------------------------------

def resolve_identity(conn):
    """Returns a dict {user_id, school_id, role, position, device_id} or
    None. device_id is present only when authenticated via an offline
    credential (useful for logging / conflict attribution)."""
    device_id = request.headers.get("X-Device-Id")
    device_secret = request.headers.get("X-Device-Secret")
    if device_id and device_secret:
        status, cred = verify_device_credential(conn, device_id, device_secret)
        if status != "ok":
            return None
        return {
            "user_id": cred["user_id"],
            "school_id": cred["school_id"],
            "role": cred["role_snapshot"],
            "position": cred["position_snapshot"],
            "device_id": device_id,
        }
    if "user_id" in session and session.get("role") in STAFF_ROLES:
        return {
            "user_id": session["user_id"],
            "school_id": session["school_id"],
            "role": session["role"],
            "position": session.get("position"),
            "device_id": request.headers.get("X-Device-Id"),  # online but device already enrolled
        }
    return None


def require_identity(f):
    @wraps(f)
    def wrapped(*args, **kwargs):
        conn = get_db()
        identity = resolve_identity(conn)
        if identity is None:
            conn.close()
            return jsonify({"error": "not_authenticated"}), 401
        g.sync_conn = conn
        g.sync_identity = identity
        try:
            return f(*args, **kwargs)
        finally:
            conn.close()
    return wrapped


# ---------------------------------------------------------------------------
# Per-entity scoping helpers
# ---------------------------------------------------------------------------

def _teacher_class_ids(conn, identity):
    if identity["role"] in ADMIN_ROLES:
        return "all"
    return set(form_teacher_class_ids(conn, identity["user_id"]))


def _teacher_subject_class_ids(conn, identity):
    """Classes a teacher has been assigned at least one subject in (used
    for scores, which are entered per class+subject, not just by the form
    teacher)."""
    if identity["role"] in ADMIN_ROLES:
        return "all"
    rows = conn.execute(
        "SELECT DISTINCT class_id FROM class_subjects WHERE teacher_id=?", (identity["user_id"],)
    ).fetchall()
    return {r["class_id"] for r in rows}


def _admin_only_scope(conn, identity):
    return "all" if identity["role"] in ADMIN_ROLES else set()


def _all_scope(conn, identity):
    """Every staff role may read this entity in full — used for read-only
    reference data (terms, sessions, the class/subject/teacher map) that
    every offline screen needs cached locally to build its own dropdowns,
    even though nobody writes it through the sync API."""
    return "all"


def _school_via_session(conn, row):
    session_id = row.get("session_id")
    if session_id is None:
        return None
    r = conn.execute("SELECT school_id FROM sessions WHERE id=?", (session_id,)).fetchone()
    return r["school_id"] if r else None


def _school_via_class(conn, row):
    class_id = row.get("class_id")
    if class_id is None:
        return None
    r = conn.execute("SELECT school_id FROM classes WHERE id=?", (class_id,)).fetchone()
    return r["school_id"] if r else None


def _school_via_student(conn, row):
    student_id = row.get("student_id")
    if student_id is None:
        return None
    r = conn.execute(
        "SELECT c.school_id FROM students s JOIN classes c ON c.id=s.class_id WHERE s.id=?",
        (student_id,),
    ).fetchone()
    return r["school_id"] if r else None


def _restrict_principal_comment(conn, identity, fields):
    if "principal_comment" in fields and identity["role"] not in ADMIN_ROLES:
        # Client UI never shows this field to a teacher, but a hand-crafted
        # request shouldn't be able to set it either — comments are one
        # entity but the two comment fields have different authors.
        fields.pop("principal_comment")
        fields.pop("principal_signed_date", None)


def _validate_class_category(conn, identity, fields):
    from db import CLASS_CATEGORIES
    if fields.get("category") and fields["category"] not in CLASS_CATEGORIES:
        fields["category"] = None


def _hash_password_before_write(conn, identity, fields):
    if fields.get("password"):
        fields["password_hash"] = generate_password_hash(fields.pop("password"))
    else:
        fields.pop("password", None)
    # A generic offline "add teacher/staff" form must not become a way to
    # mint a new main-admin account — that account type is created only at
    # school signup. sub_admin is allowed since admins can already promote
    # someone to sub_admin online today.
    if fields.get("role") not in ("teacher", "sub_admin"):
        fields["role"] = "teacher"
    if fields.get("role") == "sub_admin" and identity["role"] != "admin":
        # Matches the online rule (SCHOOL_MANAGER_ROLES / is_main_admin in
        # db.py): only the main admin can create sub-admins, not another
        # sub-admin acting through this same generic offline path.
        fields["role"] = "teacher"
    if fields.get("position") not in POSITION_LABELS:
        fields.pop("position", None)


ENTITIES = {
    "students": {
        "table": "students",
        "fields": ["admission_no", "first_name", "last_name", "other_names", "gender",
                   "class_id", "date_of_birth", "religion", "parent_name", "parent_address",
                   "parent_email", "parent_phone", "is_active"],
        "school_col": _school_via_class,
        "scope_ids": _teacher_class_ids,
        "scope_col": "class_id",
        "can_write": set(STAFF_ROLES),
        "can_read": set(STAFF_ROLES),
    },
    "scores": {
        "table": "scores",
        "fields": ["student_id", "subject_id", "term_id", "ca1", "ca2", "exam"],
        "school_col": _school_via_student,
        "scope_ids": _teacher_subject_class_ids,
        "scope_col": None,  # validated via student's class below (needs custom check)
        "can_write": set(STAFF_ROLES),
        "can_read": set(STAFF_ROLES),
    },
    "attendance_records": {
        "table": "attendance_records",
        "fields": ["student_id", "class_id", "term_id", "date", "status", "recorded_by"],
        "school_col": _school_via_class,
        "scope_ids": _teacher_class_ids,
        "scope_col": "class_id",
        "can_write": set(STAFF_ROLES),
        "can_read": set(STAFF_ROLES),
    },
    "staff_attendance": {
        "table": "staff_attendance",
        "fields": ["user_id", "date", "status", "recorded_by"],
        "school_col": "direct",
        "scope_ids": _admin_only_scope,
        "scope_col": None,
        "can_write": set(ADMIN_ROLES),
        "can_read": set(ADMIN_ROLES),
    },
    "student_term_info": {
        "table": "student_term_info",
        "fields": ["student_id", "term_id", "days_present", "days_absent", "days_school_opened",
                   "teacher_comment", "principal_comment", "teacher_signed_date", "principal_signed_date"],
        "school_col": _school_via_student,
        "scope_ids": _teacher_class_ids,
        "scope_col": None,
        "can_write": set(STAFF_ROLES),
        "can_read": set(STAFF_ROLES),
        "before_write": _restrict_principal_comment,
    },
    "classes": {
        # Row visibility is `_all_scope` (every staff role can see every
        # class in their school — needed just to populate dropdowns);
        # `can_write` below is what actually restricts editing to admins.
        "table": "classes",
        "fields": ["name", "category", "form_teacher_id"],
        "school_col": "direct",
        "scope_ids": _all_scope,
        "scope_col": None,
        "can_write": set(ADMIN_ROLES),
        "can_read": set(STAFF_ROLES),
        "before_write": _validate_class_category,
    },
    "subjects": {
        "table": "subjects",
        "fields": ["name"],
        "school_col": "direct",
        "scope_ids": _all_scope,
        "scope_col": None,
        "can_write": set(ADMIN_ROLES),
        "can_read": set(STAFF_ROLES),
    },
    "users": {
        "table": "users",
        "fields": ["name", "username", "password", "role", "position"],
        "school_col": "direct",
        "scope_ids": _admin_only_scope,
        "scope_col": None,
        "can_write": set(ADMIN_ROLES),
        "can_read": set(ADMIN_ROLES),
        "before_write": _hash_password_before_write,
    },
    # Read-only reference data below: can_write is empty, so any push
    # attempt against these is rejected by the generic "not permitted to
    # write this entity" check in _apply_one. They exist in the registry
    # purely so bootstrap/pull can hand them to the offline UI.
    "sessions": {
        "table": "sessions",
        "fields": [],
        "school_col": "direct",
        "scope_ids": _all_scope,
        "scope_col": None,
        "can_write": set(),
        "can_read": set(STAFF_ROLES),
    },
    "terms": {
        "table": "terms",
        "fields": [],
        "school_col": _school_via_session,
        "scope_ids": _all_scope,
        "scope_col": None,
        "can_write": set(),
        "can_read": set(STAFF_ROLES),
    },
    "class_subjects": {
        "table": "class_subjects",
        "fields": [],
        "school_col": _school_via_class,
        "scope_ids": _all_scope,
        "scope_col": None,
        "can_write": set(),
        "can_read": set(STAFF_ROLES),
    },
}


def _row_school_id(conn, entity_name, row):
    cfg = ENTITIES[entity_name]
    if cfg["school_col"] == "direct":
        return row.get("school_id")
    return cfg["school_col"](conn, row)


def _in_scope(conn, entity_name, identity, row):
    """True if `identity` may write/read this row, given its foreign keys.
    Combines the generic scope_col check with the one entity-specific case
    (scores) that needs its own logic because it isn't scoped by a single
    foreign key column."""
    cfg = ENTITIES[entity_name]
    scope = cfg["scope_ids"](conn, identity)
    if scope == "all":
        return True
    if entity_name == "scores":
        student_id = row.get("student_id")
        if student_id is None:
            return False
        r = conn.execute("SELECT class_id FROM students WHERE id=?", (student_id,)).fetchone()
        return bool(r) and r["class_id"] in scope
    if entity_name == "student_term_info":
        student_id = row.get("student_id")
        if student_id is None:
            return False
        r = conn.execute("SELECT class_id FROM students WHERE id=?", (student_id,)).fetchone()
        return bool(r) and r["class_id"] in scope
    col = cfg["scope_col"]
    if col is None:
        return False
    return row.get(col) in scope


# ---------------------------------------------------------------------------
# Enrollment
# ---------------------------------------------------------------------------

@sync_bp.route("/api/offline/enroll", methods=["POST"])
def enroll():
    """Must be called from a normal ONLINE session — this is the "account
    successfully authenticated online at least once" step the offline
    login requirement refers to. Issues a per-device credential the
    browser will encrypt with the user's chosen offline PIN (see
    offline-auth.js) and use for every future offline login."""
    if "user_id" not in session or session.get("role") not in STAFF_ROLES:
        return jsonify({"error": "not_authenticated"}), 401
    conn = get_db()
    try:
        body = request.get_json(silent=True) or {}
        cred = issue_device_credential(
            conn, session["school_id"], session["user_id"],
            session["role"], session.get("position"),
            device_label=body.get("device_label"),
            device_id=body.get("device_id"),  # re-enrolling the same device keeps its id
        )
        user = conn.execute("SELECT name FROM users WHERE id=?", (session["user_id"],)).fetchone()
        return jsonify({
            "device_id": cred["device_id"],
            "device_secret": cred["secret"],
            "expires_at": cred["expires_at"],
            "user": {
                "user_id": session["user_id"],
                "name": user["name"] if user else session.get("name"),
                "role": session["role"],
                "position": session.get("position"),
                "school_id": session["school_id"],
            },
        })
    finally:
        conn.close()


@sync_bp.route("/api/offline/verify", methods=["POST"])
def verify():
    """Called opportunistically whenever the device has connectivity, to
    confirm the offline credential is still good (not revoked, not
    expired, school not suspended/archived) and to slide its expiry
    forward. A device that fails this should treat itself as logged out
    for offline purposes and require a fresh online login + re-enrollment."""
    body = request.get_json(silent=True) or {}
    device_id, secret = body.get("device_id"), body.get("device_secret")
    if not device_id or not secret:
        return jsonify({"error": "missing_credentials"}), 400
    conn = get_db()
    try:
        status, cred = verify_device_credential(conn, device_id, secret)
        if status != "ok":
            return jsonify({"status": status}), 200
        user = conn.execute("SELECT name FROM users WHERE id=?", (cred["user_id"],)).fetchone()
        return jsonify({
            "status": "ok",
            "expires_at": cred["expires_at"],
            "user": {
                "user_id": cred["user_id"],
                "name": user["name"] if user else None,
                "role": cred["role_snapshot"],
                "position": cred["position_snapshot"],
                "school_id": cred["school_id"],
            },
        })
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Bootstrap (initial full snapshot for a newly enrolled device)
# ---------------------------------------------------------------------------

@sync_bp.route("/api/sync/bootstrap", methods=["GET"])
@require_identity
def bootstrap():
    conn, identity = g.sync_conn, g.sync_identity
    out = {"generated_at": now_iso(), "entities": {}}
    for name, cfg in ENTITIES.items():
        if identity["role"] not in cfg["can_read"]:
            continue
        out["entities"][name] = _read_entity(conn, name, identity, since=None)
    record_sync_log(conn, identity["school_id"], identity.get("device_id") or "online", identity["user_id"], "pull", "bootstrap", sum(len(v) for v in out["entities"].values()))
    return jsonify(out)


def _read_entity(conn, name, identity, since):
    cfg = ENTITIES[name]
    where = ["is_deleted=0" if since is None else "1=1"]
    params = []
    if cfg["school_col"] == "direct":
        where.append("school_id=?")
        params.append(identity["school_id"])
    if since:
        where.append("updated_at > ?")
        params.append(since)
    sql = f"SELECT * FROM {cfg['table']} WHERE " + " AND ".join(where)
    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    # Joined tables (no direct school_id) and per-teacher scoping both need
    # filtering in Python since the SQL above can't express either cheaply
    # in a way that stays generic across entities.
    rows = [r for r in rows if _row_school_id(conn, name, r) == identity["school_id"]]
    rows = [r for r in rows if _in_scope(conn, name, identity, r)]
    return rows


# ---------------------------------------------------------------------------
# Pull (incremental)
# ---------------------------------------------------------------------------

@sync_bp.route("/api/sync/pull", methods=["GET"])
@require_identity
def pull():
    conn, identity = g.sync_conn, g.sync_identity
    since = request.args.get("since")
    entity_filter = request.args.get("entity")
    out = {"generated_at": now_iso(), "entities": {}}
    for name, cfg in ENTITIES.items():
        if entity_filter and name != entity_filter:
            continue
        if identity["role"] not in cfg["can_read"]:
            continue
        out["entities"][name] = _read_entity(conn, name, identity, since=since)
    return jsonify(out)


# ---------------------------------------------------------------------------
# Push (batched writes from the offline outbox)
# ---------------------------------------------------------------------------

@sync_bp.route("/api/sync/push", methods=["POST"])
@require_identity
def push():
    conn, identity = g.sync_conn, g.sync_identity
    body = request.get_json(silent=True) or {}
    changes = body.get("changes", [])
    if not isinstance(changes, list) or len(changes) > 500:
        return jsonify({"error": "invalid_or_too_large_batch"}), 400

    results = []
    synced = conflicts = errors = 0
    for change in changes:
        result = _apply_one(conn, identity, change)
        results.append(result)
        if result["status"] == "synced":
            synced += 1
        elif result["status"] == "conflict":
            conflicts += 1
        else:
            errors += 1
    conn.commit()
    record_sync_log(conn, identity["school_id"], identity.get("device_id") or "online",
                     identity["user_id"], "push", None, synced, conflicts, errors)
    return jsonify({"results": results, "synced": synced, "conflicts": conflicts, "errors": errors})


def _apply_one(conn, identity, change):
    entity = change.get("entity")
    client_uuid = change.get("client_uuid")
    op = change.get("op", "upsert")
    base_updated_at = change.get("base_updated_at")  # the updated_at this device last saw for this row, if any
    data = change.get("data") or {}

    if entity not in ENTITIES:
        return {"client_uuid": client_uuid, "status": "error", "message": f"unknown entity '{entity}'"}
    cfg = ENTITIES[entity]
    if not client_uuid:
        return {"client_uuid": client_uuid, "status": "error", "message": "missing client_uuid"}
    if identity["role"] not in cfg["can_write"]:
        return {"client_uuid": client_uuid, "status": "error", "message": "not permitted to write this entity"}

    table = cfg["table"]
    existing = conn.execute(f"SELECT * FROM {table} WHERE client_uuid=?", (client_uuid,)).fetchone()

    if op == "delete":
        if not existing:
            return {"client_uuid": client_uuid, "status": "synced", "message": "already absent"}
        if not _in_scope(conn, entity, identity, dict(existing)) or _row_school_id(conn, entity, dict(existing)) != identity["school_id"]:
            return {"client_uuid": client_uuid, "status": "error", "message": "not permitted"}
        conn.execute(f"UPDATE {table} SET is_deleted=1, updated_at=? WHERE client_uuid=?", (now_iso(), client_uuid))
        return {"client_uuid": client_uuid, "status": "synced", "server_id": existing["id"], "updated_at": now_iso()}

    # create or update
    fields = {k: v for k, v in data.items() if k in cfg["fields"]}
    if cfg["school_col"] == "direct":
        fields["school_id"] = identity["school_id"]  # never trust a client-supplied school_id

    try:
        if cfg.get("before_write"):
            cfg["before_write"](conn, identity, fields)
    except SyncValidationError as e:
        return {"client_uuid": client_uuid, "status": "error", "message": str(e)}

    probe_row = dict(existing) if existing else dict(fields)
    row_school_id = _row_school_id(conn, entity, probe_row)
    if row_school_id is not None and row_school_id != identity["school_id"]:
        return {"client_uuid": client_uuid, "status": "error", "message": "cross-school write rejected"}
    if not _in_scope(conn, entity, identity, probe_row):
        return {"client_uuid": client_uuid, "status": "error", "message": "not permitted for your class/subject assignment"}

    now = now_iso()

    if existing:
        # Conflict check: someone else changed this row on the server
        # since this device last saw it.
        if base_updated_at and existing["updated_at"] and existing["updated_at"] != base_updated_at:
            record_sync_conflict(conn, identity["school_id"], entity, client_uuid,
                                  identity.get("device_id"), fields, dict(existing))
            return {
                "client_uuid": client_uuid, "status": "conflict",
                "server_id": existing["id"], "server_data": dict(existing),
                "message": "This record changed elsewhere since you last synced it.",
            }
        set_clause = ", ".join(f"{k}=?" for k in fields)
        try:
            conn.execute(
                f"UPDATE {table} SET {set_clause}, updated_at=?, is_deleted=0 WHERE client_uuid=?",
                (*fields.values(), now, client_uuid),
            )
        except sqlite3.IntegrityError as e:
            return {"client_uuid": client_uuid, "status": "error", "message": f"constraint violation: {e}"}
        return {"client_uuid": client_uuid, "status": "synced", "server_id": existing["id"], "updated_at": now}

    fields["client_uuid"] = client_uuid
    fields["updated_at"] = now
    cols = ", ".join(fields.keys())
    placeholders = ", ".join("?" for _ in fields)
    try:
        cur = conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({placeholders})", tuple(fields.values()))
    except sqlite3.IntegrityError as e:
        # Most likely a uniqueness clash the server can see but the offline
        # device couldn't (e.g. a username or admission_no another device
        # already used while this one was offline). Surfaced as a conflict,
        # not silently dropped or silently overwritten.
        record_sync_conflict(conn, identity["school_id"], entity, client_uuid,
                              identity.get("device_id"), fields, {"error": str(e)})
        return {"client_uuid": client_uuid, "status": "conflict", "message": f"duplicate or invalid: {e}"}
    return {"client_uuid": client_uuid, "status": "synced", "server_id": cur.lastrowid, "updated_at": now}
