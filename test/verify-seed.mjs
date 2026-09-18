#!/usr/bin/env node
/**
 * Worktree seeding contract (src/core/seed.ts):
 *   - worktreeMainRoot: gitfile parsing for plain-repo worktrees and
 *     submodule worktrees; normal repos / missing gitfiles → undefined
 *   - seedWorktreeIndex: copies the main base index into the worktree and
 *     rewrites manifest rootPaths to the worktree (realpath); skips with a
 *     reason when not a worktree, no base, or already indexed; never throws
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-zvec-grep-seed-'));

try {
	const mod = await import(`../src/core/seed.ts?seed-test=${Date.now()}`);
	const { seedWorktreeIndex, worktreeMainRoot } = mod;

	/** A main repo with a base index, plus a linked worktree dir. */
	const makeBase = () => {
		const main = path.join(home, `main-${Math.random().toString(36).slice(2, 8)}`);
		fs.mkdirSync(path.join(main, '.git'), { recursive: true });
		fs.mkdirSync(path.join(main, '.zvec-grep'), { recursive: true });
		fs.writeFileSync(path.join(main, '.zvec-grep', 'manifest.json'), JSON.stringify({
			manifestVersion: 1,
			rootPaths: [{ absolutePath: main, recursive: true }],
		}));
		fs.writeFileSync(path.join(main, '.zvec-grep', 'index.zvec'), 'base-index-blob');
		return main;
	};
	const makeWorktree = (main, name = 'wt') => {
		const wt = path.join(home, `wt-${name}-${Math.random().toString(36).slice(2, 8)}`);
		fs.mkdirSync(wt, { recursive: true });
		fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${main}/.git/worktrees/${name}\n`);
		return wt;
	};

	// --- worktreeMainRoot -------------------------------------------------------
	{
		const main = makeBase();
		const wt = makeWorktree(main);
		assert.equal(worktreeMainRoot(wt), main, 'plain-repo worktree → the main checkout root');

		// submodule worktree: gitdir <main>/.git/modules/<sub>/worktrees/<n>
		const subWt = path.join(home, `subwt-${Math.random().toString(36).slice(2, 8)}`);
		fs.mkdirSync(subWt, { recursive: true });
		fs.writeFileSync(path.join(subWt, '.git'), `gitdir: ${main}/.git/modules/triton-inference/worktrees/x\n`);
		assert.equal(worktreeMainRoot(subWt), path.join(main, 'triton-inference'), 'submodule worktree → the submodule checkout inside the main');

		assert.equal(worktreeMainRoot(main), undefined, 'a normal repo (.git dir) is not a worktree');
		const noGit = path.join(home, `plain-${Math.random().toString(36).slice(2, 8)}`);
		fs.mkdirSync(noGit, { recursive: true });
		assert.equal(worktreeMainRoot(noGit), undefined, 'no .git at all → undefined');
		const badGit = path.join(home, `bad-${Math.random().toString(36).slice(2, 8)}`);
		fs.mkdirSync(badGit, { recursive: true });
		fs.writeFileSync(path.join(badGit, '.git'), 'not a gitfile\n');
		assert.equal(worktreeMainRoot(badGit), undefined, 'unparsable gitfile → undefined');
	}

	// --- seedWorktreeIndex: the happy path -------------------------------------
	{
		const main = makeBase();
		const wt = makeWorktree(main);
		const outcome = seedWorktreeIndex(wt);
		assert.deepEqual(outcome, { seeded: true }, 'seeds from the main base');
		assert.equal(fs.readFileSync(path.join(wt, '.zvec-grep', 'index.zvec'), 'utf8'), 'base-index-blob', 'index files copied');
		const manifest = JSON.parse(fs.readFileSync(path.join(wt, '.zvec-grep', 'manifest.json'), 'utf8'));
		assert.equal(manifest.rootPaths[0].absolutePath, fs.realpathSync(wt), 'rootPaths rewritten to the worktree (realpath)');
		assert.equal(manifest.rootPaths[0].recursive, true, 'recursive flag preserved');
		assert.ok(!fs.existsSync(path.join(main, '.zvec-grep', 'locks')), 'main base untouched');
	}

	// --- skip reasons ------------------------------------------------------------
	{
		const main = makeBase();
		const wt = makeWorktree(main);
		const first = seedWorktreeIndex(wt);
		assert.equal(first.seeded, true, 'first seed works');
		const second = seedWorktreeIndex(wt);
		assert.equal(second.seeded, false, 'second seed skips');
		assert.match(second.skipped ?? '', /already indexed/);

		const noBaseMain = path.join(home, `nobase-${Math.random().toString(36).slice(2, 8)}`);
		fs.mkdirSync(path.join(noBaseMain, '.git'), { recursive: true });
		const wt2 = makeWorktree(noBaseMain, 'nobase');
		const noBase = seedWorktreeIndex(wt2);
		assert.equal(noBase.seeded, false, 'main without a base index → skip');
		assert.match(noBase.skipped ?? '', /no base index/);

		const plain = path.join(home, `plainseed-${Math.random().toString(36).slice(2, 8)}`);
		fs.mkdirSync(plain, { recursive: true });
		const notWt = seedWorktreeIndex(plain);
		assert.equal(notWt.seeded, false, 'non-worktree → skip');
		assert.match(notWt.skipped ?? '', /not a worktree/);
	}

	// --- residue without a manifest is cleared before copying -------------------
	{
		const main = makeBase();
		const wt = makeWorktree(main, 'residue');
		fs.mkdirSync(path.join(wt, '.zvec-grep', 'locks'), { recursive: true });
		fs.writeFileSync(path.join(wt, '.zvec-grep', 'locks', 'autoindex.lock'), 'stale\n');
		const outcome = seedWorktreeIndex(wt);
		assert.equal(outcome.seeded, true, 'residue (locks, no manifest) does not block seeding');
		assert.ok(fs.existsSync(path.join(wt, '.zvec-grep', 'manifest.json')), 'seeded manifest present');
	}

	console.log('All seed assertions passed.');
} finally {
	fs.rmSync(home, { recursive: true, force: true });
}
