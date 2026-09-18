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
- **Sync status & conflict resolution** — see pending/failed/conflicted
  counts per entity, manually resolve a conflict ("keep mine" /
  "keep server's").

Reference data needed to drive these screens (classes, subjects,
sessions, terms, the teacher↔class↔subject map) is synced read-only, so
dropdowns work fully offline too.

**Not yet built as offline screens** (server-rendered only today):
teacher/staff record management, class/subject setup, promotions,
result PDF generation/printing, broadsheets, email/payment/AI features.
The sync API's data layer already supports most of the underlying
tables (`users`, `classes`, `subjects`) — what's missing for these is
just the client-rendered screen, following the pattern below. PDF
generation and email genuinely need the server (see "Functions requiring
internet").

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
Super Admin operations are unchanged — they still require the server.
None of these are currently queued for offline deferral; the
`sync_conflicts`/outbox pattern used for data sync would need to be
extended to these (e.g. "queue a comment-sheet-ready notification email
to send once back online") if that's wanted. This is flagged as future
work, not implemented.

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

## Security notes / limitations to know about

- The offline PIN is a **local convenience credential**, not a
  replacement for full-disk encryption. It stops a stolen device from
  being logged into via the encrypted blob alone, but doesn't protect
  against someone with a debugger session on an *unlocked* browser.
- `sessionStorage` for the unlocked session means the offline session is
  gone on tab/browser close by design (re-enter PIN) — this is
  intentional, not a bug, per the "offline-session expiry" requirement.
- The push endpoint caps a batch at 500 changes; a device with a very
  large backlog will need multiple sync cycles (the engine already
  batches in groups of 50 client-side, well under that limit).
- `bootstrap`/`pull` are not paginated. For a very large school (many
  thousands of students/scores) this should be paginated before going to
  production — flagged here rather than silently left in.
- This was tested with Flask's test client against the real SQLite
  schema/migrations (enrollment → bootstrap → offline create/update →
  conflict → cross-school rejection → revocation), not manually clicked
  through in a browser. Browser/PWA-level testing (actual airplane mode,
  actual service worker install lifecycle, IndexedDB quota behavior)
  hasn't been done and should be your next step before shipping.
