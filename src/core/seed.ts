/**
 * Worktree index seeding — copy a main checkout's base `.zvec-grep` index into
 * one of its worktrees so a fresh worktree has turn-1 search, then let the
 * normal auto-index update/rebuild bring it in sync ("update as we go").
 *
 * The workflow this serves (verified against zg 0.2.2):
 *   - The user keeps base indexes on the MAIN checkouts (reindexed by their
 *     own command after pulls).
 *   - Fresh git worktrees start with no index; building from scratch costs
 *     minutes. Copying the main repo's index + rewriting the manifest's
 *     rootPaths to the worktree makes it immediately searchable (zg prints
 *     paths relative to the workspace root), and the next `zg index <root>`
 *     updates it in place. zg honors an EXPLICIT root argument — it never
 *     walks up past it — so a worktree build can never write back into the
 *     main checkout's index.
 *
 * Pi-free by design (same rule as the rest of `src/core/`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Skip seeding when the base index is larger than this (sanity cap). */
export const MAX_SEED_BYTES = 2_000_000_000;

/** gitfile patterns → the main checkout root that owns the worktree. */
const WORKTREE_GITDIR = /^(.*)\/\.git\/worktrees\/[^/]+$/;
const SUBMODULE_WORKTREE_GITDIR = /^(.*)\/\.git\/modules\/([^/]+)\/worktrees\/[^/]+$/;

/**
 * The main checkout root behind a worktree root, when `root` IS a worktree
 * (its `.git` is a FILE). Handles both shapes:
 *   `<main>/.git/worktrees/<name>`            → `<main>`
 *   `<main>/.git/modules/<sub>/worktrees/<n>` → `<main>/<sub>` (a submodule's
 *   own worktree; the base index lives at the submodule checkout)
 * Undefined for normal repos, missing gitfiles, or unparsable contents.
 */
export function worktreeMainRoot(root: string): string | undefined {
	const gitfile = path.join(root, '.git');
	let stat;
	try {
		stat = fs.statSync(gitfile);
	} catch {
		return undefined;
	}
	if (stat.isDirectory()) return undefined; // normal repo, not a worktree
	let text: string;
	try {
		text = fs.readFileSync(gitfile, 'utf8');
	} catch {
		return undefined;
	}
	const m = text.match(/^gitdir:\s*(\S+)/);
	if (!m) return undefined;
	const gitdir = m[1];
	const sub = gitdir.match(SUBMODULE_WORKTREE_GITDIR);
	if (sub) return path.join(sub[1], sub[2]);
	const plain = gitdir.match(WORKTREE_GITDIR);
	if (plain) return plain[1];
	return undefined;
}

export interface SeedOutcome {
	/** Seeded — the worktree now holds a copied base index. */
	seeded: boolean;
	/** Why not, when `seeded` is false (never an error — seeding is optional). */
	skipped?: string;
}

/**
 * Seed `<root>/.zvec-grep` from the main checkout's base index. No-op (with a
 * reason) when `root` is not a worktree, the main repo has no index, or the
 * base is oversized. Any residue at `<root>/.zvec-grep` without a manifest is
 * cleared first. Never throws — a failed seed just falls through to a normal
 * from-scratch build.
 */
export function seedWorktreeIndex(root: string): SeedOutcome {
	try {
		const main = worktreeMainRoot(root);
		if (!main) return { seeded: false, skipped: 'not a worktree' };
		const mainIndex = path.join(main, '.zvec-grep');
		const mainManifest = path.join(mainIndex, 'manifest.json');
		if (!fs.existsSync(mainManifest)) return { seeded: false, skipped: `no base index at ${main}` };
		const target = path.join(root, '.zvec-grep');
		const targetManifest = path.join(target, 'manifest.json');
		if (fs.existsSync(targetManifest)) return { seeded: false, skipped: 'worktree already indexed' };
		const baseBytes = dirSize(mainIndex);
		if (baseBytes > MAX_SEED_BYTES) {
			return { seeded: false, skipped: `base index too large to copy (${baseBytes} bytes)` };
		}
		// Drop non-index residue (locks/, models/ leftovers) before copying.
		fs.rmSync(target, { recursive: true, force: true });
		fs.cpSync(mainIndex, target, { recursive: true });
		rewriteManifestRoot(target, main, root);
		return { seeded: true };
	} catch (error) {
		return { seeded: false, skipped: `seed failed: ${String((error as Error)?.message ?? error)}` };
	}
}

/** Total size of a directory tree, 0 when unreadable. */
function dirSize(dir: string): number {
	let total = 0;
	const walk = (d: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const p = path.join(d, entry.name);
			if (entry.isDirectory()) walk(p);
			else {
				try {
					total += fs.statSync(p).size;
				} catch {}
			}
		}
	};
	walk(dir);
	return total;
}

/**
 * Point the copied manifest at the worktree: every rootPath whose
 * absolutePath referenced the main checkout is rewritten to the worktree
 * root (realpath), preserving the recursive flag. Best-effort — a manifest
 * without matching rootPaths is left as-is (zg still treats the copied
 * index as an index at this root).
 */
function rewriteManifestRoot(target: string, main: string, root: string): void {
	const file = path.join(target, 'manifest.json');
	let manifest: { rootPaths?: Array<{ absolutePath?: string; recursive?: boolean }> };
	try {
		manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return;
	}
	let changed = false;
	const mainReal = bestEffortReal(main);
	const rootReal = bestEffortReal(root);
	for (const rp of manifest.rootPaths ?? []) {
		if (typeof rp?.absolutePath === 'string' && bestEffortReal(rp.absolutePath) === mainReal) {
			rp.absolutePath = rootReal;
			changed = true;
		}
	}
	if (!changed) return;
	try {
		fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
	} catch {}
}

function bestEffortReal(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}
