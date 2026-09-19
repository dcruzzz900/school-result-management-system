/*
 * Offline authentication.
 *
 * Flow:
 *   1. ENROLL (must be online, already logged in via the normal cookie
 *      session): the device asks the server for a one-time offline
 *      credential (/api/offline/enroll), the staff member picks a PIN, and
 *      the credential is encrypted with that PIN and stored in IndexedDB
 *      (see offline-db.js / offline-crypto.js). The plaintext credential
 *      is never written to disk.
 *   2. UNLOCK (works with zero connectivity): the staff member picks their
 *      name from the device's account list and enters their PIN. If it
 *      decrypts successfully, an in-memory + sessionStorage "offline
 *      session" is created — this is what every offline page checks
 *      before showing anything.
 *   3. Offline session expiry: two independent limits, matching the
 *      "offline-session expiry and security controls" requirement —
 *        - a SHORT one (OFFLINE_SESSION_MAX_HOURS): the unlocked session
 *          expires after a few hours OR whenever the browser/tab is fully
 *          closed (sessionStorage doesn't survive that), whichever is
 *          sooner — so an unattended unlocked device doesn't stay usable
 *          indefinitely;
 *        - a LONG one (server-side, see db.py's OFFLINE_CREDENTIAL_LIFETIME_DAYS):
 *          the credential itself stops working after ~3 weeks with no
 *          successful online re-verification, so a device that's lost or
 *          a staff member who has left can't use it forever even if they
 *          remember the PIN.
 *   4. On reconnect, verifyOnline() re-checks the credential against the
 *      server (revoked? school suspended? expired?) and slides the long
 *      expiry forward.
 */
const OfflineAuth = (function () {
    const SESSION_KEY = "srs_offline_session";
    const MAX_SESSION_HOURS = 12;

    async function csrfHeader() {
        const res = await fetch("/csrf-token", { credentials: "same-origin" });
        if (!res.ok) throw new Error("Not logged in online — open the app normally first.");
        const data = await res.json();
        return data.csrf_token;
    }

    // Step 1 — must be called while online, from a normal logged-in page.
    async function enroll(pin, deviceLabel) {
        const csrf = await csrfHeader();
        const res = await fetch("/api/offline/enroll", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
            body: JSON.stringify({ device_label: deviceLabel || navigator.userAgent.slice(0, 40) }),
        });
        if (!res.ok) throw new Error("Could not enroll this device for offline access.");
        const data = await res.json();
        const encrypted = await OfflineCrypto.encrypt(pin, {
            device_id: data.device_id,
            device_secret: data.device_secret,
            user: data.user,
        });
        await OfflineDB.saveAccount({
            device_id: data.device_id,
            encrypted,
            label: `${data.user.name} — ${data.user.role.replace("_", " ")}`,
            school_id: data.user.school_id,
            enrolled_at: new Date().toISOString(),
            expires_at: data.expires_at,
        });
        // Seed the local database immediately so this device works offline
        // even if it never gets a second online moment before connectivity
        // is lost — "after their account has been successfully
        // authenticated online at least once" is satisfied right here.
        await SyncEngine.bootstrap(data.user.school_id, data.device_id, data.device_secret);
        return data;
    }

    async function listAccounts() {
        return OfflineDB.listAccounts();
    }

    // Step 2 — works fully offline.
    async function unlock(deviceId, pin) {
        const accounts = await OfflineDB.listAccounts();
        const account = accounts.find((a) => a.device_id === deviceId);
        if (!account) throw new Error("This device isn't enrolled for offline access yet.");
        let payload;
        try {
            payload = await OfflineCrypto.decrypt(pin, account.encrypted);
        } catch (e) {
            throw new Error("Incorrect PIN.");
        }
        if (account.expires_at && account.expires_at < new Date().toISOString()) {
            throw new Error("Offline access has expired on this device. Please connect to the internet and log in normally to renew it.");
        }
        const sessionData = {
            device_id: payload.device_id,
            device_secret: payload.device_secret,
            user: payload.user,
            started_at: new Date().toISOString(),
        };
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));
        verifyOnline().catch(() => { /* fine — we're offline, that's the point */ });
        return sessionData.user;
    }

    // Returns the current unlocked session, or null if there isn't one or
    // it has expired (clearing it in that case).
    function getSession() {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        let data;
        try { data = JSON.parse(raw); } catch (e) { sessionStorage.removeItem(SESSION_KEY); return null; }
        const ageHours = (Date.now() - new Date(data.started_at).getTime()) / 3.6e6;
        if (ageHours > MAX_SESSION_HOURS) {
            sessionStorage.removeItem(SESSION_KEY);
            return null;
        }
        return data;
    }

    function lock() {
        sessionStorage.removeItem(SESSION_KEY);
    }

    async function forgetDevice(deviceId) {
        await OfflineDB.deleteAccount(deviceId);
        const current = getSession();
        if (current && current.device_id === deviceId) lock();
    }

    // Step 4 — call whenever navigator.onLine flips true. Confirms the
    // credential is still valid and slides its expiry forward; forces the
    // session closed if the account/school is no longer in good standing.
    async function verifyOnline() {
        const session = getSession();
        if (!session || !navigator.onLine) return null;
        const res = await fetch("/api/offline/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_id: session.device_id, device_secret: session.device_secret }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.status !== "ok") {
            const reasons = {
                revoked: "This device's offline access has been revoked.",
                expired: "This device's offline access has expired.",
                school_suspended: "This school's account is suspended.",
                school_archived: "This school's account has been archived.",
                not_found: "This device is no longer recognized. Please re-enroll.",
                bad_secret: "This device's credential is no longer valid. Please re-enroll.",
            };
            lock();
            throw new Error(reasons[data.status] || "Offline access is no longer valid on this device.");
        }
        const accounts = await OfflineDB.listAccounts();
        const account = accounts.find((a) => a.device_id === session.device_id);
        if (account) {
            account.expires_at = data.expires_at;
            await OfflineDB.saveAccount(account);
        }
        return data;
    }

    function hasRole(...roles) {
        const session = getSession();
        return !!session && roles.includes(session.user.role);
    }

    return { enroll, listAccounts, unlock, getSession, lock, forgetDevice, verifyOnline, hasRole };
})();
