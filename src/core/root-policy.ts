/**
 * Root policy: which workspace roots may be indexed, and why not.
 *
 * Two root classes are rejected *before* any `zg` invocation:
 *
 * - `$HOME` — a home-rooted index makes every later `zg` call stat the whole
 *   home tree to compute freshness (status/query appear to hang for minutes
 *   from any directory under $HOME). This exact failure disabled zvec for
 *   every profile for days once.
 * - Umbrella roots — a root whose shallow tree contains several nested git
 *   repos (submodule-style checkouts like an umbrella repo or a `~/code`
 *   directory of repos). zg 0.2.x hard-skips nested repos when indexing
 *   (even `--no-ignore` and explicit globs cannot include them), so an
 *   umbrella index can only ever contain the handful of root-level files —
 *   near-empty noise that also *shadows* real indexes: zg resolves the
 *   nearest ancestor with an index, so sessions inside a submodule would
 *   resolve up to the umbrella stub instead of building their own.
 *
 * `allowRoots` is the explicit escape hatch (a root that trips the
 * nested-repo heuristic but should be indexed anyway — knowing zg will
 * still skip the nested repos, only the root-level files get indexed).
 *
 * Pi-free by design (same rule as the rest of `src/core/`): plain node:fs
 * only, loadable under `node --experimental-strip-types` for the hermetic
 * test suite.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

/** Persisted policy shape (the `rootPolicy` settings field). */
export interface RootPolicy {
	/** Roots (absolute, or `~/…`) that bypass the nested-repo check. */
	allowRoots: string[];
	/** ≥ this many nested git repos (depth ≤ 2) marks an umbrella root. */
	maxNestedRepos: number;
}

export const DEFAULT_ROOT_POLICY: RootPolicy = {
	allowRoots: [],
	maxNestedRepos: 3,
};

/** Verdict for one candidate root. `reason` is set iff `allowed` is false. */
export interface RootAssessment {
	allowed: boolean;
	reason?: string;
}

/** Realpath with a fallback: non-existent paths still resolve usefully. */
function bestRealPath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

/** Expand a leading `~` to the home directory. */
export function expandTilde(s: string): string {
	if (s === '~') return homedir();
	if (s.startsWith('~/')) return path.join(homedir(), s.slice(2));
	return s;
}

/**
 * Does one directory contain a `.git` entry (dir OR file — worktrees and
 * submodules use a `.git` file)? Best-effort: unreadable → false.
 */
function isGitDir(dir: string): boolean {
	try {
		fs.statSync(path.join(dir, '.git'));
		return true;
	} catch {
		return false;
	}
}

/** Directory names never descended into while scanning for nested repos. */
const SCAN_SKIP = new Set(['.git', '.zvec-grep', 'node_modules', '.venv', 'venv', '__pycache__', '.cache']);

/**
 * Count distinct git repos nested under `root` at depth ≤ 2 (the root itself
 * never counts). Bounded: the scan stops early once `stopAfter` repos are
 * found (callers only compare against a threshold) and gives up entirely
 * after `entryBudget` directory entries, so a pathological tree can never
 * turn a policy check into a walk.
 */
export function countNestedRepos(root: string, stopAfter = Number.POSITIVE_INFINITY, entryBudget = 2000): number {
	let found = 0;
	let entries = 0;
	const hit = (): boolean => {
		found += 1;
		return found >= stopAfter;
	};
	let level1: fs.Dirent[];
	try {
		level1 = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const child of level1) {
		if (!child.isDirectory() || SCAN_SKIP.has(child.name)) continue;
		entries += 1;
		if (entries > entryBudget) return found;
		const childPath = path.join(root, child.name);
		if (isGitDir(childPath)) {
			if (hit()) return found;
			continue; // a nested repo's own children are its content, not ours
		}
		let level2: fs.Dirent[];
		try {
			level2 = fs.readdirSync(childPath, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const grandchild of level2) {
			if (!grandchild.isDirectory() || SCAN_SKIP.has(grandchild.name)) continue;
			entries += 1;
			if (entries > entryBudget) return found;
			if (isGitDir(path.join(childPath, grandchild.name))) {
				if (hit()) return found;
			}
		}
	}
	return found;
}

/**
 * Assess one candidate index root against the policy. Pure: no zg calls, no
 * writes. The home comparison and `allowRoots` matching are realpath-based
 * so `~`, symlinks, and trailing differences cannot sneak a root through.
 */
export function assessRoot(root: string, policy: RootPolicy = DEFAULT_ROOT_POLICY): RootAssessment {
	const realRoot = bestRealPath(path.resolve(expandTilde(root)));
	const realHome = bestRealPath(homedir());
	if (realRoot === realHome) {
		return {
			allowed: false,
			reason:
				'root is $HOME: a home-rooted index makes every zg call stat the entire home tree ' +
				'(status/query appear to hang for minutes); this exact failure disabled zvec once before',
		};
	}
	for (const allowed of policy.allowRoots) {
		if (bestRealPath(path.resolve(expandTilde(allowed))) === realRoot) return { allowed: true };
	}
	const threshold = Math.max(1, Math.round(policy.maxNestedRepos) || DEFAULT_ROOT_POLICY.maxNestedRepos);
	const nested = countNestedRepos(realRoot, threshold);
	if (nested >= threshold) {
		return {
			allowed: false,
			reason:
				`root is an umbrella workspace: ${nested}+ nested git repos at depth ≤ 2, and zg cannot index ` +
				'nested repos (only root-level files would be indexed, and the stub index shadows real ' +
				'leaf-repo indexes for sessions below it). Search still works via fts/--rg without an index; ' +
				`to index anyway add this root to rootPolicy.allowRoots in the pi-zvec-grep config`,
		};
	}
	return { allowed: true };
}
