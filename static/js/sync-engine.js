/*
 * Generic sync engine, driving the offline entity stores in offline-db.js
 * against the /api/sync/* endpoints in sync_api.py.
 *
 * Design notes:
 *   - A record's client_uuid is the idempotency key for the whole trip.
 *     It's generated on-device at creation time, so retrying a push after
 *     a dropped connection safely re-upserts the same row instead of
 *     creating a duplicate (requirement: "prevent duplicate records").
 *   - Conflict handling is last-write-wins with a surfaced warning, not a
 *     silent overwrite in either direction: a push includes the
 *     `updated_at` this device last saw for the row (`base_updated_at`);
 *     if the server's current value has moved on since then, the push is
 *     rejected as a conflict and BOTH versions are kept (locally, and in
 *     the server's sync_conflicts table) for a human to resolve, rather
 *     than one silently clobbering the other.
 *   - Failed pushes back off exponentially per record so a single broken
 *     row (e.g. a genuine validation problem) doesn't get hammered every
 *     sync cycle; they're still retried automatically, just less often.
 */
const SyncEngine = (function () {
    const BATCH_SIZE = 50;
    const MAX_BACKOFF_MS = 5 * 60 * 1000;

    function backoffOk(entry) {
        const meta = entry._sync || {};
        if (!meta.attempts) return true;
        const last = meta.last_attempt_at ? new Date(meta.last_attempt_at).getTime() : 0;
        const wait = Math.min(MAX_BACKOFF_MS, 5000 * Math.pow(2, meta.attempts));
        return Date.now() - last > wait;
    }

    function authHeaders(deviceId, deviceSecret) {
        const h = { "Content-Type": "application/json" };
        if (deviceId && deviceSecret) {
            h["X-Device-Id"] = deviceId;
            h["X-Device-Secret"] = deviceSecret;
        }
        return h;
    }

    function stripMeta(record) {
        const { _sync, ...rest } = record;
        return rest;
    }

    // Pulls a full snapshot and seeds the local school database. Called
    // right after enrollment (see offline-auth.js) so the device is
    // usable offline immediately, without waiting for a second visit.
    async function bootstrap(schoolId, deviceId, deviceSecret) {
        const res = await fetch("/api/sync/bootstrap", { headers: authHeaders(deviceId, deviceSecret) });
        if (!res.ok) throw new Error("Could not download offline data for this device.");
        const data = await res.json();
        for (const [entity, rows] of Object.entries(data.entities)) {
            const tagged = rows.map((r) => ({ ...r, _sync: { status: "synced", attempts: 0 } }));
            await OfflineDB.putRecords(schoolId, entity, tagged);
        }
        await OfflineDB.setMeta(schoolId, "last_sync_at", data.generated_at);
        broadcastStatus(schoolId);
        return data;
    }

    // A record created offline that references another record ALSO
    // created offline (e.g. a brand-new student in a brand-new,
    // not-yet-synced class) can't use a real numeric foreign key yet —
    // the parent doesn't have a server id until it syncs. `pendingRefs`
    // is an optional {field_name: parent_client_uuid} map for exactly
    // that case; the field itself is left unset until pushPending()'s
    // resolution pass fills it in with the parent's real id, once the
    // parent has synced. See "Dependency-safe offline creation" in
    // OFFLINE_ARCHITECTURE.md.
    async function queueChange(schoolId, entity, op, data, clientUuid, pendingRefs) {
        let record;
        if (op === "create") {
            clientUuid = clientUuid || crypto.randomUUID();
            record = {
                ...data, client_uuid: clientUuid, is_deleted: 0,
                updated_at: new Date().toISOString(),
                _sync: { status: "pending", op: "upsert", base_updated_at: null, attempts: 0 },
            };
        } else {
            const existing = await OfflineDB.getRecord(schoolId, entity, clientUuid);
            if (!existing) throw new Error("Record not found locally.");
            // If this row already has an unsynced edit queued, keep the
            // ORIGINAL base_updated_at (the last value the server
            // confirmed) rather than overwriting it with the intermediate
            // local edit — otherwise a conflict on the server side could
            // go undetected.
            const baseUpdatedAt = existing._sync && existing._sync.status === "pending"
                ? existing._sync.base_updated_at
                : existing.updated_at;
            record = {
                ...existing, ...data, client_uuid: clientUuid,
                is_deleted: op === "delete" ? 1 : 0,
                updated_at: new Date().toISOString(),
                _sync: { status: "pending", op: op === "delete" ? "delete" : "upsert", base_updated_at: baseUpdatedAt, attempts: 0 },
            };
        }
        if (pendingRefs && Object.keys(pendingRefs).length) {
            record._pending_refs = pendingRefs;
        } else {
            delete record._pending_refs;
        }
        await OfflineDB.putRecord(schoolId, entity, record);
        broadcastStatus(schoolId);
        if (navigator.onLine) syncNow(schoolId, deviceIdFor(schoolId), deviceSecretFor(schoolId)).catch(() => {});
        return record;
    }

    // These two helpers exist so pages that already have an OfflineAuth
    // session don't have to thread device_id/device_secret through every
    // call site manually.
    function deviceIdFor() { const s = OfflineAuth.getSession(); return s ? s.device_id : null; }
    function deviceSecretFor() { const s = OfflineAuth.getSession(); return s ? s.device_secret : null; }

    async function readLocal(schoolId, entity) {
        return OfflineDB.getAll(schoolId, entity);
    }

    // queueChange() fires an opportunistic sync after every single local
    // write, and the 60s auto-sync timer + the 'online' event can all
    // land at once too. This flag makes concurrent callers await the
    // SAME in-flight sync instead of two syncs stepping on each other.
    let syncInFlight = null;
    async function syncNow(schoolId, deviceId, deviceSecret) {
        if (!navigator.onLine || !schoolId) return { skipped: true };
        if (syncInFlight) return syncInFlight;
        syncInFlight = (async () => {
            const headers = authHeaders(deviceId, deviceSecret);
            const pushResult = await pushPending(schoolId, headers);
            const actionResult = await pushActions(schoolId, headers);
            const pullResult = await pullDeltas(schoolId, headers);
            broadcastStatus(schoolId);
            return { push: pushResult, actions: actionResult, pull: pullResult };
        })();
        try {
            return await syncInFlight;
        } finally {
            syncInFlight = null;
        }
    }

    // Queues a request for something that can only actually happen with a
    // live internet connection (e.g. emailing results — see
    // DEFERRED_ACTION_TYPES in app.py). Unlike queueChange(), there's
    // nothing to show locally in the meantime: this is a command, not
    // data, so it just waits here until the next successful sync actually
    // runs it server-side.
    async function queueAction(schoolId, actionType, payload) {
        const clientUuid = crypto.randomUUID();
        const record = {
            client_uuid: clientUuid, action_type: actionType, payload,
            queued_at: new Date().toISOString(),
            _sync: { status: "pending", attempts: 0 },
        };
        await OfflineDB.putRecord(schoolId, "actions", record);
        broadcastStatus(schoolId);
        if (navigator.onLine) syncNow(schoolId, deviceIdFor(), deviceSecretFor()).catch(() => {});
        return record;
    }

    async function pushActions(schoolId, headers) {
        const pending = (await OfflineDB.getByStatus(schoolId, "actions", "pending"))
            .concat(await OfflineDB.getByStatus(schoolId, "actions", "failed"))
            .filter(backoffOk);
        if (!pending.length) return { done: 0, failed: 0 };
        const byUuid = {};
        const actions = pending.map((r) => {
            byUuid[r.client_uuid] = r;
            return { client_uuid: r.client_uuid, action_type: r.action_type, payload: r.payload };
        });
        let res;
        try {
            res = await fetch("/api/actions/queue", { method: "POST", headers, body: JSON.stringify({ actions }) });
        } catch (e) {
            return { done: 0, failed: 0 }; // stays pending, retried next cycle
        }
        if (!res.ok) return { done: 0, failed: 0 };
        const data = await res.json();
        let done = 0, failed = 0;
        for (const result of data.results) {
            const record = byUuid[result.client_uuid];
            if (!record) continue;
            if (result.status === "done") {
                record._sync = { status: "synced", attempts: 0, result_message: result.message };
                done++;
            } else {
                record._sync = {
                    status: "failed", attempts: (record._sync.attempts || 0) + 1,
                    last_attempt_at: new Date().toISOString(), last_error: result.message,
                };
                failed++;
            }
            await OfflineDB.putRecord(schoolId, "actions", record);
        }
        return { done, failed };
    }

    // Entities are pushed in dependency tiers so a record created offline
    // that depends on ANOTHER record also created offline (new student in
    // a new class; new score for a new student) gets its foreign key
    // resolved to a real server id as soon as the parent syncs — within
    // the SAME sync pass, not next time. Tier order mirrors the actual FK
    // graph: classes/subjects/users have no dependencies on offline data;
    // students depend on classes/users; everything else depends on
    // students (+ subjects, already tier 1).
    const SYNC_TIERS = [
        ["classes", "subjects", "users"],
        ["students"],
        ["scores", "attendance_records", "student_term_info"],
    ];

    // Fills in any `_pending_refs` on `record` whose parent has since
    // synced (i.e. now has a real numeric `id`). Returns true if the
    // record has no unresolved refs left (so it's safe to push).
    async function resolveRefs(schoolId, entity, record) {
        if (!record._pending_refs || !Object.keys(record._pending_refs).length) return true;
        const remaining = {};
        for (const [field, parentInfo] of Object.entries(record._pending_refs)) {
            const [parentEntity, parentUuid] = parentInfo.split(":");
            const parent = await OfflineDB.getRecord(schoolId, parentEntity, parentUuid);
            if (parent && parent.id) {
                record[field] = parent.id;
            } else if (parent && parent._sync && parent._sync.status === "conflict") {
                // The parent itself is stuck on a conflict — surface this
                // record as blocked too rather than silently waiting
                // forever with no explanation.
                record._sync.last_error = `Waiting on a ${parentEntity} record that has a sync conflict — resolve that first.`;
                remaining[field] = parentInfo;
            } else {
                remaining[field] = parentInfo;
            }
        }
        if (Object.keys(remaining).length) {
            record._pending_refs = remaining;
            await OfflineDB.putRecord(schoolId, entity, record);
            return false;
        }
        delete record._pending_refs;
        return true;
    }

    async function pushPending(schoolId, headers) {
        let totalSynced = 0, totalConflicts = 0, totalErrors = 0, totalBlocked = 0;
        for (const tier of SYNC_TIERS) {
            const changes = [];
            const byUuid = {};
            for (const entity of tier) {
                const pending = (await OfflineDB.getByStatus(schoolId, entity, "pending"))
                    .concat(await OfflineDB.getByStatus(schoolId, entity, "failed"))
                    .filter(backoffOk);
                for (const record of pending) {
                    const ready = await resolveRefs(schoolId, entity, record);
                    if (!ready) { totalBlocked++; continue; }
                    changes.push({
                        entity, client_uuid: record.client_uuid,
                        op: record._sync.op === "delete" ? "delete" : "upsert",
                        base_updated_at: record._sync.base_updated_at,
                        data: stripMeta(record),
                    });
                    byUuid[record.client_uuid] = { entity, record };
                }
            }
            if (!changes.length) continue;
            const result = await pushBatch(schoolId, headers, changes, byUuid);
            totalSynced += result.synced;
            totalConflicts += result.conflicts;
            totalErrors += result.errors;
            // Tier boundary: records in the NEXT tier that reference
            // something just synced in THIS tier get resolved before we
            // move on, so e.g. a student created in the same offline
            // session as its class doesn't have to wait for a second
            // sync cycle.
        }
        return { synced: totalSynced, conflicts: totalConflicts, errors: totalErrors, blocked: totalBlocked };
    }

    async function pushBatch(schoolId, headers, changes, byUuid) {
        let synced = 0, conflicts = 0, errors = 0;
        for (let i = 0; i < changes.length; i += BATCH_SIZE) {
            const batch = changes.slice(i, i + BATCH_SIZE);
            let res;
            try {
                res = await fetch("/api/sync/push", { method: "POST", headers, body: JSON.stringify({ changes: batch }) });
            } catch (e) {
                break; // connection dropped mid-sync; whatever's left stays pending for next time
            }
            if (!res.ok) break;
            const data = await res.json();
            for (const result of data.results) {
                const ref = byUuid[result.client_uuid];
                if (!ref) continue;
                const { entity, record } = ref;
                if (result.status === "synced") {
                    record.id = result.server_id;
                    record.updated_at = result.updated_at;
                    record._sync = { status: "synced", attempts: 0 };
                    // A password only ever needs to reach the server once
                    // (it's hashed there — see _hash_password_before_write
                    // in sync_api.py) — don't leave the plaintext sitting
                    // around locally any longer than it takes to sync.
                    delete record.password;
                    synced++;
                } else if (result.status === "conflict") {
                    record._sync = {
                        status: "conflict", op: record._sync.op,
                        base_updated_at: record._sync.base_updated_at,
                        server_data: result.server_data || null,
                        attempts: (record._sync.attempts || 0) + 1,
                        last_attempt_at: new Date().toISOString(),
                        last_error: result.message,
                    };
                    conflicts++;
                } else {
                    record._sync = {
                        ...record._sync,
                        status: "failed",
                        attempts: (record._sync.attempts || 0) + 1,
                        last_attempt_at: new Date().toISOString(),
                        last_error: result.message,
                    };
                    errors++;
                }
                await OfflineDB.putRecord(schoolId, entity, record);
            }
        }
        return { synced, conflicts, errors };
    }

    async function pullDeltas(schoolId, headers) {
        const since = await OfflineDB.getMeta(schoolId, "last_sync_at");
        const url = "/api/sync/pull" + (since ? `?since=${encodeURIComponent(since)}` : "");
        const res = await fetch(url, { headers });
        if (!res.ok) return { applied: 0 };
        const data = await res.json();
        let applied = 0;
        for (const [entity, rows] of Object.entries(data.entities)) {
            for (const row of rows) {
                const local = await OfflineDB.getRecord(schoolId, entity, row.client_uuid);
                if (local && local._sync && (local._sync.status === "pending" || local._sync.status === "conflict")) {
                    // Don't clobber an unsynced local edit with an
                    // incoming server change — surface it as a conflict
                    // instead so nothing is silently lost either way.
                    local._sync = { ...local._sync, status: "conflict", server_data: row };
                    await OfflineDB.putRecord(schoolId, entity, local);
                } else {
                    await OfflineDB.putRecord(schoolId, entity, { ...row, _sync: { status: "synced", attempts: 0 } });
                }
                applied++;
            }
        }
        await OfflineDB.setMeta(schoolId, "last_sync_at", data.generated_at);
        return { applied };
    }

    async function resolveConflict(schoolId, entity, clientUuid, keepLocal) {
        const record = await OfflineDB.getRecord(schoolId, entity, clientUuid);
        if (!record) return;
        if (keepLocal) {
            // Re-queue the local version against the server's current
            // state so the next push is compared to the right base.
            record._sync = { status: "pending", op: record._sync.op || "upsert", base_updated_at: record._sync.server_data ? record._sync.server_data.updated_at : null, attempts: 0 };
        } else if (record._sync.server_data) {
            Object.assign(record, record._sync.server_data);
            record._sync = { status: "synced", attempts: 0 };
        }
        await OfflineDB.putRecord(schoolId, entity, record);
        broadcastStatus(schoolId);
    }

    async function broadcastStatus(schoolId) {
        const counts = await OfflineDB.getPendingCounts(schoolId);
        const lastSync = await OfflineDB.getMeta(schoolId, "last_sync_at");
        document.dispatchEvent(new CustomEvent("offline-sync-status", {
            detail: { ...counts, online: navigator.onLine, lastSync },
        }));
    }

    let autoTimer = null;
    function startAutoSync(schoolId) {
        stopAutoSync();
        const trigger = () => syncNow(schoolId, deviceIdFor(), deviceSecretFor()).catch((e) => console.warn("sync failed", e));
        window.addEventListener("online", trigger);
        autoTimer = setInterval(() => { if (navigator.onLine) trigger(); }, 60000);
        if (navigator.onLine) trigger();
    }
    function stopAutoSync() {
        if (autoTimer) clearInterval(autoTimer);
        autoTimer = null;
    }

    return {
        bootstrap, queueChange, queueAction, readLocal, syncNow, resolveConflict,
        broadcastStatus, startAutoSync, stopAutoSync,
    };
})();
