#!/usr/bin/env node
/**
 * Root policy contract (src/core/root-policy.ts + the lock in workspace.ts):
 *   - $HOME is always blocked
 *   - umbrella roots (several nested git repos at depth ≤ 2, dir OR file
 *     `.git` entries — worktree/submodule style) are blocked at the
 *     configured threshold; a plain repo with one or two nested repos passes
 *   - allowRoots bypasses the nested-repo block (realpath + `~` matching)
 *   - the scan is bounded (never a full tree walk) and skips known-noise dirs
 *   - acquireAutoIndexLock: exclusive across "processes" (second acquire
 *     fails while held), released cleanly, stale locks are stolen
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-zvec-grep-rootpolicy-'));

try {
	const mod = await import(`../src/core/root-policy.ts?rootpolicy-test=${Date.now()}`);
	const { assessRoot, countNestedRepos, expandTilde, DEFAULT_ROOT_POLICY } = mod;
	const ws = await import(`../src/core/workspace.ts?rootpolicy-test=${Date.now()}`);
	const { acquireAutoIndexLock } = ws;

	// --- expandTilde -----------------------------------------------------------
	assert.equal(expandTilde('~/x'), path.join(os.homedir(), 'x'));
	assert.equal(expandTilde('~'), os.homedir());
	assert.equal(expandTilde('/abs/x'), '/abs/x');

	// --- tree fixtures ---------------------------------------------------------
	/** A workspace with `repoCount` nested git repos (dirs with `.git` dirs). */
	const makeUmbrella = (name, repoCount, gitStyle = 'dir') => {
		const root = path.join(home, name);
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(path.join(root, 'README.md'), 'umbrella root file\n');
		for (let i = 0; i < repoCount; i += 1) {
			const repo = path.join(root, `sub${i}`);
			fs.mkdirSync(repo, { recursive: true });
			fs.writeFileSync(path.join(repo, 'code.ts'), `content of sub${i}\n`);
			if (gitStyle === 'dir') fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
			else fs.writeFileSync(path.join(repo, '.git'), `gitdir: /elsewhere/worktree-${i}\n`);
		}
		return root;
	};

	// depth-1 nested repos: three and more → umbrella; two → allowed
	assert.equal(countNestedRepos(makeUmbrella('umb3', 3)), 3, 'three nested repos counted');
	assert.equal(countNestedRepos(makeUmbrella('umb2', 2)), 2, 'two nested repos counted');
	assert.equal(countNestedRepos(makeUmbrella('umbfile', 3, 'file')), 3, 'worktree-style `.git` files count as repos');

	// depth-2: repos live under intermediate dirs (~/code layout)
	const deepRoot = path.join(home, 'deep');
	fs.mkdirSync(path.join(deepRoot, 'mtv'), { recursive: true });
	for (const n of ['a', 'b', 'c']) fs.mkdirSync(path.join(deepRoot, 'mtv', n, '.git'), { recursive: true });
	assert.equal(countNestedRepos(deepRoot), 3, 'depth-2 nested repos counted');

	// scan skips noise dirs and never descends into a found repo
	const noisy = path.join(home, 'noisy');
	fs.mkdirSync(path.join(noisy, 'node_modules', 'dep', '.git'), { recursive: true });
	fs.mkdirSync(path.join(noisy, '.zvec-grep'), { recursive: true });
	fs.writeFileSync(path.join(noisy, 'root.txt'), 'plain\n');
	assert.equal(countNestedRepos(noisy), 0, 'node_modules/.zvec-grep skipped');
	const repoInside = makeUmbrella('one-repo', 1);
	fs.mkdirSync(path.join(repoInside, 'sub0', 'inner', '.git'), { recursive: true });
	assert.equal(countNestedRepos(repoInside), 1, 'a found repo is not descended into (inner .git ignored)');

	// bounded scan: a huge flat tree cannot turn the check into a walk
	const wide = path.join(home, 'wide');
	fs.mkdirSync(wide, { recursive: true });
	for (let i = 0; i < 500; i += 1) fs.mkdirSync(path.join(wide, `d${i}`), { recursive: true });
	assert.ok(countNestedRepos(wide) === 0, 'wide tree: no repos, scan completes');

	// --- assessRoot ------------------------------------------------------------
	assert.equal(assessRoot(os.homedir()).allowed, false, '$HOME blocked');
	assert.match(assessRoot(os.homedir()).reason ?? '', /HOME/, 'home block carries a reason');

	assert.equal(assessRoot(makeUmbrella('ok2', 2)).allowed, true, 'two nested repos: allowed (threshold 3)');
	const blocked = assessRoot(makeUmbrella('blocked', 4));
	assert.equal(blocked.allowed, false, 'four nested repos: umbrella → blocked');
	assert.match(blocked.reason ?? '', /umbrella/, 'umbrella block carries a reason');
	assert.match(blocked.reason ?? '', /allowRoots/, 'reason mentions the escape hatch');

	// threshold is configurable
	assert.equal(assessRoot(makeUmbrella('thresh', 2), { allowRoots: [], maxNestedRepos: 2 }).allowed, false, 'threshold 2 blocks two repos');

	// allowRoots bypass: exact path, with ~, and via realpath
	const umbrella = makeUmbrella('allowed', 5);
	assert.equal(assessRoot(umbrella, { allowRoots: [umbrella], maxNestedRepos: 3 }).allowed, true, 'exact allowRoots entry bypasses');
	assert.equal(assessRoot(fs.realpathSync(umbrella), { allowRoots: [umbrella], maxNestedRepos: 3 }).allowed, true, 'realpath matching');
	// a symlinked allowRoots entry matches the real root it points to
	const link = path.join(home, 'link-to-allowed');
	fs.symlinkSync(umbrella, link);
	assert.equal(assessRoot(umbrella, { allowRoots: [link], maxNestedRepos: 3 }).allowed, true, 'symlinked allowRoots entry matches its target');
	// `~`-prefixed entries are supported the same way (expandTilde, unit-tested above)
	// allowRoots does NOT bypass the $HOME rule
	assert.equal(assessRoot(os.homedir(), { allowRoots: ['~'], maxNestedRepos: 3 }).allowed, false, 'allowRoots never unlocks $HOME');

	// default policy object shape
	assert.deepEqual(DEFAULT_ROOT_POLICY, { allowRoots: [], maxNestedRepos: 3 }, 'default policy: empty allowlist, threshold 3');

	// --- acquireAutoIndexLock --------------------------------------------------
	const lockRoot = path.join(home, 'lockroot');
	fs.mkdirSync(lockRoot, { recursive: true });
	const lock = acquireAutoIndexLock(lockRoot);
	assert.ok(lock, 'lock acquired on a fresh root');
	assert.equal(acquireAutoIndexLock(lockRoot), undefined, 'second acquire while held: undefined (skip)');
	lock?.release();
	assert.ok(acquireAutoIndexLock(lockRoot), 'after release the lock is free again');
	const again = acquireAutoIndexLock(lockRoot);
	again?.release();
	again?.release(); // idempotent

	// stale lock (older than 10 min) is stolen
	const staleRoot = path.join(home, 'staleroot');
	const lockDir = path.join(staleRoot, '.zvec-grep', 'locks');
	fs.mkdirSync(lockDir, { recursive: true });
	const staleFile = path.join(lockDir, 'autoindex.lock');
	fs.writeFileSync(staleFile, '9999\n2026-01-01T00:00:00.000Z\n');
	const old = new Date(Date.now() - 11 * 60_000);
	fs.utimesSync(staleFile, old, old);
	assert.ok(acquireAutoIndexLock(staleRoot), 'stale lock stolen after 10 minutes');

	// a locked dir never throws, just skips
	const deniedDir = path.join(home, 'denied');
	fs.mkdirSync(deniedDir, { recursive: true });
	fs.chmodSync(deniedDir, 0o500); // no write permission
	try {
		assert.equal(acquireAutoIndexLock(deniedDir), undefined, 'unwritable root: skip, never throw');
	} finally {
		fs.chmodSync(deniedDir, 0o700);
	}

	console.log('All root-policy assertions passed.');
} finally {
	fs.rmSync(home, { recursive: true, force: true });
}
