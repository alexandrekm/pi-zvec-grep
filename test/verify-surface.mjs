#!/usr/bin/env node
/**
 * Surface harness: what the LLM and the user actually get.
 *
 * Registers the real index.ts against a fake pi (fake zg on PATH) and asserts:
 *  - tool names, labels, promptSnippet, promptGuidelines
 *  - schema fields per tool and their types
 *  - registered commands
 *  - execute() wiring: argv, cwd routing, signal forwarding, error path
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDirectory, createReporter } from './helpers/test-utils.mjs';
import { createFakeZg } from './helpers/fake-zg.mjs';
import { createFakePi, invokeTool, makeCtx } from './helpers/pi-harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Isolate the config layer (loadSettings reads getAgentDir()) so assertions
// never depend on the real ~/.pi/agent/pi-zvec-grep/config.json.
const agentHome = fs.mkdtempSync(join(os.tmpdir(), 'pi-zvec-grep-surface-agent-'));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(agentHome, '.pi', 'agent');

const root = createTempDirectory('pi-zvec-grep-surface-');
const fake = createFakeZg(root);
const { pi, calls } = createFakePi({ binDir: fake.binDir, stateDir: fake.stateDir });

const { default: piZvecGrep } = await import(join(__dirname, '..', 'index.ts'));
piZvecGrep(pi);

const { assert: check, done } = createReporter();

const tool = (name) => {
	const t = calls.tools.find((x) => x.name === name);
	assert.ok(t, `tool ${name} registered`);
	return t;
};

// --- registration surface ---------------------------------------------------
check(
	calls.tools.map((t) => t.name).sort().join(',') === 'zvec_index,zvec_search,zvec_status',
	'registers exactly zvec_index, zvec_search, zvec_status',
);
check(
	calls.commands.map((c) => c.name).sort().join(',') === 'zg',
	'registers exactly one command: /zg',
);
check(
	calls.events.filter((e) => e === 'session_start').length === 1,
	'registers the auto-index session_start hook',
);
check(
	typeof calls.commands.find((c) => c.name === 'zg')?.def.getArgumentCompletions === 'function',
	'/zg exposes argument completions',
);
const zgCompletions = calls.commands.find((c) => c.name === 'zg')?.def.getArgumentCompletions?.('');
check(
	Array.isArray(zgCompletions) &&
		zgCompletions.map((i) => i.value).sort().join(',') === 'drop,help,index,rebuild,settings,status',
	'/zg arg completions list index | rebuild | drop | status | settings | help',
);
for (const t of calls.tools) {
	check(Boolean(t.description), `${t.name} has description`);
	check(Boolean(t.promptSnippet), `${t.name} has promptSnippet`);
}
const search = tool('zvec_search');
const indexTool = tool('zvec_index');
const statusTool = tool('zvec_status');
check(Array.isArray(search.promptGuidelines) && search.promptGuidelines.length > 0, 'zvec_search ships promptGuidelines');

// --- schemas ------------------------------------------------------------------
const prop = (t, name) => t.parameters.properties[name];
check(prop(search, 'query')?.type === 'string', 'search.query is string');
check(prop(search, 'query') === undefined || !Object.prototype.hasOwnProperty.call(prop(search, 'query'), 'default'), 'search.query has no default');
for (const field of ['queries', 'fts', 'vector', 'globs', 'fileTypes', 'excludedFileTypes', 'symbolTypes']) {
	const p = prop(search, field);
	check(p?.type === 'array' && p.items?.type === 'string', `search.${field} is string[]`);
}
check(prop(search, 'fuse')?.type === 'boolean', 'search.fuse is boolean');
check(prop(search, 'limit')?.type === 'number', 'search.limit is number');
check(prop(search, 'limit')?.maximum === 50, 'search.limit capped at 50');
check(prop(search, 'root')?.type === 'string', 'search.root is optional string');
check(Array.isArray(search.parameters.required) && search.parameters.required.includes('query'), 'search.query is REQUIRED — the empty-call failure mode (a model passing only limit/root) is unrepresentable');

check(prop(indexTool, 'root')?.type === 'string', 'index.root is string');
check(Array.isArray(indexTool.parameters.required) && indexTool.parameters.required.includes('root'), 'index.root is required');
const modeShape = prop(indexTool, 'mode');
check(Boolean(modeShape?.anyOf || modeShape?.oneOf || modeShape?.enum || modeShape?.const), 'index.mode is a constrained union');
check(prop(indexTool, 'hidden')?.type === 'boolean', 'index.hidden is boolean');
check(prop(statusTool, 'root')?.type === 'string', 'status.root is optional string');
check(!(Array.isArray(indexTool.parameters.required) && indexTool.parameters.required.length > 1), 'index has only one required field (root)');

// --- execute() wiring -----------------------------------------------------------
const ws = createTempDirectory('pi-zvec-grep-ws-');
// Workspace roots that tests point at must exist (zg spawns with cwd = root).
fs.mkdirSync(join(ws, 'sub'), { recursive: true });
fs.mkdirSync(join(ws, 'proj'), { recursive: true });

// search: positional query + flags; cwd = workspace root; signal forwarded
await invokeTool(calls, 'zvec_search', {
	query: 'where is auth validated',
	fts: ['AuthService'],
	fileTypes: ['ts'],
	globs: ['!src/generated/**'],
	fuse: true,
	limit: 3,
	root: 'sub',
}, makeCtx({ cwd: ws }));
let qState = fake.readState('query');
check(qState !== undefined, 'search executed zg query');
check(qState.args[0] === 'where is auth validated', 'positional query is first arg', qState.args.join(' '));
check(qState.args.includes('--fts') && qState.args[qState.args.indexOf('--fts') + 1] === 'AuthService', 'fts flag + value');
check(qState.args.includes('--fuse'), 'fuse flag');
check(qState.args.includes('--limit') && qState.args[qState.args.indexOf('--limit') + 1] === '3', 'limit flag');
check(qState.args.includes('-t') && qState.args[qState.args.indexOf('-t') + 1] === 'ts', 'type filter');
check(qState.args.includes('-g') && qState.args[qState.args.indexOf('-g') + 1] === '!src/generated/**', 'glob filter');
const expectedSub = realpathSync(join(ws, 'sub'));
check(qState.cwd === expectedSub, 'search cwd resolved relative to ctx.cwd', qState.cwd);

// default limit 7 when omitted; root omitted → ctx.cwd
await invokeTool(calls, 'zvec_search', { queries: ['auth flow'] }, makeCtx({ cwd: ws }));
qState = fake.readState('query');
check(qState.args.includes('--hybrid') && qState.args[qState.args.indexOf('--hybrid') + 1] === 'auth flow', 'queries → --hybrid');
check(qState.args[qState.args.indexOf('--limit') + 1] === '7', 'default limit 7');
check(qState.cwd === realpathSync(ws), 'search cwd falls back to ctx.cwd when root omitted', qState.cwd);

// error path: fake zg in missing-index mode → tool throws (isError for the model)
process.env.ZFAKE_MODE = 'missing-index';
let threw = '';
try {
	await invokeTool(calls, 'zvec_search', { query: 'x' }, makeCtx({ cwd: ws }));
} catch (error) {
	threw = String(error.message);
	check(threw.includes('WORKSPACE_INDEX_NOT_FOUND'), 'error message carries zg diagnostics', threw.split('\n')[0]);
}
check(threw !== '', 'search without index throws (surfaces as a tool error)');
delete process.env.ZFAKE_MODE;

// signal forwarding
const controller = new AbortController();
const signal = controller.signal;
await invokeTool(calls, 'zvec_search', { query: 'signal check' }, makeCtx({ cwd: ws, signal }));
check(calls.exec.some((c) => c.options?.signal === signal), 'search forwards AbortSignal to pi.exec');

// index: mode flags, embedding, filters; cwd = indexed root
await invokeTool(calls, 'zvec_index', {
	root: 'proj',
	mode: 'rebuild',
	embedding: 'local/potion-code-16m-v2',
	globs: ['src/**', '!node_modules/**'],
	fileTypes: ['py'],
	excludedFileTypes: ['svg'],
	hidden: true,
}, makeCtx({ cwd: ws }));
const iState = fake.readState('index');
check(iState.args[0] === join(ws, 'proj'), 'index root resolved to absolute path', iState.args.join(' '));
check(iState.args.includes('--rebuild'), 'rebuild flag');
check(iState.args.includes('--embedding') && iState.args[iState.args.indexOf('--embedding') + 1] === 'local/potion-code-16m-v2', 'embedding flag');
check(iState.args.filter((a) => a === '-g').length === 2, 'two glob filters');
check(iState.args.includes('-t') && iState.args[iState.args.indexOf('-t') + 1] === 'py', 'index type filter');
check(iState.args.includes('-T') && iState.args[iState.args.indexOf('-T') + 1] === 'svg', 'index excluded type');
check(iState.args.includes('--hidden'), 'hidden flag');
check(iState.cwd === realpathSync(join(ws, 'proj')), 'index cwd is the workspace root', iState.cwd);

// drop always passes --yes (non-interactive surface)
await invokeTool(calls, 'zvec_index', { root: 'proj', mode: 'drop' }, makeCtx({ cwd: ws }));
const dState = fake.readState('index');
check(dState.args.includes('--drop') && dState.args.includes('--yes'), 'drop uses --drop --yes');

// --- umbrella fan-out: no index at the root → search every indexed child ----
process.env.ZFAKE_MODE = 'fanout';
{
	const umbrella = join(ws, 'fanout-umbrella');
	for (const n of ['repoA', 'repoB']) {
		fs.mkdirSync(join(umbrella, n, '.git'), { recursive: true });
		fs.mkdirSync(join(umbrella, n, '.zvec-grep'), { recursive: true });
		fs.writeFileSync(join(umbrella, n, '.zvec-grep', 'manifest.json'), JSON.stringify({ rootPaths: [] }));
	}
	fs.mkdirSync(join(umbrella, 'repoC', '.git'), { recursive: true }); // nested repo WITHOUT an index
	const fanout = await invokeTool(calls, 'zvec_search', { query: 'where is it' }, makeCtx({ cwd: umbrella }));
	const text = String(fanout.content[0].text);
	check(text.includes('repoA') && text.includes('repoB'), 'fan-out merged hits from both indexed children', text.slice(0, 120));
	check(!text.includes('── repoC ──') && /not indexed yet/.test(text), 'unindexed child noted, not searched', text.slice(0, 160));
	check(/umbrella root/.test(text), 'merged output explains the umbrella situation');
	check(fanout.details?.summary?.totalHits === 2, 'summary counts hits across children', JSON.stringify(fanout.details));
	const logged = fake.readLog('query').filter((q) => q.cwd.includes('fanout-umbrella'));
	check(logged.length === 3, 'one failed query at the root + one per indexed child', logged.map((q) => q.cwd).join(','));
	check(logged.some((q) => realpathSync(q.cwd) === realpathSync(join(umbrella, 'repoA'))), 'child query cwd pinned to repoA');
	check(logged.every((q) => !q.cwd.includes('repoC')), 'the unindexed child is never queried');
}
delete process.env.ZFAKE_MODE;

// --- root policy: zvec_index refuses $HOME and umbrella roots -----------------
// umbrella fixture: a root whose children are three nested git repos
const umbrella = join(ws, 'umbrella');
for (const n of ['a', 'b', 'c']) fs.mkdirSync(join(umbrella, n, '.git'), { recursive: true });
fs.writeFileSync(join(umbrella, 'README.md'), 'root-level file only\n');

let policyError = '';
try {
	await invokeTool(calls, 'zvec_index', { root: 'umbrella' }, makeCtx({ cwd: ws }));
} catch (error) {
	policyError = String(error.message);
}
check(policyError.includes('blocked') && policyError.includes('umbrella'), 'zvec_index on an umbrella root throws with the reason', policyError.split('\n')[0]);

let homeError = '';
try {
	await invokeTool(calls, 'zvec_index', { root: '~' }, makeCtx({ cwd: ws }));
} catch (error) {
	homeError = String(error.message);
}
check(homeError.includes('blocked') && /HOME/.test(homeError), 'zvec_index on $HOME throws', homeError.split('\n')[0]);

// allowRoots escape hatch: allowlisted umbrella root indexes normally
fs.mkdirSync(join(agentHome, '.pi', 'agent', 'pi-zvec-grep'), { recursive: true });
fs.writeFileSync(
	join(agentHome, '.pi', 'agent', 'pi-zvec-grep', 'config.json'),
	JSON.stringify({ rootPolicy: { allowRoots: [umbrella], maxNestedRepos: 3 } }),
);
await invokeTool(calls, 'zvec_index', { root: 'umbrella' }, makeCtx({ cwd: ws }));
check(fake.readState('index')?.args[0] === umbrella, 'allowRoots: the umbrella root indexes when explicitly allowed');
fs.rmSync(join(agentHome, '.pi', 'agent', 'pi-zvec-grep', 'config.json'), { force: true });

// drop is never policy-blocked (dropping a bad index IS the remediation)
await invokeTool(calls, 'zvec_index', { root: 'umbrella', mode: 'drop' }, makeCtx({ cwd: ws }));
check(fake.readState('index')?.args.includes('--drop'), 'drop on an umbrella root passes through');

// index timeout is the long one
check(calls.exec.some((c) => c.args[0] === 'index' && c.options?.timeout === 600_000), 'index uses the 10-minute timeout');

// status: cwd resolved; missing index is a normal state (no throw)
process.env.ZFAKE_MODE = 'missing-index';
const statusResult = await invokeTool(calls, 'zvec_status', { root: 'proj' }, makeCtx({ cwd: ws }));
delete process.env.ZFAKE_MODE;
check(String(statusResult.content[0].text).length > 0, 'status returns text without throwing on missing index');
check(calls.exec.some((c) => c.command === 'zg' && c.args[0] === 'status'), 'status runs zg status');
check(calls.exec.filter((c) => c.args[0] === 'status').some((c) => c.options?.timeout === 30_000), 'status uses the short timeout');

// commands
for (const cmd of calls.commands) {
	check(typeof cmd.def.handler === 'function', `${cmd.name} handler is a function`);
}

// /zg dispatch: subcommand + path are routed to the right zg argv with cwd pinned
const invokeCommand = async (name, args, cwd) => {
	const cmd = calls.commands.find((c) => c.name === name);
	assert.ok(cmd, `command ${name} registered`);
	const notices = [];
	await cmd.def.handler(args, { cwd, hasUI: true, ui: { notify: (m, t) => notices.push({ m, t }) } });
	return notices;
};

await invokeCommand('zg', 'index', ws);
let cmdState = fake.readState('index');
check(cmdState !== undefined && cmdState.args[0] === ws, '/zg index targets the cwd workspace');
check(!cmdState.args.includes('--rebuild') && !cmdState.args.includes('--drop'), '/zg index is a plain update');

await invokeCommand('zg', 'status proj', ws);
let sState = fake.readState('status');
check(sState?.cwd === realpathSync(join(ws, 'proj')), '/zg status <path> pins cwd to the path');

await invokeCommand('zg', 'index proj', ws);
check(fake.readState('index')?.cwd === realpathSync(join(ws, 'proj')), '/zg index <path> indexes the named workspace');

// rebuild/drop are subcommands of /zg too
await invokeCommand('zg', 'rebuild proj', ws);
check(fake.readState('index')?.args.includes('--rebuild'), '/zg rebuild passes --rebuild');
await invokeCommand('zg', 'drop proj', ws);
check(fake.readState('index')?.args.includes('--drop') && fake.readState('index')?.args.includes('--yes'), '/zg drop uses --drop --yes');

// bare /zg and /zg show usage without running zg
calls.exec.length = 0;
await invokeCommand('zg', '', ws);
await invokeCommand('zg', 'help', ws);
check(calls.exec.length === 0, 'bare /zg and /zg help do not run zg');

// unknown subcommand: warning, no zg run
let unknownNotices = [];
const unknownCmd = calls.commands.find((c) => c.name === 'zg');
await unknownCmd.def.handler('frobnicate', {
	cwd: ws,
	hasUI: true,
	ui: { notify: (m, t) => unknownNotices.push({ m, t }) },
});
check(
	unknownNotices.length === 1 && unknownNotices[0].t === 'warning' && unknownNotices[0].m.includes('Usage'),
	'unknown /zg subcommand warns with usage',
);
check(calls.exec.length === 0, 'unknown /zg subcommand does not run zg');

// /zg settings: interactive-only surface — non-interactive ctx warns, no zg run, no crash
calls.exec.length = 0;
let settingNotices = [];
await unknownCmd.def.handler('settings', {
	cwd: ws,
	hasUI: false,
	ui: { notify: (m, t) => settingNotices.push({ m, t }) },
});
check(
	settingNotices.length === 1 && settingNotices[0].t === 'warning' && /interactive TUI/.test(settingNotices[0].m),
	'/zg settings without a UI warns instead of opening the menu',
	settingNotices.map((n) => n.m).join(' | '),
);
check(calls.exec.length === 0, '/zg settings does not run zg');

// dropped legacy aliases: /zg-index and /zg-status are gone
check(!calls.commands.some((c) => c.name === 'zg-index'), '/zg-index is not registered');
check(!calls.commands.some((c) => c.name === 'zg-status'), '/zg-status is not registered');

process.env.PI_CODING_AGENT_DIR = previousAgentDir;
fs.rmSync(agentHome, { recursive: true, force: true });

done();
