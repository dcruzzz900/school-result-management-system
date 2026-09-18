# Offline-First Architecture

This document describes what was built, how it works, what its security
model relies on, and — importantly — **what is not done yet** and how to
extend it. Read this before treating the feature as "finished."

## Honest scope statement

The requirements describe full offline parity across the entire
application (every school function, from student registration to
comments to result printing). This codebase is a ~4,500-line
server-rendered Flask app (Jinja templates, no client-side framework).
Turning *every* one of its ~40 templates into a client-rendered,
IndexedDB-backed view is a large, multi-week undertaking on its own —
each screen has its own business logic (grade computation, promotion
rules, PDF generation, etc.) that would need to be either duplicated in
JavaScript or restructured.

What's implemented here is a **complete, working, production-quality
foundation** — the hard, easy-to-get-wrong parts (encrypted offline
login, tenant-isolated local storage, a generic conflict-aware sync
engine, server-side authorization that can't be bypassed by a
compromised client) — plus **three fully working offline workflows**
(attendance/roll call, score entry, student registration) built on top
of it, end to end, tested. Extending it to more screens is now a
mechanical, well-documented process (see "Adding another offline
screen" below), not an architectural one.

## Architecture

```
Online Server (Flask/SQLite)
        ↕  /api/offline/*  and  /api/sync/*   (sync_api.py)
Synchronization Engine (static/js/sync-engine.js)
        ↕
Secure Local Database (IndexedDB, static/js/offline-db.js)
        ↕
School App (templates/offline_app.html + static/js/offline-app-ui.js)
```

### 1. Offline login

- **Enrollment** (must happen once, online, logged in normally):
  Settings → Offline Access → choose a PIN. This calls
  `POST /api/offline/enroll`, which issues a random per-device secret
  (only its salted hash is stored server-side, in `device_credentials`).
  The browser encrypts `{device_id, device_secret, user info}` with a
  key derived from the PIN via PBKDF2 (150k iterations) and stores the
  ciphertext in IndexedDB (`offline-crypto.js`, `offline-db.js`). The
  plaintext secret is never written to disk. Enrollment also immediately
  downloads a full data snapshot (`bootstrap`), so the device is usable
  offline right away — it doesn't need a second lucky online moment.
- **Offline login**: the device shows an account picker (from IndexedDB,
  encrypted, no decryption needed yet) and a PIN pad
  (`offline-app-ui.js`). AES-GCM's authentication tag means a wrong PIN
  fails loudly (decryption throws) rather than silently returning
  garbage. A correct PIN unlocks an in-memory + `sessionStorage` session.
- **Session expiry / security controls** (`offline-auth.js`):
  - *Short* — the unlocked session expires after `MAX_SESSION_HOURS`
    (12h) **or** whenever the browser/tab fully closes (`sessionStorage`
    doesn't survive that), so a lost unlocked laptop doesn't stay usable
    indefinitely.
  - *Long* — the credential itself hard-expires after
    `OFFLINE_CREDENTIAL_LIFETIME_DAYS` (21 days, `db.py`) with no
    successful online re-verification. Every time the device is online
    and calls `/api/offline/verify`, this expiry slides forward.
- **Revocation / account-status check on reconnect**: `verifyOnline()`
  calls `/api/offline/verify`, which checks the credential isn't
  revoked/expired and the school isn't suspended/archived (reusing the
  same `is_suspended`/`activation_status` checks the online login
  path uses). Deleting a teacher (`delete_teacher`) or suspending a
  school (`platform_suspend_school`) now also revokes every device
  credential tied to that account/school immediately.

### 2. Offline functions

Implemented end-to-end, working with zero connectivity, from a device
that has enrolled at least once:

- **Attendance / roll call** — pick class + date, mark present/absent,
  saves locally and syncs later.
- **Score entry** — pick class + subject (scoped to what that teacher
  actually teaches), enter CA1/CA2/Exam per student.
- **Teacher / principal comments** — pick a class, write each student's
  comment(s); a teacher only sees/can set the teacher's comment field
  (the principal's comment field is hidden client-side AND stripped
  server-side if a non-admin tries to set it anyway — see
  `_restrict_principal_comment` in `sync_api.py`).
- **Student registration** — add a new student while offline.
- **Class management, subject management, teacher/staff management**
  (admin/sub_admin only) — add new classes, subjects, and staff accounts
  offline. Passwords are hashed server-side on sync and never stored
  in plaintext locally once synced (see below); role escalation is
  blocked server-side (an offline "add teacher" can't mint an admin or,
  unless the caller is the main admin, another sub-admin — see
  `_hash_password_before_write` in `sync_api.py`).
- **Sync status & conflict resolution** — see pending/failed/conflicted
  counts per entity, manually resolve a conflict ("keep mine" /
  "keep server's").

Reference data needed to drive these screens (classes, subjects,
sessions, terms, the teacher↔class↔subject map) is synced read-only, so
dropdowns work fully offline too.

**Not yet built as offline screens** (server-rendered only today):
promotions, result PDF generation/printing, broadsheets, email/payment/AI
features. PDF generation and email genuinely need the server (see
"Functions requiring internet").

#### Dependency-safe offline creation ("Full offline data entry")

A record created offline that references another record ALSO created
offline — the textbook case being a brand-new class with a brand-new
student registered into it, in the same offline session, before either
has ever touched the server — can't use a real database id for that
foreign key, because the parent doesn't have one yet.

This is handled, not worked around:

- Every offline-created record is keyed by a client-generated
  `client_uuid` from the moment it's created — that's true regardless of
  whether its parent has synced.
- When a child record is saved offline and its parent hasn't synced yet,
  `SyncEngine.queueChange()` records the dependency as a
  `_pending_refs` entry (e.g. `{ class_id: "classes:<parent uuid>" }`)
  instead of a numeric foreign key.
- `SyncEngine` pushes entities in dependency tiers
  (`classes`/`subjects`/`users` → `students` → `scores`/
  `attendance_records`/`student_term_info`). After each tier's batch
  comes back from the server with real ids, a resolution pass runs
  before the next tier is pushed — so a class and the student registered
  into it in the same offline session sync together, in one pass, with
  the student's `class_id` correctly filled in.
- If a parent's push fails or conflicts, its children are **never**
  pushed with a missing or guessed foreign key — they stay blocked
  (visibly, in the Sync Status screen, with "waiting on classes to sync
  first") until the parent succeeds.
- This was verified with a dedicated Node test harness that mocks
  IndexedDB/fetch and exercises `sync-engine.js` directly (not just the
  server side): both the happy path (class + student sync together,
  student's `class_id` resolves to the class's real server id) and the
  failure path (class push rejected → student stays blocked with its
  `_pending_refs` intact, never sent with a broken FK) pass.
- Building this test also surfaced a real concurrency bug — `queueChange`
  fires an opportunistic sync after every write, which could race a
  later explicit `syncNow()` call and cause double-processing.
  `SyncEngine.syncNow()` now serializes concurrent calls onto a single
  in-flight promise.
- A locally created but not-yet-synced parent still shows up in every
  dropdown that lists it (e.g. the class picker in Student Registration),
  labeled "(not yet synced)", via the `refKey`/`refOptions`/
  `applyRefSelection` helpers in `offline-app-ui.js` — so a school
  admin can genuinely set up a class and register students into it
  before ever going online.

### 3. Automatic synchronization (`static/js/sync-engine.js`)

- Every offline-created/edited record gets a client-generated UUID
  (`client_uuid`) at creation time. This is the idempotency key for the
  entire sync round-trip: retrying a push after a dropped connection
  re-upserts the same row instead of creating a duplicate. Verified by
  test: pushing the same `client_uuid` twice produces exactly one row.
- **Push**: batches pending/failed local records to `POST
  /api/sync/push`. Each record carries `base_updated_at` — the
  `updated_at` value this device last saw for that row. If the server's
  current value has moved on since then, the push is rejected as a
  **conflict**, not silently overwritten in either direction; both
  versions are kept (locally, and in the server's `sync_conflicts`
  table) for the user (or an admin) to resolve. Verified by test.
- **Pull**: `GET /api/sync/pull?since=<timestamp>` returns everything
  changed since the last sync, scoped to the caller's school and role.
- **Retry**: failed pushes back off exponentially per record
  (`5s × 2^attempts`, capped at 5 minutes) so one broken record doesn't
  get hammered every cycle, but is still retried automatically. Auto-sync
  runs on the `online` event and every 60s while online.
- **Status display**: a nav badge (`base.html`) and a dedicated screen
  (`offline-app-ui.js`'s Sync Status view) show pending/conflict/failed
  counts, driven by a `offline-sync-status` DOM event. Unresolved
  conflicts are also visible to admins school-wide (not just on the
  device that caused them) at **Settings → Review Sync Conflicts**
  (`/admin/sync-conflicts`), where an admin can apply the offline
  device's version or keep the server's.

### 4. Multi-school data isolation

- **Client-side**: each school gets its **own IndexedDB database**
  (`srs_offline_school_<id>`), not just a filtered view of a shared one.
  Two different schools' staff using the same physical device end up
  with two databases that no query can accidentally join across.
- **Server-side**: `sync_api.py`'s `resolve_identity()` derives
  `school_id` *only* from the authenticated session or verified device
  credential — **never** from anything the client sends. Every write
  path re-validates that the record's own foreign keys (e.g. a score's
  `student_id`) resolve to a class in that same school before touching
  the database. Verified by test: a device credential from School B
  attempting to write into School A's class is rejected with
  `cross-school write rejected`.
- Per-role scoping on top of that: a teacher's reads/writes are further
  restricted to the classes they're the form teacher of (attendance,
  student records) or teach a subject in (scores) — see the
  `ENTITIES` registry in `sync_api.py`.

### 5. Functions requiring internet

Email delivery, PDF generation for printing/download, payments, and
Super Admin operations still require the server — that part is
unchanged. What's new: **email delivery is now queueable while offline**,
as a proof of the "queued where possible and automatically processed
when the connection returns" requirement.

- A device queues the *request* (not the data) locally — e.g. "email
  Class 3B's results to parents" — via `SyncEngine.queueAction()`
  (Offline App → Queue Internet-Only Actions). There's no local approximation
  of sending an email; the request just waits.
- The next successful sync calls `POST /api/actions/queue`
  (`app.py`), which — since that call only ever happens while online —
  performs the action for real: it reuses the exact same
  `send_class_results_emails()` helper the normal online "Email Results"
  button calls, so the two paths can't drift apart.
- Every attempt is logged in `deferred_actions` (school, device, action
  type, payload, status, result message), including failures — so
  there's an audit trail of what got queued and what happened to it.
- Idempotent by `client_uuid`, same as data sync: replaying a queued
  action (e.g. because the response to a previous attempt was lost)
  returns the already-recorded result instead of sending the emails
  twice — verified by test.
- Authorization is re-checked server-side against the resolved identity
  (same `can_view_class_results` check the online route uses), not
  trusted from the queued payload — verified by test that a teacher
  without access to a class is rejected even though the request reached
  the endpoint.
- Only one action type (`email_class_results`) is wired up. Extending
  this to other internet-only functions (payments, AI features, cloud
  backups) means adding a new entry to `DEFERRED_ACTION_TYPES` and a
  branch in `_process_deferred_action()` in `app.py` — the queueing,
  retry, idempotency, and audit-log machinery is already generic.

## Adding another offline screen

1. **Server**: if the table isn't already in `ENTITIES` in `sync_api.py`,
   add an entry (fields whitelist, school-scoping function, role
   permissions). If it needs `client_uuid`/`updated_at`/`is_deleted`
   columns, add it to the `syncable_tables` list in
   `migration_024_offline_sync` (`db.py`) — write a new migration
   function rather than editing that one once it's shipped.
2. **Client**: add the entity name to `ENTITY_STORES` in
   `offline-db.js` (bumps nothing — IndexedDB stores are created
   lazily on next DB open per school; existing users get it
   automatically since the version number only needs to change if you
   alter *existing* stores, not add ones nobody has opened yet — to be
   safe, bump `SCHOOL_DB_VERSION` when adding a store).
3. Build the screen in `offline-app-ui.js` (or split into its own file)
   using `OfflineDB.getAll()` for reads and `SyncEngine.queueChange()`
   for writes — follow the pattern in `renderAttendance`/
   `renderScoreEntry`.
4. Nothing else needs to change — push/pull/conflict handling is fully
   generic.

### 6. Pagination (bootstrap / pull at scale)

`bootstrap`/`pull` are cursor-paginated (`sync_api.py`'s `PAGE_SIZE`,
500 rows/entity/page by default, capped at `MAX_PAGE_SIZE`=2000). Scoping
(tenant isolation + per-role visibility) is expressed directly in SQL via
joins (`_scoped_sql`) rather than fetched-then-filtered in Python — this
is what makes LIMIT/OFFSET pagination actually correct: filtering after
the fact would make "page 3" mean a different, shifting set of rows
depending on how many got excluded by the scope check on earlier pages.
`SyncEngine.bootstrap()`/`pullDeltas()` on the client loop on the
returned `cursor` until every entity is exhausted. Verified by test: 28
students paginated at page size 10 (3 pages) are collected exactly once,
with no gaps or duplicates.

**A genuinely important bug this surfaced and fixed**: this app's
*existing* online routes (add student, add class, enter scores, take
attendance, add comments — all written before offline sync existed)
never set `client_uuid`/`updated_at` on insert, and never bumped
`updated_at` on update. Two real consequences: (1) a record created
through the normal UI would have `client_uuid IS NULL`, which is not a
valid IndexedDB key — bootstrap would break trying to store it; (2) an
online edit that didn't bump `updated_at` would look "unchanged" to the
conflict check, so a stale offline edit could silently overwrite it
without being flagged as a conflict. Auditing every INSERT/UPDATE site
across a 4,500-line app to fix this by hand would be fragile — easy to
miss one, easy for a future route to reintroduce the gap. Fixed instead
with SQLite triggers (`migration_026_sync_triggers` in `db.py`) on every
syncable table: an `AFTER INSERT` trigger fills in `client_uuid`/
`updated_at` if the inserting statement left them NULL, and an
`AFTER UPDATE` trigger bumps `updated_at` — but only
`WHEN NEW.updated_at IS OLD.updated_at`, i.e. only when the UPDATE
statement didn't already set it itself, so it never clobbers the exact
value `sync_api.py`'s push endpoint computes and returns to the client.
This protects every code path, present and future, sync-aware or not —
verified by test (a bare INSERT/UPDATE with no offline-sync awareness at
all, exactly mimicking what the existing routes do, correctly gets
`client_uuid` filled in and `updated_at` bumped either way).

## Security notes / limitations to know about

- The offline PIN is a **local convenience credential**, not a
  replacement for full-disk encryption. It stops a stolen device from
  being logged into via the encrypted blob alone, but doesn't protect
  against someone with a debugger session on an *unlocked* browser.
- A new teacher/staff password entered offline (Manage Teachers / Staff)
  sits in the local IndexedDB record in plaintext until it syncs — it's
  hashed server-side (`_hash_password_before_write`), and the plaintext
  is deleted from the local record the moment sync succeeds
  (`pushBatch` in `sync-engine.js`). Until then, it's protected only by
  the same PIN-encrypted-at-rest boundary as everything else on the
  device — flagged here explicitly since it's a materially different
  sensitivity level than a score or an attendance mark.
- `sessionStorage` for the unlocked session means the offline session is
  gone on tab/browser close by design (re-enter PIN) — this is
  intentional, not a bug, per the "offline-session expiry" requirement.
- The push endpoint caps a batch at 500 changes; a device with a very
  large backlog will need multiple sync cycles (the engine already
  batches in groups of 50 client-side, well under that limit).
- `bootstrap`/`pull` are cursor-paginated (see "Pagination" above) —
  this was the one item flagged as a known gap in an earlier pass, and
  is now fixed and tested.
- This was tested with Flask's test client against the real SQLite
  schema/migrations (enrollment → bootstrap → offline create/update →
  conflict → cross-school rejection → revocation), not manually clicked
  through in a browser. Browser/PWA-level testing (actual airplane mode,
  actual service worker install lifecycle, IndexedDB quota behavior)
  hasn't been done and should be your next step before shipping.
