/*
 * Small WebCrypto wrapper used to encrypt the offline login credential
 * before it's stored on the device. Nothing here is a substitute for full
 * disk encryption or device passcodes — it's here so that reading the raw
 * IndexedDB file (e.g. off a stolen laptop's disk, or by another browser
 * profile) doesn't hand over a working offline credential without also
 * knowing the staff member's offline PIN.
 *
 * Algorithm: PBKDF2(SHA-256, 150k iterations) to derive an AES-GCM 256-bit
 * key from the PIN + a random per-device salt, then AES-GCM to encrypt the
 * JSON payload. AES-GCM's authentication tag means a wrong PIN doesn't
 * decrypt to garbage silently — it throws, which is how we detect "wrong
 * PIN" vs a corrupted record.
 */
const OfflineCrypto = (function () {
    function randomBytes(len) {
        return crypto.getRandomValues(new Uint8Array(len));
    }

    function toB64(buf) {
        return btoa(String.fromCharCode(...new Uint8Array(buf)));
    }

    function fromB64(b64) {
        return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    }

    async function deriveKey(pin, saltB64) {
        const salt = fromB64(saltB64);
        const baseKey = await crypto.subtle.importKey(
            "raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]
        );
        return crypto.subtle.deriveKey(
            { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
            baseKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
    }

    async function encrypt(pin, plainObj) {
        const salt = randomBytes(16);
        const saltB64 = toB64(salt);
        const key = await deriveKey(pin, saltB64);
        const iv = randomBytes(12);
        const data = new TextEncoder().encode(JSON.stringify(plainObj));
        const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
        return { salt: saltB64, iv: toB64(iv), ciphertext: toB64(ciphertext) };
    }

    // Throws if the PIN is wrong (AES-GCM tag mismatch) or the record is corrupt.
    async function decrypt(pin, blob) {
        const key = await deriveKey(pin, blob.salt);
        const plainBuf = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: fromB64(blob.iv) }, key, fromB64(blob.ciphertext)
        );
        return JSON.parse(new TextDecoder().decode(plainBuf));
    }

    return { encrypt, decrypt };
})();
