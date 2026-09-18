/*
 * IndexedDB layer for offline-first data.
 *
 * Two kinds of database:
 *
 *  - "meta" DB (srs_offline_meta): one row per device credential this
 *    browser has enrolled, keyed by device_id. Holds only the ENCRYPTED
 *    credential blob plus a plaintext display label — enough to show a
 *    "who's logging in?" picker on a shared device WITHOUT decrypting
 *    anything. This is the only thing that exists before a PIN is entered.
 *
 *  - one "school" DB PER school_id (srs_offline_school_<id>): created only
 *    after a successful offline (or online) login reveals which school the
 *    logged-in account belongs to. Every entity table lives here, scoped
 *    to that one school. Two different schools' staff using the same
 *    physical device — e.g. a shared cyber-cafe computer — end up with
 *    two completely separate IndexedDB databases; there is no query that
 *    can accidentally join across them, which is what "School A must
 *    never receive School B's data" needs at the storage layer, not just
 *    in application logic.
 *
 * Every entity row carries a `_sync` object: { status, op, base_updated_at,
 * attempts, last_error }. status is one of 'synced' | 'pending' | 'conflict'
 * | 'failed'. Reads always go through the entity store directly — there is
 * no separate "outbox" to reconcile — a row IS the current local truth,
 * whether or not it has made it to the server yet.
 */
const OfflineDB = (function () {
    const ENTITY_STORES = [
        "students", "scores", "attendance_records", "staff_attendance",
        "student_term_info", "classes", "subjects", "users",
        "sessions", "terms", "class_subjects",
    ];
    const META_DB_NAME = "srs_offline_meta";
    const META_VERSION = 1;
    const SCHOOL_DB_VERSION = 1;

    function openDb(name, version, onUpgrade) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(name, version);
            req.onupgradeneeded = (e) => onUpgrade(req.result, e.oldVersion);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function openMetaDb() {
        return openDb(META_DB_NAME, META_VERSION, (db) => {
            if (!db.objectStoreNames.contains("accounts")) {
                db.createObjectStore("accounts", { keyPath: "device_id" });
            }
        });
    }

    function openSchoolDb(schoolId) {
        return openDb(`srs_offline_school_${schoolId}`, SCHOOL_DB_VERSION, (db) => {
            for (const entity of ENTITY_STORES) {
                if (!db.objectStoreNames.contains(entity)) {
                    const store = db.createObjectStore(entity, { keyPath: "client_uuid" });
                    store.createIndex("sync_status", "_sync.status");
                    store.createIndex("updated_at", "updated_at");
                }
            }
            if (!db.objectStoreNames.contains("_meta")) {
                db.createObjectStore("_meta", { keyPath: "key" });
            }
        });
    }

    function tx(db, storeNames, mode, fn) {
        return new Promise((resolve, reject) => {
            const t = db.transaction(storeNames, mode);
            const result = fn(t);
            t.oncomplete = () => resolve(result);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error);
        });
    }

    function reqToPromise(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    // ---- account (device credential) storage ----

    async function saveAccount(account) {
        const db = await openMetaDb();
        await tx(db, "accounts", "readwrite", (t) => t.objectStore("accounts").put(account));
        db.close();
    }

    async function listAccounts() {
        const db = await openMetaDb();
        const result = await reqToPromise(db.transaction("accounts", "readonly").objectStore("accounts").getAll());
        db.close();
        return result;
    }

    async function deleteAccount(deviceId) {
        const db = await openMetaDb();
        await tx(db, "accounts", "readwrite", (t) => t.objectStore("accounts").delete(deviceId));
        db.close();
    }

    // ---- per-school entity storage ----

    async function putRecord(schoolId, entity, record) {
        const db = await openSchoolDb(schoolId);
        await tx(db, entity, "readwrite", (t) => t.objectStore(entity).put(record));
        db.close();
    }

    async function putRecords(schoolId, entity, records) {
        if (!records.length) return;
        const db = await openSchoolDb(schoolId);
        await tx(db, entity, "readwrite", (t) => {
            const store = t.objectStore(entity);
            records.forEach((r) => store.put(r));
        });
        db.close();
    }

    async function getRecord(schoolId, entity, clientUuid) {
        const db = await openSchoolDb(schoolId);
        const result = await reqToPromise(db.transaction(entity, "readonly").objectStore(entity).get(clientUuid));
        db.close();
        return result;
    }

    async function getAll(schoolId, entity) {
        const db = await openSchoolDb(schoolId);
        const all = await reqToPromise(db.transaction(entity, "readonly").objectStore(entity).getAll());
        db.close();
        return all.filter((r) => !r.is_deleted);
    }

    async function getByStatus(schoolId, entity, status) {
        const db = await openSchoolDb(schoolId);
        const idx = db.transaction(entity, "readonly").objectStore(entity).index("sync_status");
        const result = await reqToPromise(idx.getAll(IDBKeyRange.only(status)));
        db.close();
        return result;
    }

    async function getPendingCounts(schoolId) {
        const counts = { pending: 0, conflict: 0, failed: 0 };
        for (const entity of ENTITY_STORES) {
            for (const status of Object.keys(counts)) {
                try {
                    const rows = await getByStatus(schoolId, entity, status);
                    counts[status] += rows.length;
                } catch (e) { /* store may not exist yet on a brand new db */ }
            }
        }
        return counts;
    }

    async function setMeta(schoolId, key, value) {
        const db = await openSchoolDb(schoolId);
        await tx(db, "_meta", "readwrite", (t) => t.objectStore("_meta").put({ key, value }));
        db.close();
    }

    async function getMeta(schoolId, key) {
        const db = await openSchoolDb(schoolId);
        const row = await reqToPromise(db.transaction("_meta", "readonly").objectStore("_meta").get(key));
        db.close();
        return row ? row.value : null;
    }

    return {
        ENTITY_STORES, saveAccount, listAccounts, deleteAccount,
        putRecord, putRecords, getRecord, getAll, getByStatus,
        getPendingCounts, setMeta, getMeta,
    };
})();
