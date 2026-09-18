/* offline-auth.js
 *
 * Offline login support. The idea: right after a REAL online login, while
 * the user's password is still briefly sitting in the login form's memory,
 * we use it (via PBKDF2) to derive a key, and use that key to AES-GCM
 * encrypt a small identity payload (role, position, school, an expiry) for
 * this user. The encrypted blob goes in IndexedDB, keyed by username.
 *
 * Later, if the device is offline when someone tries to log in (or unlock
 * an already-open page — see the lock screen in base.html), we derive the
 * same key from whatever password they type and try to decrypt the stored
 * blob. If it decrypts, the password was correct — a wrong password just
 * produces garbage that fails AES-GCM's built-in authentication check.
 * There's no separate "password hash" stored anywhere on the device; the
 * ciphertext IS the only verifier, so there's nothing crackable at rest
 * beyond the ciphertext itself.
 *
 * This never talks to the server — by design, it has to work with zero
 * connectivity.
 */
(function (global) {
  "use strict";

  const DB_NAME = "offlineAuthDB";
  const DB_VERSION = 1;
  const STORE_NAME = "credentials";
  // OWASP's 2023 guidance for PBKDF2-HMAC-SHA256 is 600k+ iterations; we use
  // a somewhat lower figure so unlocking doesn't noticeably lag on older,
  // low-end phones, while still being far beyond what made older, smaller
  // counts crackable.
  const PBKDF2_ITERATIONS = 300000;

  function supported() {
    return (
      typeof indexedDB !== "undefined" &&
      global.crypto &&
      global.crypto.subtle &&
      typeof global.crypto.subtle.importKey === "function"
    );
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME, { keyPath: "username" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function putRecord(record) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        })
    );
  }

  function getRecord(username) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readonly");
          const req = tx.objectStore(STORE_NAME).get(username);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        })
    );
  }

  function deleteRecord(username) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).delete(username);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        })
    );
  }

  function deriveKey(password, salt) {
    const enc = new TextEncoder();
    return crypto.subtle
      .importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"])
      .then((baseKey) =>
        crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
          baseKey,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"]
        )
      );
  }

  // Called right after a successful ONLINE login. `payload` is whatever
  // JSON the server's /offline-auth/bundle endpoint returned for this user
  // (role, position, school_id, issued/expires timestamps, etc).
  function registerCredential(username, password, payload) {
    if (!supported()) return Promise.resolve(false);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(password, salt)
      .then((key) => {
        const enc = new TextEncoder();
        return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, enc.encode(JSON.stringify(payload)));
      })
      .then((ciphertext) =>
        putRecord({
          username: username,
          salt: Array.from(salt),
          iv: Array.from(iv),
          ciphertext: Array.from(new Uint8Array(ciphertext)),
          savedAt: new Date().toISOString(),
        })
      )
      .then(() => true)
      .catch(() => false);
  }

  // Attempts an offline unlock. Resolves to { ok: true, payload } on
  // success, or { ok: false, reason } — never rejects, so callers don't
  // need a .catch just to show an error message.
  function tryUnlock(username, password) {
    if (!supported()) {
      return Promise.resolve({ ok: false, reason: "Offline login isn't supported in this browser." });
    }
    return getRecord(username)
      .then((record) => {
        if (!record) {
          return { ok: false, reason: "No offline access saved for this account on this device yet — log in once while online first." };
        }
        const salt = new Uint8Array(record.salt);
        const iv = new Uint8Array(record.iv);
        const ciphertext = new Uint8Array(record.ciphertext);
        return deriveKey(password, salt)
          .then((key) => crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ciphertext))
          .then((plaintext) => {
            const payload = JSON.parse(new TextDecoder().decode(plaintext));
            if (payload.expires_at && new Date(payload.expires_at).getTime() < Date.now()) {
              return { ok: false, reason: "Your offline access has expired. Connect to the internet and log in once to renew it." };
            }
            return { ok: true, payload: payload };
          })
          .catch(() => ({ ok: false, reason: "Incorrect password." }));
      })
      .catch(() => ({ ok: false, reason: "Couldn't read offline credentials on this device." }));
  }

  function clearCredential(username) {
    if (!supported()) return Promise.resolve();
    return deleteRecord(username).catch(() => {});
  }

  function hasCredential(username) {
    if (!supported()) return Promise.resolve(false);
    return getRecord(username)
      .then((r) => !!r)
      .catch(() => false);
  }

  global.OfflineAuth = {
    registerCredential: registerCredential,
    tryUnlock: tryUnlock,
    clearCredential: clearCredential,
    hasCredential: hasCredential,
  };
})(window);
