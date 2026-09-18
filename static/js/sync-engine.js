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

    // Records a local create/update/delete. Safe to call whether online or
    // offline — it always writes locally first, then opportunistically
    // tries to sync immediately if there's a connection.
    async function queueChange(schoolId, entity, op, data, clientUuid) {
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

    async function syncNow(schoolId, deviceId, deviceSecret) {
        if (!navigator.onLine || !schoolId) return { skipped: true };
        const headers = authHeaders(deviceId, deviceSecret);
        const pushResult = await pushPending(schoolId, headers);
        const pullResult = await pullDeltas(schoolId, headers);
        broadcastStatus(schoolId);
        return { push: pushResult, pull: pullResult };
    }

    async function pushPending(schoolId, headers) {
        const changes = [];
        const byUuid = {};
        for (const entity of OfflineDB.ENTITY_STORES) {
            const pending = (await OfflineDB.getByStatus(schoolId, entity, "pending"))
                .concat(await OfflineDB.getByStatus(schoolId, entity, "failed"))
                .filter(backoffOk);
            for (const record of pending) {
                changes.push({
                    entity, client_uuid: record.client_uuid,
                    op: record._sync.op === "delete" ? "delete" : "upsert",
                    base_updated_at: record._sync.base_updated_at,
                    data: stripMeta(record),
                });
                byUuid[record.client_uuid] = { entity, record };
            }
        }
        if (!changes.length) return { synced: 0, conflicts: 0, errors: 0 };

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
        bootstrap, queueChange, readLocal, syncNow, resolveConflict,
        broadcastStatus, startAutoSync, stopAutoSync,
    };
})();
