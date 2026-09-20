#!/usr/bin/env node
/**
 * Network-filesystem detection contract (src/core/netfs.ts + its use in
 * the root policy):
 *   - parseMounts accepts Linux mount(8), macOS mount(8) and /proc/self/mounts
 *     shapes; junk lines are skipped, never fatal
 *   - mountTypeFor resolves by LONGEST mount-point prefix
 *   - isNetworkFsRoot: network types flag, local types and unknown roots
 *     fail open
 *   - the root policy blocks indexing on network roots (kind 'network')
 *     unless allowNetworkFs / an allowRoots entry explicitly allows it
 * All hermetic: the mount table is primed via setMountTable, no real
 * network mounts (or even a real mount command) needed.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-zvec-grep-netfs-'));

try {
	// plain (non-cache-busted) imports: the root-policy integration below
	// primes the mount-table cache in the SAME netfs module instance that
	// root-policy imports — a query-stringed import would be a second,
	// disconnected instance with its own cache.
	const netfs = await import('../src/core/netfs.ts');
	const { parseMounts, mountTypeFor, isNetworkFsRoot, NETWORK_FS_TYPES, setMountTable, resetMountCache } = netfs;
	const policyMod = await import('../src/core/root-policy.ts');

	// --- parseMounts: the three real-world shapes ----------------------------
	{
		const parsed = parseMounts(
			[
				'/dev/disk1s1 on / (apfs, sealed, local, read-only, journaled)',
				'//user@server/share on /Volumes/share (smbfs, owner:...)',
				'server:/export on /mnt/nfs (nfs, resvport, nodev)',
				'/dev/sda1 on /boot type ext4 (rw,relatime)',
				'server:/export /proc/shape/nfs nfs4 rw,relatime 0 0',
				'this line is junk',
				'',
			].join('\n'),
		);
		assert.deepEqual(
			parsed.map((m) => [m.point, m.type]),
			[
				['/', 'apfs'],
				['/Volumes/share', 'smbfs'],
				['/mnt/nfs', 'nfs'],
				['/boot', 'ext4'],
				['/proc/shape/nfs', 'nfs4'],
			],
			'parses macOS, Linux mount(8) and /proc/self/mounts shapes; junk skipped',
			JSON.stringify(parsed),
		);
	}

	// --- mountTypeFor: longest prefix wins ------------------------------------
	{
		const table = parseMounts(
			[
				'/dev/disk1s1 on / (apfs, local)',
				'//u@s/data on /Volumes/data (smbfs, owner:...)',
				'server:/x on /Volumes/data/deep/export (nfs)',
			].join('\n'),
		);
		assert.equal(mountTypeFor('/Volumes/data/file.bin', table), 'smbfs');
		assert.equal(mountTypeFor('/Volumes/data/deep/export/file', table), 'nfs', 'deeper mount point wins');
		assert.equal(mountTypeFor('/System', table), 'apfs');
		assert.equal(
			mountTypeFor('/nonexistent-root/x', [{ point: '/mnt/x', type: 'nfs' }]),
			undefined,
			'no match → undefined (caller fails open)',
		);
	}

	// --- isNetworkFsRoot -------------------------------------------------------
	{
		const table = [
			{ point: '/', type: 'apfs' },
			{ point: '/mnt/nfs', type: 'nfs' },
			{ point: '/mnt/sshfs', type: 'fuse.sshfs' },
		];
		assert.equal(isNetworkFsRoot('/mnt/nfs/work', table), true, 'nfs root flagged');
		assert.equal(isNetworkFsRoot('/mnt/sshfs/work', table), true, 'fuse.sshfs flagged');
		assert.equal(isNetworkFsRoot('/Users/x/work', table), false, 'local root not flagged');
		assert.equal(isNetworkFsRoot('/no/mount/matches', table), false, 'unknown mount fails open');
		assert.ok(NETWORK_FS_TYPES.has('cifs') && NETWORK_FS_TYPES.has('nfs4'), 'core network types present');
	}

	// --- root policy integration -----------------------------------------------
	{
		const nfsRoot = path.join(home, 'on-nfs');
		fs.mkdirSync(nfsRoot, { recursive: true }); // realpath needs it to exist
		setMountTable([
			{ point: '/', type: 'apfs' },
			// realpath: assessRoot resolves its roots, and on macOS the
			// tmpdir is a symlink (/var -> /private/var) — a non-realpathed
			// mount point would never match
			{ point: fs.realpathSync(nfsRoot), type: 'nfs' },
		]);
		const blocked = policyMod.assessRoot(nfsRoot, policyMod.DEFAULT_ROOT_POLICY);
		assert.equal(blocked.allowed, false, 'network root blocked by default');
		assert.equal(blocked.kind, 'network', 'block kind is network');
		assert.match(blocked.reason ?? '', /network filesystem/i);
		assert.match(blocked.reason ?? '', /allowNetworkFs/, 'reason mentions the escape hatch');

		const allowed = policyMod.assessRoot(nfsRoot, { ...policyMod.DEFAULT_ROOT_POLICY, allowNetworkFs: true });
		assert.equal(allowed.allowed, true, 'allowNetworkFs unblocks network roots');

		const viaAllowRoots = policyMod.assessRoot(nfsRoot, {
			...policyMod.DEFAULT_ROOT_POLICY,
			allowRoots: [nfsRoot],
		});
		assert.equal(viaAllowRoots.allowed, true, 'an explicit allowRoots entry beats the network rule');

		assert.equal(policyMod.DEFAULT_ROOT_POLICY.allowNetworkFs, false, 'default policy: network indexing off');
		assert.equal(policyMod.assessRoot(path.join(home, 'local'), policyMod.DEFAULT_ROOT_POLICY).allowed, true, 'local roots unaffected');

		// home rule still wins over everything
		assert.equal(policyMod.assessRoot(os.homedir(), { ...policyMod.DEFAULT_ROOT_POLICY, allowNetworkFs: true }).allowed, false, 'allowNetworkFs never unlocks $HOME');
	}

	console.log('All netfs assertions passed.');
} finally {
	// plain import = the same instance the test primed
	(await import('../src/core/netfs.ts')).resetMountCache();
	fs.rmSync(home, { recursive: true, force: true });
}
