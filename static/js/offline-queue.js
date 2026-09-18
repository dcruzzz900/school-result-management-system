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
 * What it deliberately does NOT do: true background sync while the tab is
 * closed, automatic conflict resolution if the same record changed on the
 * server in the meantime, or queuing of file uploads (CSV imports aren't
 * offline-capable). navigator.onLine also isn't 100% reliable — it can
 * report "online" on a network with no real internet — so a sync attempt
 * can still fail even when this says you're online; failed syncs stay in
 * the queue and are retried, they are never silently dropped.
 */
const OfflineQueue = (function () {
    const KEY = "offline_queue_v1";

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
        const fd = new FormData(form);
        for (const key of ["first_name", "name", "title", "admission_no"]) {
            const v = fd.get(key);
            if (v) return label + ": " + v;
        }
        return label;
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
        saveQueue(loadQueue().filter((e) => e.id !== id));
        updateBadge();
    }

    async function getFreshCsrfToken() {
        const res = await fetch("/csrf-token", { credentials: "same-origin" });
        if (!res.ok) throw new Error("Could not fetch a fresh CSRF token (are you logged in?)");
        const data = await res.json();
        return data.csrf_token;
    }

    async function syncOne(entry) {
        const token = await getFreshCsrfToken();
        const body = new URLSearchParams();
        entry.fields.forEach(([k, v]) => body.append(k, v));
        body.append("csrf_token", token);
        const res = await fetch(entry.action, {
            method: "POST",
            body: body,
            credentials: "same-origin",
        });
        return res.ok;
    }

    async function syncAll(onProgress) {
        const q = loadQueue();
        const remaining = [];
        let successCount = 0;
        for (const entry of q) {
            try {
                const ok = await syncOne(entry);
                if (ok) {
                    successCount++;
                } else {
                    entry.attempts = (entry.attempts || 0) + 1;
                    entry.lastError = "The server didn't accept this submission.";
                    remaining.push(entry);
                }
            } catch (e) {
                entry.attempts = (entry.attempts || 0) + 1;
                entry.lastError = "Couldn't reach the server — still offline?";
                remaining.push(entry);
            }
            if (onProgress) onProgress(successCount, q.length);
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
            enqueue({
                action: form.getAttribute("action") || window.location.pathname,
                fields: serializeForm(form),
                label: description,
            });
            showToast("Saved offline: " + description + ". It will sync automatically once you're back online.");
            form.reset();
        });
    }

    function init() {
        document.querySelectorAll('form[data-offline="true"]').forEach(interceptForm);
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

    return { init: init, syncAll: syncAll, loadQueue: loadQueue, removeEntry: removeEntry, queueCount: queueCount };
})();

document.addEventListener("DOMContentLoaded", OfflineQueue.init);
