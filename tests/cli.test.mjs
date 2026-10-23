import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { createBridge } from '../dist/bridge.js';
import { fakeAdb } from './fake-adb.mjs';
const environments = new Map();

const executable = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const token = 'a'.repeat(64);
function state(t) {
  const directory = mkdtempSync(join(tmpdir(), 'lampa-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  environments.set(directory, fakeAdb(t, { devices: '' }).env);
  return directory;
}
async function cli(directory, args, entry = executable) {
  const p = spawn(process.execPath, [entry, ...args], { env: { ...process.env, LAMPA_REMOTE_STATE: directory, ...environments.get(directory) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  p.stdout.on('data', chunk => { stdout += chunk; }); p.stderr.on('data', chunk => { stderr += chunk; });
  const [status] = await once(p, 'close');
  return { status, stdout, stderr };
}

test('help/version work through a symlink without TV or creating configuration', async t => {
  const directory = state(t);
  const alias = join(directory, 'lampa'); symlinkSync(executable, alias);
  const help = await cli(directory, ['--help'], alias);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /settings set KEY true\|false/);
  assert.equal(help.stderr, '');
  const version = await cli(directory, ['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^0\.3\.0\n$/);
  assert.throws(() => readFileSync(join(directory, 'config.json')), { code: 'ENOENT' });
});

test('argument errors have stable JSON stderr/exit 2 and never contact the TV', async t => {
  const directory = state(t);
  for (const args of [['wat'], ['key', 'wrong'], ['input', 'one', 'two'], ['settings', 'set', 'background', 'maybe'], ['status', '--bad'], ['logs', '--wat']]) {
    const result = await cli(directory, args);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr);
    assert.equal(error.ok, false);
    assert.equal(typeof error.error.code, 'string');
  }
  assert.throws(() => readFileSync(join(directory, 'config.json')), { code: 'ENOENT' });
});

test('install-url prints a public standalone URL without token or private URL files', async t => {
  const directory = state(t);
  const result = await cli(directory, ['install-url']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, data: { url: 'https://krajcik.github.io/lampa-remote/plugin/remote.js?v=0.3.0#' } });
  const file = join(directory, 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const returned = JSON.parse(result.stdout).data.url;
  const lampaRequest = new URL(returned + (returned.includes('?') ? '&' : '?') + 'email=FAKE_ACCOUNT&logged=true');
  assert.doesNotMatch(lampaRequest.search, /email|logged|FAKE_ACCOUNT/, 'Lampa account metadata must remain in the fragment');
  assert.equal(Object.hasOwn(config, 'token'), false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(() => readFileSync(join(directory, 'install-url.txt')), { code: 'ENOENT' });
  writeFileSync(file, JSON.stringify({ ...config, token, port: 20000, browserWakeCode: 120, wakeTimeoutMs: 500 }), { mode: 0o600 });
  const custom = await cli(directory, ['install-url']);
  assert.equal(custom.status, 0, custom.stderr);
  assert.doesNotMatch(custom.stdout + custom.stderr, new RegExp(token));
  const url = new URL(JSON.parse(custom.stdout).data.url);
  assert.ok(url.href.length <= 300);
  assert.deepEqual(JSON.parse(decodeURIComponent(url.hash.slice('#lampa-remote='.length))), { port: 20000, browserWakeCode: 120, wakeTimeoutMs: 500 });
});

test('CLI emits JSON success on stdout, state errors on stderr, and redacts credentials', async t => {
  const directory = state(t);
  const bridge = createBridge({ port: 0 }); const port = await bridge.listen(); t.after(() => bridge.close());
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ token, port }), { mode: 0o600 });
  const disconnected = await cli(directory, ['status']);
  assert.equal(disconnected.status, 3);
  assert.equal(disconnected.stdout, '');
  assert.equal(JSON.parse(disconnected.stderr).error.code, 'ADB_NO_DEVICE');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tv`, { origin: 'http://lampa.mx' }); await once(ws, 'open');
  const h = (await (await fetch(`http://127.0.0.1:${port}/health?passive=1`, { headers: { 'Content-Type': 'application/json' } })).json()).data;
  ws.send(JSON.stringify({ type: 'hello', data: { protocolVersion: 2, pluginVersion: h.version, browserWakeCode: 119, origin: 'http://lampa.mx', appready: true } }));
  ws.on('message', message => {
    const r = JSON.parse(message);
    if (r.method === 'settings.get') ws.send(JSON.stringify({ id: r.id, error: { code: 'SETTING_NOT_AVAILABLE' } }));
    else ws.send(JSON.stringify({ id: r.id, result: { jackett_key: 'DUMMY1234', component: 'main' } }));
  });
  const result = await cli(directory, ['status']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, data: { jackett_key: '[redacted]', component: 'main' }, meta: JSON.parse(result.stdout).meta });
  assert.doesNotMatch(result.stdout, /DUMMY1234/);
  const unavailable = await cli(directory, ['settings', 'get', 'jackett_key']);
  assert.equal(unavailable.status, 3);
  assert.equal(JSON.parse(unavailable.stderr).error.code, 'SETTING_NOT_AVAILABLE');
});

test('explicit bridge start/health/stop use isolated state and leave no daemon', async t => {
  const directory = state(t);
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ token, port }), { mode: 0o600 });
  const started = await cli(directory, ['start']);
  assert.equal(started.status, 0, started.stderr);
  const pid = JSON.parse(started.stdout).data.pid;
  t.after(() => { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  const health = await cli(directory, ['bridge']);
  assert.equal(health.status, 0, health.stderr);
  assert.equal(JSON.parse(health.stdout).data.pid, pid);
  const stopped = await cli(directory, ['stop']);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).data.stopped, true);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
