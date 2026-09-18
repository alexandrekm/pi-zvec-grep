#!/usr/bin/env node
/**
 * Behavior contract for the session-start auto-index hook (setting:
 * `autoIndex`, off by default):
 *   - hook is registered on `session_start` and runs for every reason
 *   - root resolution: the NEAREST ENCLOSING GIT REPO of the cwd (`.git` dir
 *     or worktree gitfile), falling back to the cwd — a session in a repo
 *     subdir indexes the repo root, never a per-subdir stub
 *   - own-manifest gate: an own index at the root is guarded by
 *     `zg status --check-ready`; a MISSING own manifest builds directly
 *     (an ancestor's "ready" must never suppress a leaf build — that is
 *     the shadowing failure that froze every repo under a mega-index)
 *   - worktree seeding: a worktree without an index is seeded from its main
 *     checkout's base index (manifest rootPaths rewritten to the worktree)
 *     before the background build; the build argv always pins the WORKTREE
 *     root — it never targets the main checkout
 *   - not ready + autoIndex on → fire-and-forget `zg index <root>`; the hook
 *     itself resolves while the build is still running
 *   - in-flight: concurrent starts in the same cwd yield a single build;
 *     different cwds are independent roots; slot releases after completion
 *   - root policy: umbrella/container roots are never auto-indexed (skip
 *     notice, no index call); allowRoots re-enables one specific root
 *   - cross-process lock: a held lockfile suppresses the build; a stale
 *     lock is stolen
 *   - autoIndex off / missing → nothing runs
 *   - build failure → error notification path, no throw out of the hook
 * Uses the fake zg + fake pi harness like verify-settings.mjs.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-zvec-grep-autoindex-'));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = path.join(home, '.pi', 'agent');
process.env.ZFAKE_INDEX_SLEEP = '1';

try {
	const { userConfigFile, DEFAULT_SETTINGS } = await import(`../src/extension/config.ts?autoindex-test=${Date.now()}`);
	const { createFakeZg } = await import('./helpers/fake-zg.mjs');
	const { createFakePi, makeCtx, registerSurface } = await import('./helpers/pi-harness.mjs');

	const fake = createFakeZg(home);
	const { pi, calls } = createFakePi({ binDir: fake.binDir, stateDir: fake.stateDir });
	await registerSurface(pi, { includeAutoIndex: true });

	// The hook is part of the surface: exactly one session_start registration.
	assert.ok(calls.events.includes('session_start'), 'session_start handler is registered');
	assert.equal(calls.events.filter((e) => e === 'session_start').length, 1, 'exactly one session_start handler');

	const setAutoIndex = (b) => {
		fs.mkdirSync(path.join(home, '.pi', 'agent', 'pi-zvec-grep'), { recursive: true });
		fs.writeFileSync(userConfigFile(), JSON.stringify({ ...DEFAULT_SETTINGS, autoIndex: b }));
	};
	/** Mark a root as having its own index (manifest is the canonical marker). */
	const giveOwnIndex = (root) => {
		fs.mkdirSync(path.join(root, '.zvec-grep'), { recursive: true });
		fs.writeFileSync(path.join(root, '.zvec-grep', 'manifest.json'), JSON.stringify({ manifestVersion: 1, rootPaths: [] }));
	};
	const settle = (ms) => new Promise((r) => setTimeout(r, ms));

	// --- off (default): the guard never runs ---------------------------------
	{
		fs.mkdirSync(path.join(home, '.pi', 'agent', 'pi-zvec-grep'), { recursive: true });
		fs.writeFileSync(userConfigFile(), JSON.stringify(DEFAULT_SETTINGS)); // explicit off
		const cwd = path.join(home, 'off');
		fs.mkdirSync(cwd, { recursive: true });
		await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, makeCtx({ cwd }));
		await settle(30);
		assert.equal(fake.readState('status'), undefined, 'autoIndex off: no status guard call');
		assert.equal(fake.readState('index'), undefined, 'autoIndex off: no index call');
	}

	// --- missing setting: treated as off, on any reason ----------------------
	{
		fs.rmSync(path.join(home, '.pi', 'agent', 'pi-zvec-grep'), { recursive: true, force: true });
		fake.resetState();
		const cwd = path.join(home, 'missing');
		fs.mkdirSync(cwd, { recursive: true });
		await pi.emit('session_start', { type: 'session_start', reason: 'new' }, makeCtx({ cwd }));
		await settle(30);
		assert.equal(fake.readState('status'), undefined, 'missing setting (reason "new"): no guard — gating is the setting, not the reason');
	}

	// --- own index ready: one status call, no build ---------------------------
	{
		setAutoIndex(true);
		process.env.ZFAKE_MODE = 'ready';
		fake.resetState();
		const cwd = path.join(home, 'ready');
		fs.mkdirSync(cwd, { recursive: true });
		giveOwnIndex(cwd);
		await pi.emit('session_start', { type: 'session_start', reason: 'reload' }, makeCtx({ cwd }));
		let status;
		for (let i = 0; i < 40 && !status; i += 1) {
			await settle(50);
			status = fake.readState('status');
		}
		assert.ok(status, 'autoIndex on + own index: the status guard ran');
		assert.deepEqual(status.args, ['--check-ready'], 'guard argv is `zg status --check-ready`');
		assert.equal(status.cwd, fs.realpathSync(cwd), 'guard cwd is the resolved root (realpath on macOS)');
		await settle(100);
		assert.equal(fake.readState('index'), undefined, 'guard exit 0: no index call');
	}

	// --- NO own manifest + ancestor "ready": build anyway (anti-shadowing) ---
	{
		// ZFAKE_MODE stays 'ready' — a walk-up status would wrongly pass.
		// The own-manifest gate must skip the status call and build directly.
		fake.resetState();
		const cwd = path.join(home, 'shadowed');
		fs.mkdirSync(cwd, { recursive: true });
		await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, makeCtx({ cwd }));
		let index;
		for (let i = 0; i < 40 && !index; i += 1) {
			await settle(50);
			index = fake.readState('index');
		}
		assert.ok(index, 'missing own manifest: build runs even though a walk-up status would say ready');
		assert.equal(index.args[0], cwd, 'build pins the root');
		assert.equal(fake.readState('status'), undefined, 'no status call when the own manifest is missing');
	}

	// --- own index stale: fire-and-forget update ------------------------------
	process.env.ZFAKE_MODE = 'stale-slow';
	{
		fake.resetState();
		const cwd = path.join(home, 'stale');
		fs.mkdirSync(cwd, { recursive: true });
		giveOwnIndex(cwd);
		const started = pi.emit('session_start', { type: 'session_start', reason: 'resume' }, makeCtx({ cwd }));
		assert.deepEqual(await started, [undefined], 'handler returns undefined (no cancel semantics)');
		assert.ok(!fs.existsSync(path.join(fake.stateDir, 'index.json')), 'fire-and-forget: no index recorded immediately after the hook returns');
		await settle(500); // still building (fake sleeps 1s)
		assert.ok(fake.readState('status'), 'the guard ran first (by the time the build is in flight)');
		assert.ok(!fs.existsSync(path.join(fake.stateDir, 'index.json')), 'hook did not await the build: still in flight mid-way');
		await settle(1300); // settle
		const index = fake.readState('index');
		assert.ok(index, 'guard failed: background index finally ran');
		assert.deepEqual(index.args, [cwd], 'index argv pins the root');
		assert.equal(index.cwd, fs.realpathSync(cwd), 'index cwd is the resolved root');
		assert.ok(calls.exec.some((e) => e.command === 'zg' && e.args[0] === 'index' && e.args[1] === cwd && e.options?.timeout === 600_000), 'index carries the ZG_INDEX timeout');
	}

	// --- root resolution: a repo subdir indexes the REPO root -----------------
	{
		process.env.ZFAKE_MODE = 'missing-index';
		fake.resetState();
		const repo = path.join(home, 'therepo');
		fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
		fs.mkdirSync(path.join(repo, 'deep', 'sub'), { recursive: true });
		await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, makeCtx({ cwd: path.join(repo, 'deep', 'sub') }));
		let index;
		for (let i = 0; i < 40 && !index; i += 1) {
			await settle(50);
			index = fake.readState('index');
		}
		assert.ok(index, 'subdir session: build ran');
		assert.equal(index.args[0], repo, 'root resolved to the enclosing git repo, not the cwd');
		assert.ok(fs.existsSync(path.join(repo, '.zvec-grep', 'locks')), 'lock dir created at the repo root');
	}

	// --- worktree: seed from the main base index, build pins the worktree ----
	{
		fake.resetState();
		const main = path.join(home, 'mainrepo');
		fs.mkdirSync(path.join(main, '.git'), { recursive: true });
		fs.mkdirSync(path.join(main, '.zvec-grep'), { recursive: true });
		fs.writeFileSync(path.join(main, '.zvec-grep', 'manifest.json'), JSON.stringify({
			manifestVersion: 1,
			rootPaths: [{ absolutePath: main, recursive: true }],
		}));
		fs.writeFileSync(path.join(main, '.zvec-grep', 'index.zvec'), 'fake-base-index');
		const worktree = path.join(home, 'wt');
		fs.mkdirSync(worktree, { recursive: true });
		fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${main}/.git/worktrees/wt\n`);
		const notices = [];
		await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, makeCtx({ cwd: worktree, ui: { notify: (m, t) => notices.push({ m, t }) } }));
		let index;
		for (let i = 0; i < 40 && !index; i += 1) {
			await settle(50);
			index = fake.readState('index');
		}
		assert.ok(index, 'worktree session: build ran');
		assert.equal(index.args[0], worktree, 'build argv pins the WORKTREE root — never the main checkout');
		const seeded = JSON.parse(fs.readFileSync(path.join(worktree, '.zvec-grep', 'manifest.json'), 'utf8'));
		assert.equal(seeded.rootPaths[0].absolutePath, fs.realpathSync(worktree), 'seeded manifest rootPaths rewritten to the worktree');
		assert.equal(fs.readFileSync(path.join(worktree, '.zvec-grep', 'index.zvec'), 'utf8'), 'fake-base-index', 'base index files copied');
		assert.ok(!fs.existsSync(path.join(main, '.zvec-grep', 'locks')), 'main checkout untouched (no lock dir appears there)');
		assert.ok(notices.some((n) => /seeded/.test(n.m)), 'seed notice shown', notices.map((n) => n.m).join(' | '));
	}

	// --- in-flight: concurrent starts in one cwd → a single build -------------
	{
		process.env.ZFAKE_MODE = 'stale-slow';
		const cwd = path.join(home, 'inflight');
		fs.mkdirSync(cwd, { recursive: true });
		giveOwnIndex(cwd);
		calls.exec.length = 0;
		await Promise.all(
			['startup', 'reload', 'new'].map((reason) => pi.emit('session_start', { type: 'session_start', reason }, makeCtx({ cwd }))),
		);
		await settle(500); // mid-flight
		const buildsMid = calls.exec.filter((e) => e.command === 'zg' && e.args[0] === 'index').length;
		assert.equal(buildsMid, 1, 'mid-flight: exactly one in-flight build');
		await settle(1200); // settle
		const builds = calls.exec.filter((e) => e.command === 'zg' && e.args[0] === 'index');
		assert.equal(builds.length, 1, 'after settling: still a single build');

		// slot released after completion: the next start runs again
		await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, makeCtx({ cwd }));
		await settle(1650);
		const buildsAfter = calls.exec.filter((e) => e.command === 'zg' && e.args[0] === 'index').length;
		assert.equal(buildsAfter, 2, 'slot released: a later start starts a fresh build');
	}

	// --- different cwds are independent roots ---------------------------------
	{
		const a = path.join(home, 'ra');
		const b = path.join(home, 'rb');
		fs.mkdirSync(a, { recursive: true });
		fs.mkdirSync(b, { recursive: true });
		calls.exec.length = 0;
		await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, makeCtx({ cwd: a }));
		await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, makeCtx({ cwd: b }));
		await settle(1650);
		const builds = calls.exec.filter((e) => e.command === 'zg' && e.args[0] === 'index');
		assert.equal(builds.length, 2, 'per-root in-flight: each cwd gets its own build');
		assert.deepEqual(builds.map((e) => e.args[1]).sort(), [a, b].sort(), 'each build pins its own root');
	}

	// --- build failure: no throw out of the hook ------------------------------
	{
		process.env.ZFAKE_MODE = 'fail-index';
		const cwd = path.join(home, 'fail');
		fs.mkdirSync(cwd, { recursive: true });
		let hookError;
		try {
			await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, makeCtx({ cwd }));
		} catch (error) {
			hookError = error;
		}
		assert.equal(hookError, undefined, 'failed build must not reject the session_start emit');
		await settle(300);
		assert.ok(calls.exec.some((e) => e.args[0] === 'index' && e.args[1] === cwd), 'failure path still attempted the build');
	}

	// --- root policy: umbrella roots are never auto-indexed -------------------
	{
		process.env.ZFAKE_MODE = 'missing-index'; // own manifest missing → build would run
		fake.resetState();
		const cwd = path.join(home, 'umbrella');
		fs.mkdirSync(cwd, { recursive: true });
		for (const n of ['a', 'b', 'c']) fs.mkdirSync(path.join(cwd, n, '.git'), { recursive: true });
		const notices = [];
		await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, makeCtx({ cwd, ui: { notify: (m, t) => notices.push({ m, t }) } }));
		await settle(300);
		assert.equal(fake.readState('index'), undefined, 'umbrella root: no index call');
		assert.equal(fake.readState('status'), undefined, 'no status call either — the policy check runs first when the manifest is missing');
		assert.ok(
			notices.some((n) => n.t === 'info' && /skipped/.test(n.m) && /umbrella/.test(n.m)),
			'skip notice explains the umbrella reason',
			notices.map((n) => n.m).join(' | '),
		);
	}

	// --- root policy: allowRoots re-enables one specific root -----------------
	{
		fs.writeFileSync(
			userConfigFile(),
			JSON.stringify({ ...DEFAULT_SETTINGS, autoIndex: true, rootPolicy: { allowRoots: [path.join(home, 'umbrella')], maxNestedRepos: 3 } }),
		);
		fake.resetState();
		const cwd = path.join(home, 'umbrella');
		await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, makeCtx({ cwd }));
		let index;
		for (let i = 0; i < 40 && !index; i += 1) {
			await settle(50);
			index = fake.readState('index');
		}
		assert.ok(index, 'allowRoots: the umbrella root builds when explicitly allowlisted');
		fs.writeFileSync(userConfigFile(), JSON.stringify({ ...DEFAULT_SETTINGS, autoIndex: true }));
	}

	// --- cross-process lock: a held lockfile suppresses the build ------------
	{
		fake.resetState();
		const cwd = path.join(home, 'locked');
		fs.mkdirSync(cwd, { recursive: true });
		giveOwnIndex(cwd); // own index present → status runs, then the lock is checked
		fs.mkdirSync(path.join(cwd, '.zvec-grep', 'locks'), { recursive: true });
		fs.writeFileSync(path.join(cwd, '.zvec-grep', 'locks', 'autoindex.lock'), 'other-pid\n');
		await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, makeCtx({ cwd }));
		await settle(300);
		assert.ok(fake.readState('status'), 'guard ran under a foreign lock');
		assert.equal(fake.readState('index'), undefined, 'lock held by another process: no build');
		// stale lock (backdated 11 min) is stolen and the build proceeds
		const stale = path.join(cwd, '.zvec-grep', 'locks', 'autoindex.lock');
		const old = new Date(Date.now() - 11 * 60_000);
		fs.utimesSync(stale, old, old);
		await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, makeCtx({ cwd }));
		let index;
		for (let i = 0; i < 40 && !index; i += 1) {
			await settle(50);
			index = fake.readState('index');
		}
		assert.ok(index, 'stale lock stolen: build proceeds');
	}

	console.log('All auto-index assertions passed.');
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	delete process.env.ZFAKE_INDEX_SLEEP;
	delete process.env.ZFAKE_MODE;
	fs.rmSync(home, { recursive: true, force: true });
}
