# Full Offline-First Sync — Scoping Document

**Status:** Not started. This is a planning document, not an implementation.
**Relationship to what's already shipped:** The app currently has a "lite" offline
queue (`static/js/offline-queue.js`, the Offline Queue page) that saves a form's
raw fields to `localStorage` when the browser is offline and replays them when it
comes back. That mechanism is simple, transparent, and already working — this
document does not replace it, it describes what a genuinely robust offline-first
system would require instead, so the trade-off between the two is explicit rather
than discovered later.

---

## 1. Why this is a different project, not an extension

The lite queue works because it never has to answer three hard questions. A full
system has to answer all three, for every offline-capable action:

1. **What happens if the same record changed on the server while a device was
   offline?** (conflict detection + resolution)
2. **What does a user see about a record's state while it's in limbo** — created
   offline, not yet synced, partially synced, rejected by the server? (sync
   status as first-class data, not a browser-only concern)
3. **What stops School A's offline queue from ever being replayable against
   School B's data**, given the device itself, not just the server session, is
   now part of the trust boundary? (offline-aware tenant isolation)

The lite queue sidesteps all three by only ever replaying a raw, unmodified copy
of what was typed, as one atomic POST, using a freshly-fetched live session and
CSRF token. That's exactly why it's simple — and exactly why it can't survive a
conflicting edit, a multi-day outage, or a lost/shared device without falling
back to "whatever happens, happens."

## 2. Architecture components required

### 2.1 Client: local data store
- Replace `localStorage` (fine for a small append-only queue of raw form
  payloads) with **IndexedDB**, which can hold structured, queryable records:
  the actual entities being created/edited (students, scores, attendance,
  classes, subjects, teachers, comments), not just "a form was submitted."
- Each locally-created or locally-edited record needs:
  - `client_uuid` — generated on-device at creation time, so a record can be
    identified before the server has ever assigned it a real ID
  - `server_id` — null until the first successful sync assigns one
  - `school_id`, `user_id` — captured at creation time and **never trusted
    from re-derivation at sync time alone** (see §4 on isolation)
  - `updated_at` (client clock) and a `base_version` (the server's version of
    the record this edit was made against, for conflict detection — see §3)
  - `sync_status`: `local_only` → `syncing` → `synced` | `conflict` | `rejected`

### 2.2 Client: sync engine (replaces the simple "replay a POST" model)
- A background process (Service Worker + the [Background Sync
  API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API),
  where supported — Safari/iOS does not support it, which matters a lot for a
  school app; see §6) that:
  1. Detects connectivity return (the `online` event is a hint, not proof —
     needs an actual authenticated ping to the server, e.g. `GET
     /csrf-token`, before treating the connection as real)
  2. Pushes locally-created/edited records in dependency order (e.g. a
     locally-created class must sync before a locally-created student that
     references it by `client_uuid`)
  3. Pulls server-side changes since the device's last sync checkpoint, so a
     device that was offline for a day doesn't overwrite changes made by
     someone else at the school in the meantime
  4. Surfaces conflicts (see §3) as data the UI can render, not console
     errors
- A Service Worker also changes how pages are served (cache-first for the app
  shell) — this is a real change to how the app boots, not just an add-on.

### 2.3 Server: sync API
The existing routes (`/scores/<class_id>/<subject_id>`, `/admin/students`,
etc.) are designed for one browser tab submitting one form to one page and
getting a redirect back. A sync engine needs a different contract:

- `POST /sync/push` — accepts a **batch** of client-side changes in one
  request (one record at a time doesn't scale to "a day's worth of offline
  entry"), each tagged with `client_uuid`, entity type, `base_version`, and
  the field changes. Returns, per record: accepted (+ new `server_id` if
  created), conflicted (+ the current server version), or rejected (+ reason
  — e.g. permission denied, validation failure).
- `GET /sync/pull?since=<checkpoint>` — returns everything that changed at
  the school (scoped to what this user is allowed to see) since the device's
  last successful pull, for the entity types this device might hold.
- Both endpoints need idempotency: a batch sent twice (e.g. because the
  device's connection dropped after the server processed it but before the
  response arrived) must not create duplicate students/scores. Standard
  approach: the server records `(client_uuid, base_version)` it has already
  applied and no-ops a repeat.

### 2.4 Server: schema changes
Every entity that should be offline-editable needs, at minimum:
- `client_uuid` (nullable — only set for records created offline) with a
  unique index
- `version` (integer, incremented on every update) or `updated_at` with
  sufficient precision — needed for §3's conflict check
- A `sync_log` table: `id, school_id, user_id, device_id, entity_type,
  entity_id, client_uuid, action (create/update), synced_at, was_conflict`
  — this is also what "users should be able to see the synchronization
  status" (from the original spec) actually renders from; it's server-side
  audit data, not just a browser-local list.

## 3. Conflict resolution — the part with no purely technical answer

This needs a product decision, not just an engineering one, before any of this
gets built. Candidate strategies, roughly in order of how much they cost to
build:

| Strategy | What it means | Cost | Risk |
|---|---|---|---|
| **Last-write-wins** | Whoever syncs last overwrites the record entirely | Low | A teacher's offline-entered scores can silently vanish if an admin edited the same student online in the meantime |
| **Field-level merge** | Only the fields actually changed offline are applied, server fields not touched offline are left alone | Medium | Ambiguous when both sides changed the *same* field (still needs a tiebreak rule) |
| **Manual conflict review** | Conflicting changes are queued for a human (the School Admin) to pick a winner or merge by hand | High | Needs a real UI, and someone has to actually do the reviewing promptly or the queue backs up |

**Recommendation if/when this is built:** field-level merge as the default,
falling back to manual review only for the fields that were touched on both
sides — pure last-write-wins is very likely to silently lose real academic
data (a score, a day's attendance), which is a worse failure mode than asking
a human to resolve a rare same-field collision.

## 4. Tenant isolation, offline-specific risks

The existing app enforces school isolation at the database and session layer,
already tested extensively against IDOR-style attacks in this codebase. A
sync layer adds two *new* places isolation can leak that don't exist in a
purely online app:

1. **A shared or multi-account device.** If a device is used by admins from
   two different schools (unlikely but not impossible — e.g. a shared
   office computer, or a consultant working with several schools), the local
   IndexedDB store must be partitioned per logged-in `school_id`, not just
   per browser profile. Getting this wrong means School A's queued offline
   data could physically sit in the same on-device store as School B's,
   even if the server would still refuse to accept it cross-tenant.
2. **A stale or forged `school_id` in a replayed batch.** The sync engine
   must never trust the `school_id` embedded in an offline-created record —
   the server must re-derive and re-check it from the authenticated
   session at sync time, exactly like every other route in this app already
   does. This is the same principle already enforced everywhere else in the
   codebase; a sync endpoint is not a special case, but it's an easy place to
   accidentally special-case if the sync code is written as new,
   separate code path rather than reusing the same permission-check helpers
   as the live routes.

## 5. Phased plan, if this goes ahead

Building all of this as one project is the riskiest way to do it — a phased
rollout means the app is never in a half-working state for reasons users
notice.

**Phase 1 — read-only offline + queued writes for the two highest-value forms**
(Attendance, Score Entry). No conflict resolution yet (last-write-wins,
clearly labeled as a known limitation) — this alone gets a Form Teacher
through a day with no signal without losing data, which is most of the
real-world value.

**Phase 2 — add the school-setup forms** (Add Student, Add Class, Add
Subject, Add Teacher, Assign Subjects) with `client_uuid`-based dependency
resolution, since these can reference each other (a student references a
class that might itself have been created offline).

**Phase 3 — conflict detection + field-level merge**, plus the sync-status UI
backed by the server-side `sync_log`, not just the on-device queue view.

**Phase 4 — Service Worker background sync** where the platform supports it,
with the existing "sync on page load / manual sync button" as the fallback
everywhere else (notably iOS Safari).

Each phase is independently shippable and independently valuable — this
isn't a "nothing works until phase 4" plan.

## 6. Known hard limits, even at full scope

- **iOS Safari does not support the Background Sync API.** On iPhone/iPad,
  "sync automatically when back online" would in practice mean "sync the
  next time the app is opened," not truly in the background. Any offline
  claim made to schools needs to say this plainly, since a lot of staff
  device usage in this context is likely to be phones.
- **IndexedDB storage is not unlimited** and can be cleared by the browser
  under storage pressure (especially on mobile) if the site hasn't been
  granted persistent storage. A multi-week offline period is not a scenario
  this design safely covers without also handling storage-eviction
  recovery, which is its own scoped problem.
- **This does not become multi-device sync in the peer-to-peer sense.** Two
  offline devices at the same school cannot sync with each other directly —
  both only ever sync through the server, so if both are offline
  simultaneously, neither sees the other's changes until both separately
  reconnect.

## 7. Open questions to resolve before any implementation work starts

1. Which conflict strategy (§3) — and specifically, who is the "human in the
   loop" for manual review: the School Admin, or does it escalate to Super
   Admin?
2. How long should a device be allowed to stay offline before its queued
   data is considered stale enough to warn about (e.g. a score entered
   against a term that's since been published/locked)?
3. Is there a real-world scenario driving this (e.g. specific schools with
   known unreliable connectivity), which would help prioritize Phase 1's two
   forms correctly, or should it default to the highest-frequency actions
   (scores, attendance)?
4. Should offline-created accounts (a teacher added offline) require the
   same re-confirmation step as the Activation Code flow before being
   treated as fully provisioned, given the plaintext-password-at-rest
   concern already flagged for the lite tier equally applies here?

## 8. Rough effort shape

Not a committed estimate — offered so "full tier" isn't a black box:

- Phase 1: comparable in size to one of the larger features already built
  this session (e.g. Learning Materials or the Activation Code system), but
  with meaningfully higher testing burden, since data-loss bugs here are
  silent by nature.
- Phases 2–4: each roughly comparable to or larger than Phase 1, with Phase 3
  (conflict resolution) being the highest-risk, highest-judgment-call phase.
- None of this is a single-session build — Phase 1 alone is a multi-session
  project if held to the same testing standard as the rest of this codebase.
