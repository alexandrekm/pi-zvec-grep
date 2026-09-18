/** Workspace path and output helpers for pi-zvec-grep. */

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Normalize a user-supplied workspace root: empty → cwd, leading `@` stripped
 * (some models paste tool-path conventions into arguments), relative paths
 * resolved against cwd.
 */
export function normalizeRoot(root: string | undefined, cwd: string): string {
	if (!root || !root.trim()) return cwd;
	const cleaned = root.trim().replace(/^@/, '');
	if (cleaned === '~') return homedir();
	if (cleaned.startsWith('~/')) return resolve(homedir(), cleaned.slice(2));
	return resolve(cwd, cleaned);
}

/** Cap tool output sent to the model; large searches must not blow the context. */
export function clip(text: string, limit = 60_000): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n…(truncated ${text.length - limit} chars)`;
}

/** A held cross-process auto-index lock; `release()` is idempotent. */
export interface AutoIndexLock {
	release(): void;
}

/** A lock older than this is assumed abandoned (crashed holder) and stolen. */
const AUTOINDEX_LOCK_STALE_MS = 10 * 60_000;

/**
 * Cross-process mutual exclusion for auto-index builds of one root.
 *
 * The per-root in-flight set inside `registerAutoIndex` only guards this
 * process; two pi sessions starting in the same root otherwise race
 * `zg index` and corrupt the index files (observed on a 4.1 GB index:
 * "possible crash residue" + read-only-mode IDMap errors on every later
 * `zg status`). This lock is filesystem-based: `<root>/.zvec-grep/locks/`
 * is created (the same dir zg itself uses), then the lockfile is opened with
 * `wx` — atomically failing while another process holds it. A stale lock
 * (crashed holder) is stolen after 10 minutes. Never throws: an un-lockable
 * dir simply reports "already building" (skip).
 */
export function acquireAutoIndexLock(root: string, now = Date.now()): AutoIndexLock | undefined {
	try {
		const dir = join(root, '.zvec-grep', 'locks');
		fs.mkdirSync(dir, { recursive: true });
		const file = join(dir, 'autoindex.lock');
		let fd: number | undefined;
		try {
			fd = fs.openSync(file, 'wx');
		} catch {
			// Held — unless stale (holder crashed): steal it once, best-effort.
			try {
				const stat = fs.statSync(file);
				if (now - stat.mtimeMs < AUTOINDEX_LOCK_STALE_MS) return undefined;
				fs.rmSync(file, { force: true });
				fd = fs.openSync(file, 'wx');
			} catch {
				return undefined;
			}
		}
		fs.writeFileSync(fd, `${process.pid}\n${new Date(now).toISOString()}\n`);
		let released = false;
		return {
			release(): void {
				if (released) return;
				released = true;
				try {
					fs.closeSync(fd!);
				} catch {}
				try {
					fs.rmSync(file, { force: true });
				} catch {}
			},
		};
	} catch {
		return undefined;
	}
}
