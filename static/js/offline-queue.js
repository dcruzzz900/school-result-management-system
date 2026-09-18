/*
 * Offline draft queue — a "lite" offline mode, not full background sync.
 *
 * What it does: when a form marked data-offline="true" is submitted while
 * the browser reports no connection, the submission is saved in this
 * browser's localStorage instead of being sent, and re-sent automatically
 * when the browser comes back online (or manually from the Offline Queue
 * page). Each queued item replays as an exact copy of the original form
 * fields against the same URL, using a freshly-fetched CSRF token.
 *
 * Forms that CREATE a record — Add Class, Add Student, Add Teacher, Add
 * Subject — are also tagged data-offline-creates="<type>". Queuing one of
 * these immediately gives it a local placeholder ID (e.g.
 * "local_class_171..."), stored under offline_pending_records_v1, and
 * injects it as a new option into any select[data-offline-ref="<type>"]
 * on the page — so you can, say, create a new class and immediately pick
 * it in the Add Student form, all offline, all on this device. Any other
 * queued form that references that placeholder is marked as depending on
 * it and won't sync until the parent record has synced and been given a
 * real server ID — at which point its placeholder is swapped out for the
 * real one everywhere it's used before that dependent item is sent. Each
 * entity-creating item also carries a one-time token, so if a sync
 * actually succeeds on the server but the client never sees the response
 * (connection drops right after), retrying it reuses the same record
 * instead of creating a duplicate.
 *
 * What it deliberately does NOT do: true background sync while the tab is
 * closed, conflict resolution for a record that changed on the server in
 * the meantime (only creation is placeholder-aware — editing/deleting an
 * existing record offline still just replays against its real ID), or
 * queuing of file uploads (CSV imports aren't offline-capable).
 * navigator.onLine also isn't 100% reliable — it can report "online" on a
 * network with no real internet — so a sync attempt can still fail even
 * when this says you're online; failed syncs stay in the queue and are
 * retried, they are never silently dropped.
 */
const OfflineQueue = (function () {
    // Namespaced per school (not per user) — the same device can be used
    // for two different schools' accounts, and their offline drafts must
    // never mix or leak into each other's Offline Queue page or pending-
    // record dropdowns. Falls back to a shared "unknown" bucket only for
    // pages where school id isn't available (there shouldn't be any, since
    // this only loads on authenticated pages — see base.html).
    const SCHOOL_ID = (document.body && document.body.dataset.authSchoolId) || "unknown";
    const KEY = "offline_queue_v1:" + SCHOOL_ID;
    const PENDING_KEY = "offline_pending_records_v1:" + SCHOOL_ID;

    // One-time migration: this app used a single unnamespaced key before
    // schools were separated out. If that old key still has data and this
    // school doesn't have a namespaced queue yet, bring it over rather than
    // silently losing it — best-effort, since we can't know for certain it
    // belonged to this school, but it's better than data just vanishing on
    // whichever school happens to load the update first.
    (function migrateLegacyStorage() {
        ["offline_queue_v1", "offline_pending_records_v1"].forEach((legacyKey, i) => {
            const namespacedKey = i === 0 ? KEY : PENDING_KEY;
            const legacy = localStorage.getItem(legacyKey);
            if (legacy && !localStorage.getItem(namespacedKey)) {
                localStorage.setItem(namespacedKey, legacy);
            }
            if (legacy) localStorage.removeItem(legacyKey);
        });
    })();

    function loadQueue() {
        try {
            return JSON.parse(localStorage.getItem(KEY) || "[]");
        } catch (e) {
            return [];
        }
    }

    function saveQueue(q) {
        localStorage.setItem(KEY, JSON.stringify(q));
    }

    function queueCount() {
        return loadQueue().length;
    }

    function updateBadge() {
        const el = document.getElementById("offlineQueueBadge");
        if (!el) return;
        const n = queueCount();
        el.textContent = n;
        el.style.display = n > 0 ? "inline-block" : "none";
    }

    // --- Pending (not-yet-synced) locally-created records ----------------
    // { class: [{localId, label, meta}], student: [...], ... }
    // meta is optional, entity-specific context — e.g. a pending student's
    // meta.classId lets Score Entry / Roll Call know which class's roster
    // to show it in.

    // A generated local placeholder always looks like local_<type>_<digits>_<rand>.
    const LOCAL_ID_PATTERN = /local_[A-Za-z]+_\d+_[a-z0-9]+/g;

    function loadPendingRecords() {
        try {
            return JSON.parse(localStorage.getItem(PENDING_KEY) || "{}");
        } catch (e) {
            return {};
        }
    }

    function savePendingRecords(all) {
        localStorage.setItem(PENDING_KEY, JSON.stringify(all));
    }

    function addPendingRecord(entityType, localId, label, meta) {
        const all = loadPendingRecords();
        if (!all[entityType]) all[entityType] = [];
        all[entityType].push({ localId: localId, label: label, meta: meta || null });
        savePendingRecords(all);
    }

    function removePendingRecord(entityType, localId) {
        const all = loadPendingRecords();
        if (all[entityType]) {
            all[entityType] = all[entityType].filter((r) => r.localId !== localId);
            savePendingRecords(all);
        }
    }

    // Used by other pages (Score Entry, Roll Call) to find pending records
    // relevant to what they're showing — e.g. students waiting to sync
    // into the class currently being viewed.
    function getPendingRecords(entityType) {
        return loadPendingRecords()[entityType] || [];
    }

    function labelForLocalId(localId) {
        const all = loadPendingRecords();
        for (const type in all) {
            const rec = (all[type] || []).find((r) => r.localId === localId);
            if (rec) return rec.label;
        }
        return "another offline item";
    }

    // Injects an <option> for every not-yet-synced local record into any
    // select[data-offline-ref="<type>"] on the current page. Safe to call
    // repeatedly — skips options it's already added.
    function populateRefSelects() {
        const all = loadPendingRecords();
        document.querySelectorAll("select[data-offline-ref]").forEach((select) => {
            const type = select.dataset.offlineRef;
            (all[type] || []).forEach((rec) => {
                if (select.querySelector('option[value="' + rec.localId + '"]')) return;
                const opt = document.createElement("option");
                opt.value = rec.localId;
                opt.textContent = rec.label + " (pending sync)";
                select.appendChild(opt);
            });
        });
    }

    function randomLocalId(entityType) {
        return "local_" + entityType + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    }

    // Field values are kept as [key, value] pairs, not a plain object —
    // some forms (score entry) repeat the same field name once per row
    // (e.g. several "student_id" inputs), and a plain object would silently
    // collapse those down to just the last one.
    function serializeForm(form) {
        const pairs = [];
        new FormData(form).forEach((v, k) => {
            if (k === "csrf_token") return; // refreshed at sync time, not stored
            pairs.push([k, typeof v === "string" ? v : ""]); // file inputs aren't supported offline
        });
        return pairs;
    }

    function describeEntry(form) {
        const label = form.dataset.offlineLabel || "Saved item";
        const name = entityName(form);
        return name ? label + ": " + name : label;
    }

    // Just the human name of the thing being created/edited, with no
    // "Add X:" prefix — used for the (pending sync) dropdown option text.
    function entityName(form) {
        const fd = new FormData(form);
        const first = fd.get("first_name");
        if (first) return (first + " " + (fd.get("last_name") || "")).trim();
        for (const key of ["name", "title", "admission_no"]) {
            const v = fd.get(key);
            if (v) return v;
        }
        return null;
    }

    function enqueue(entry) {
        const q = loadQueue();
        entry.id = "draft_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
        entry.queued_at = new Date().toISOString();
        entry.attempts = 0;
        q.push(entry);
        saveQueue(q);
        updateBadge();
        return entry.id;
    }

    function removeEntry(id) {
        const q = loadQueue();
        const entry = q.find((e) => e.id === id);
        if (entry && entry.entityType && entry.localId) {
            removePendingRecord(entry.entityType, entry.localId);
        }
        saveQueue(q.filter((e) => e.id !== id));
        updateBadge();
    }

    async function getFreshCsrfToken() {
        const res = await fetch("/csrf-token", { credentials: "same-origin" });
        if (!res.ok) throw new Error("Could not fetch a fresh CSRF token (are you logged in?)");
        const data = await res.json();
        return data.csrf_token;
    }

    // Returns { ok, id?, error? }. For entity-creating entries the server
    // is asked (via the X-Offline-Sync header) to respond with JSON
    // carrying the new record's real id, instead of its normal
    // flash-and-redirect page.
    async function syncOne(entry) {
        const token = await getFreshCsrfToken();
        const body = new URLSearchParams();
        entry.fields.forEach(([k, v]) => body.append(k, v));
        body.append("csrf_token", token);
        const headers = { };
        if (entry.entityType) headers["X-Offline-Sync"] = "1";
        const res = await fetch(entry.action, {
            method: "POST",
            body: body,
            credentials: "same-origin",
            headers: headers,
        });
        if (entry.entityType) {
            let data = null;
            try {
                data = await res.json();
            } catch (e) {
                // Not JSON — most likely a login redirect (session expired).
            }
            if (res.ok && data && data.ok) return { ok: true, id: data.id };
            return { ok: false, error: (data && data.error) || null };
        }
        return { ok: res.ok };
    }

    // Replaces every occurrence of a now-resolved local placeholder id
    // within a string (key or value) with its real server id. Leaves
    // anything not yet resolved untouched — that's what keeps a still-
    // blocked dependent entry waiting instead of being sent with a
    // placeholder baked into it.
    function resolveIds(str, resolvedMap) {
        return String(str).replace(LOCAL_ID_PATTERN, (id) =>
            resolvedMap.hasOwnProperty(id) ? String(resolvedMap[id]) : id
        );
    }

    // Syncs the queue in dependency order: an item that references a
    // not-yet-synced local placeholder waits until that parent item has
    // synced and been resolved to a real id, which is then substituted in
    // before the dependent item is sent. Runs repeated passes over
    // whatever's left until a full pass makes no progress.
    async function syncAll(onProgress) {
        const q = loadQueue();
        const total = q.length;
        const resolvedMap = {};
        let successCount = 0;
        let remaining = q.slice();
        let progressMade = true;

        while (progressMade && remaining.length) {
            progressMade = false;
            const stillRemaining = [];
            for (const entry of remaining) {
                const unresolvedDeps = (entry.dependsOn || []).filter((id) => !(id in resolvedMap));
                if (unresolvedDeps.length) {
                    entry.lastError = 'Waiting on "' + labelForLocalId(unresolvedDeps[0]) + '" to sync first.';
                    stillRemaining.push(entry);
                    continue;
                }

                const resolvedFields = entry.fields.map(([k, v]) => [
                    resolveIds(k, resolvedMap),
                    resolveIds(v, resolvedMap),
                ]);

                try {
                    const result = await syncOne({ ...entry, fields: resolvedFields });
                    if (result.ok) {
                        successCount++;
                        progressMade = true;
                        if (entry.localId) {
                            resolvedMap[entry.localId] = result.id;
                            removePendingRecord(entry.entityType, entry.localId);
                        }
                    } else {
                        entry.attempts = (entry.attempts || 0) + 1;
                        entry.lastError = result.error || "The server didn't accept this submission.";
                        stillRemaining.push(entry);
                    }
                } catch (e) {
                    entry.attempts = (entry.attempts || 0) + 1;
                    entry.lastError = "Couldn't reach the server — still offline?";
                    stillRemaining.push(entry);
                }
                if (onProgress) onProgress(successCount, total);
            }
            remaining = stillRemaining;
        }

        saveQueue(remaining);
        updateBadge();
        return { successCount: successCount, remainingCount: remaining.length };
    }

    function showToast(message) {
        let el = document.getElementById("offlineToast");
        if (!el) {
            el = document.createElement("div");
            el.id = "offlineToast";
            el.className = "offline-toast";
            document.body.appendChild(el);
        }
        el.textContent = message;
        el.classList.add("show");
        clearTimeout(el._hideTimer);
        el._hideTimer = setTimeout(() => el.classList.remove("show"), 5000);
    }

    function interceptForm(form) {
        form.addEventListener("submit", function (e) {
            if (navigator.onLine) return; // let it submit normally
            e.preventDefault();

            const description = describeEntry(form);
            const entityType = form.dataset.offlineCreates || null;
            const fields = serializeForm(form);
            let localId = null;

            if (entityType) {
                localId = randomLocalId(entityType);
                fields.push(["offline_token", localId]);
                const classIdField = fields.find(([k]) => k === "class_id");
                const meta = classIdField ? { classId: classIdField[1] } : undefined;
                addPendingRecord(entityType, localId, entityName(form) || description, meta);
            }

            // A referenced not-yet-synced record can show up either as a
            // field VALUE (e.g. class_id=local_class_...) or embedded in a
            // field NAME (Roll Call's status_local_student_... radios,
            // since there's no separate student_id field on that form) —
            // so scan both for anything that looks like a local placeholder.
            const dependsOn = new Set();
            fields.forEach(([k, v]) => {
                (String(k).match(LOCAL_ID_PATTERN) || []).forEach((id) => dependsOn.add(id));
                (String(v).match(LOCAL_ID_PATTERN) || []).forEach((id) => dependsOn.add(id));
            });

            enqueue({
                action: form.getAttribute("action") || window.location.pathname,
                fields: fields,
                label: description,
                entityType: entityType,
                localId: localId,
                dependsOn: Array.from(dependsOn),
            });

            populateRefSelects();
            showToast("Saved offline: " + description + ". It will sync automatically once you're back online.");
            form.reset();
        });
    }

    function init() {
        document.querySelectorAll('form[data-offline="true"]').forEach(interceptForm);
        populateRefSelects();
        updateBadge();
        window.addEventListener("online", function () {
            if (queueCount() === 0) return;
            showToast("Back online — syncing " + queueCount() + " offline item(s)...");
            syncAll().then((result) => {
                if (result.successCount > 0) {
                    showToast(result.successCount + " offline item(s) synced" +
                        (result.remainingCount > 0 ? ", " + result.remainingCount + " still pending." : "."));
                }
            });
        });
    }

    return {
        init: init,
        syncAll: syncAll,
        loadQueue: loadQueue,
        removeEntry: removeEntry,
        queueCount: queueCount,
        populateRefSelects: populateRefSelects,
        getPendingRecords: getPendingRecords,
    };
})();

document.addEventListener("DOMContentLoaded", OfflineQueue.init);
