import crypto from "node:crypto";

// Admin panel authentication. Only a scrypt hash of the password is stored (config.json `admin.passwordHash`,
// written by `npm run kg:admin:password`). Sessions live in memory, so a server restart logs everyone out.

export const MIN_PASSWORD_LENGTH = 10;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;

// "scrypt$N$r$p$<salt base64>$<hash base64>"
export function hashPassword(password) {
	const text = String(password ?? "");
	if (text.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`The admin password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
	}

	const salt = crypto.randomBytes(16);
	const hash = crypto.scryptSync(text, salt, KEY_LENGTH, SCRYPT_PARAMS);
	return ["scrypt", SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export function verifyPassword(password, storedHash) {
	const parts = String(storedHash ?? "").split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") {
		return false;
	}

	const [, n, r, p, salt, expected] = parts;
	const expectedBuffer = Buffer.from(expected, "base64");
	const actual = crypto.scryptSync(String(password ?? ""), Buffer.from(salt, "base64"), expectedBuffer.length, {
		N: Number(n),
		r: Number(r),
		p: Number(p),
	});
	return expectedBuffer.length === actual.length && crypto.timingSafeEqual(expectedBuffer, actual);
}

// In-memory sessions with a fixed lifetime, and a lockout after repeated failed logins from one address.
export class AdminSessions {
	constructor({ sessionMinutes = 30, maxFailures = 5, lockoutMinutes = 15, now = () => Date.now() } = {}) {
		this.sessionMs = sessionMinutes * 60 * 1000;
		this.maxFailures = maxFailures;
		this.lockoutMs = lockoutMinutes * 60 * 1000;
		this.now = now;
		this.sessions = new Map();
		this.failures = new Map();
	}

	create() {
		const token = crypto.randomBytes(32).toString("hex");
		this.sessions.set(token, this.now() + this.sessionMs);
		return { token, maxAgeSeconds: Math.floor(this.sessionMs / 1000) };
	}

	isValid(token) {
		const expiresAt = this.sessions.get(token);
		if (!expiresAt) {
			return false;
		}
		if (expiresAt <= this.now()) {
			this.sessions.delete(token);
			return false;
		}
		return true;
	}

	destroy(token) {
		this.sessions.delete(token);
	}

	// Milliseconds until the address may try again, or 0.
	lockedFor(key) {
		const entry = this.failures.get(key);
		if (!entry?.lockedUntil) {
			return 0;
		}
		const remaining = entry.lockedUntil - this.now();
		if (remaining <= 0) {
			this.failures.delete(key);
			return 0;
		}
		return remaining;
	}

	recordFailure(key) {
		const entry = this.failures.get(key) ?? { count: 0, lockedUntil: 0 };
		entry.count += 1;
		if (entry.count >= this.maxFailures) {
			entry.lockedUntil = this.now() + this.lockoutMs;
			entry.count = 0;
		}
		this.failures.set(key, entry);
	}

	clearFailures(key) {
		this.failures.delete(key);
	}
}
