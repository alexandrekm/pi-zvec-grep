/**
 * Network-filesystem detection for index roots.
 *
 * Why: zg indexes are local vector stores doing heavy random I/O plus a
 * local embedding model — building one on a network mount (NFS, SMB/CIFS,
 * sshfs, …) is brutally slow, and every later `zg status` freshness check
 * re-stats the tree over the wire, so sessions in that workspace hang the
 * same way the home-rooted index once did. Indexing a network-mounted
 * checkout is almost never what anyone wants, so the root policy blocks it
 * unless explicitly allowed (`rootPolicy.allowNetworkFs`).
 *
 * Detection is mount-table based, longest-prefix match of the resolved root
 * against mount points. Sources:
 *   - Linux: /proc/self/mounts (plain fs read, no process spawn)
 *   - macOS/other: the `mount` command's output
 * Mount(8) output differs per platform; the parser accepts both shapes:
 *   `<dev> on <point> type <fstype> (<opts>)`   (Linux util-linux)
 *   `<dev> on <point> (<fstype>, <opts>…)`       (macOS — first paren token)
 * /proc/self/mounts' `<dev> <point> <fstype> <opts>` is accepted too.
 *
 * Fail-open by design: if the mount table cannot be collected at all, the
 * root is treated as NOT network (indexing behaves exactly as before) —
 * a detection failure must never make indexing impossible.
 *
 * Pi-free by design (same rule as the rest of `src/core/`).
 */

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/** Filesystem types treated as network (lowercased comparison). */
export const NETWORK_FS_TYPES: ReadonlySet<string> = new Set([
	'nfs',
	'nfs4',
	'nfs5',
	'cifs',
	'smbfs',
	'smbfs2',
	'sshfs',
	'fuse.sshfs',
	'afpfs',
	'davfs',
	'davfs2',
	'webdav',
	'9p',
	'ncpfs',
	'afs',
	'ceph',
	'cephfs',
	'fuse.ceph',
	'lustre',
	'glusterfs',
	'gpfs',
	'vboxsf',
	'vmhgfs',
	'prl_fs',
	'nts',
]);

export interface MountEntry {
	/** Absolute mount point (as reported; not realpathed). */
	point: string;
	/** Lowercased filesystem type (e.g. "apfs", "ext4", "nfs"). */
	type: string;
}

/**
 * Parse mount-table text into entries. Unknown line shapes are skipped,
 * never thrown — a partially parseable table still yields what it can.
 */
export function parseMounts(text: string): MountEntry[] {
	const out: MountEntry[] = [];
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;
		// util-linux mount(8): `<dev> on <point> type <fstype> (<opts>)`
		let m = line.match(/^(\S+) on (.+) type (\S+) \(/);
		if (m) {
			out.push({ point: m[2], type: m[3].toLowerCase() });
			continue;
		}
		// macOS mount(8): `<dev> on <point> (<fstype>, <opts>…)` — the first
		// token inside the parens is the filesystem type.
		m = line.match(/^(\S+) on (.+) \(([a-z][\w.-]*)[,)]/i);
		if (m) {
			out.push({ point: m[2], type: m[3].toLowerCase() });
			continue;
		}
		// /proc/self/mounts: `<dev> <point> <fstype> <opts> <freq> <pass>`
		m = line.match(/^(\S+) (\S+) (\S+) \S+ \d+ \d+$/);
		if (m) {
			out.push({ point: m[2], type: m[3].toLowerCase() });
		}
	}
	return out;
}

/** Read the raw mount table: /proc/self/mounts on Linux, `mount` elsewhere. */
export function collectMountTable(): string {
	if (process.platform === 'linux') {
		try {
			return fs.readFileSync('/proc/self/mounts', 'utf8');
		} catch {
			// fall through to the command below
		}
	}
	try {
		return execFileSync('mount', { encoding: 'utf8', timeout: 10_000 });
	} catch {
		return '';
	}
}

/** Module-level cache: the mount table is read once per process. */
let cachedMounts: MountEntry[] | undefined;

/** The parsed mount table (cached; refreshable in tests via resetMounts). */
export function mountTable(): MountEntry[] {
	cachedMounts ??= parseMounts(collectMountTable());
	return cachedMounts;
}

/** Drop the mount-table cache (test seam). */
export function resetMountCache(): void {
	cachedMounts = undefined;
}

/**
 * Prime the mount-table cache with a fixed table (test seam / embedder
 * override) — skips collection on first use. Pair with resetMountCache().
 */
export function setMountTable(entries: MountEntry[]): void {
	cachedMounts = entries;
}

/**
 * The filesystem type governing `target`: the mount point with the longest
 * prefix match wins (standard resolution, same order mount(8) reports in).
 * Returns undefined when no mount point matches (fail-open at the caller).
 */
export function mountTypeFor(target: string, mounts: MountEntry[]): string | undefined {
	// realpath, not plain resolve: mount tables report canonical paths, and a
	// symlinked target (e.g. /var -> /private/var on macOS) would otherwise
	// never match its own mount point.
	let real: string;
	try {
		real = fs.realpathSync(target);
	} catch {
		real = path.resolve(target);
	}
	let best: MountEntry | undefined;
	for (const entry of mounts) {
		// the root mount point is '/' — the suffix concat would make '//'
		const covered =
			entry.point === '/' || real === entry.point || real.startsWith(entry.point + '/');
		if (!covered) continue;
		if (!best || entry.point.length > best.point.length) best = entry;
	}
	return best?.type;
}

/**
 * Is the filesystem holding `target` a network filesystem? Longest-prefix
 * resolution against the (cached) mount table; fail-open on any collection
 * or resolution failure.
 */
export function isNetworkFsRoot(target: string, mounts: MountEntry[] = mountTable()): boolean {
	const type = mountTypeFor(target, mounts);
	return type !== undefined && NETWORK_FS_TYPES.has(type);
}
