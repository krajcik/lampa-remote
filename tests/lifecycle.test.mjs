import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createBridge } from '../dist/bridge.js';
import { defaults } from '../dist/state.js';
import { fakeAdb } from './fake-adb.mjs';

const executable = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const token = 'a'.repeat(64);
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function fixture(t, options = {}, fake = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lampa-lifecycle-'));
  const c = { ...defaults, token, port: await freePort(), ...options };
  const adb = fakeAdb(t, fake);
  const save = data => writeFileSync(join(directory, 'config.json'), JSON.stringify(data), { mode: 0o600 }); save(c);
  const start = args => {
    const child = spawn(process.execPath, [executable, ...args], { env: { ...process.env, ...adb.env, LAMPA_REMOTE_STATE: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    const result = once(child, 'close').then(([status]) => ({ status, stdout, stderr }));
    return { child, result };
  };
  const cli = args => start(args).result;
  t.after(async () => {
    save(c);
    try { const lock = JSON.parse(readFileSync(join(directory, 'bridge.lock'), 'utf8')); if (lock.pid) process.kill(lock.pid, 'SIGTERM'); } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    rmSync(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${c.port}`;
  const getHealth = async () => (await (await fetch(url + '/health?passive=1', { headers: { Authorization: `Bearer ${token}` } })).json()).data;
  return { c, directory, adb, cli, start, save, url, getHealth };
}
async function peer(f, responder = true, observed = {}) {
  const h = await f.getHealth();
  const status = { protocolVersion: 1, pluginVersion: h.version, sourceHash: h.sourceHash, browserWakeCode: f.c.browserWakeCode, appready: true, visibility: 'visible', ...observed };
  const ws = new WebSocket(`ws://127.0.0.1:${f.c.port}/tv?token=${token}`); await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', data: status }));
  let calls = 0;
  ws.on('message', data => { calls++; const r = JSON.parse(data); if (responder) ws.send(JSON.stringify({ id: r.id, result: status })); });
  for (let i = 0; i < 30; i++) { if ((await f.getHealth()).ready) return { ws, calls: () => calls }; await delay(5); }
  assert.fail('Peer handshake did not complete');
}

test('runtime defaults are explicit; old token+port config remains compatible', async t => {
  assert.equal(defaults.idleTimeoutMs, 3600000);
  assert.equal(defaults.wakeTimeoutMs, 20000); assert.equal(defaults.wakeRetryIntervalMs, 1000);
  assert.equal(defaults.appActivity, '.ui.MainActivity');
  const f = await fixture(t); f.save({ token, port: f.c.port });
  const result = await f.cli(['bridge']); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.idleTimeoutMs, 3600000);
  assert.deepEqual(JSON.parse(readFileSync(join(f.directory, 'config.json'), 'utf8')), { token, port: f.c.port });
  assert.deepEqual(f.adb.calls(), []);
});

test('concurrent cold starts share one token, owner and bridge; port edits never create a second daemon', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => f.cli(['bridge'])));
  for (const r of results) assert.equal(r.status, 0, r.stderr);
  const pids = new Set(results.map(r => JSON.parse(r.stdout).data.pid)); assert.equal(pids.size, 1);
  const lock = JSON.parse(readFileSync(join(f.directory, 'bridge.lock'), 'utf8')); assert.equal(lock.pid, [...pids][0]);
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'config.json'), 'utf8')).token, token);
  f.save({ ...f.c, port: await freePort() });
  const changed = await f.cli(['bridge']); assert.equal(changed.status, 3);
  assert.equal(JSON.parse(changed.stderr).error.code, 'BRIDGE_CONFIG_CHANGED');
  assert.deepEqual(f.adb.calls(), []);
});

test('atomic first config publication and invalid edits never leak or regenerate credentials', async t => {
  const f = await fixture(t); rmSync(join(f.directory, 'config.json'));
  const results = await Promise.all(Array.from({ length: 6 }, () => f.cli(['install-url'])));
  for (const r of results) assert.equal(r.status, 0, r.stderr);
  const created = JSON.parse(readFileSync(join(f.directory, 'config.json'), 'utf8'));
  assert.equal(created.idleTimeoutMs, 3600000);
  assert.match(readFileSync(join(f.directory, 'install-url.txt'), 'utf8'), new RegExp(created.token));
  for (const r of results) assert.ok(!r.stdout.includes(created.token));
  for (const extra of [{ constructor: 'bad' }, { toString: 'bad' }, { idleTimeoutMs: 0 }, { rpcTimeoutMs: '5000' }, { wakeRetryIntervalMs: 0 }, { wakeRetryIntervalMs: '1000' }, { wakeRetryIntervalMs: 60001 }, { appPackage: 'bad;cmd' }, { browserWakeCode: -1 }]) {
    f.save({ ...f.c, ...extra }); const r = await f.cli(['app', 'start']);
    assert.equal(r.status, 3, r.stderr); assert.equal(JSON.parse(r.stderr).error.code, 'CONFIG_INVALID');
  }
  writeFileSync(join(f.directory, 'config.json'), '{"token":');
  const partial = await f.cli(['app', 'start']); assert.equal(partial.status, 3);
  assert.equal(readFileSync(join(f.directory, 'config.json'), 'utf8'), '{"token":');
  assert.deepEqual(f.adb.calls(), []);
});

test('the real configured idle path stops an unused daemon', async t => {
  const f = await fixture(t, { idleTimeoutMs: 200 });
  const result = await f.cli(['bridge']); assert.equal(result.status, 0, result.stderr);
  await delay(350);
  await assert.rejects(f.getHealth());
  assert.throws(() => readFileSync(join(f.directory, 'bridge.lock')), { code: 'ENOENT' });
});

test('active RPC holds past idle, and plugin events do not prolong an idle bridge', async t => {
  const f = await fixture(t, { idleTimeoutMs: 100 });
  const bridge = createBridge({ ...f.c, timeout: 1000 }); await bridge.listen(); t.after(() => bridge.close());
  const p = await peer(f, false);
  p.ws.on('message', data => { const r = JSON.parse(data); setTimeout(() => p.ws.send(JSON.stringify({ id: r.id, result: { done: true } })), 250); });
  const response = fetch(f.url + '/rpc', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ method: 'status' }) });
  await delay(160); assert.equal(bridge.server.listening, true);
  assert.equal((await (await response).json()).data.done, true);
  const closed = once(bridge.server, 'close');
  const traffic = setInterval(() => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ type: 'event', data: { message: 'idle plugin traffic' } })); }, 10);
  await closed; clearInterval(traffic);
});

test('a live HTTP lease holds idle and releases on cancellation or socket disconnect', async t => {
  const f = await fixture(t, { idleTimeoutMs: 80 }); const bridge = createBridge(f.c); await bridge.listen(); t.after(() => bridge.close());
  const held = await fetch(f.url + '/lease', { headers: { Authorization: `Bearer ${token}` } });
  await delay(160); assert.equal(bridge.server.listening, true);
  const closed = once(bridge.server, 'close'); await held.body.cancel(); await closed;
});

test('foreground refusal, reverse ownership and ambiguous devices never wake or launch Lampa', async t => {
  for (const fake of [{ foreground: 'com.google.android.tvlauncher' }, { devices: 'TV1 device\nTV2 device' }, { reverse: 'TV1 tcp:18657 tcp:12345' }]) {
    const f = await fixture(t, {}, fake);
    if (fake.reverse) f.adb.update({ reverse: `TV1 tcp:${f.c.port} tcp:12345` });
    const r = await f.cli(['status']); assert.equal(r.status, 3, r.stderr);
    assert.ok(['APP_NOT_FOREGROUND', 'ADB_AMBIGUOUS', 'ADB_PORT_ALREADY_OWNED'].includes(JSON.parse(r.stderr).error.code));
    assert.ok(!f.adb.calls().some(args => args.includes('input') || args.includes('am')));
  }
});

test('explicit app lifecycle is bounded, independent of JS, and validates Android stdout', async t => {
  const f = await fixture(t);
  for (const action of ['start', 'stop', 'restart']) { const r = await f.cli(['app', action]); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).data.dispatched, true); }
  assert.equal(f.adb.calls().filter(args => args.includes('am') && args.includes('start')).length, 2);
  assert.equal(f.adb.calls().filter(args => args.includes('force-stop')).length, 2);
  assert.ok(f.adb.calls().some(args => args.includes('ru.twicker.lampa/.ui.MainActivity')));
  assert.throws(() => readFileSync(join(f.directory, 'bridge.lock')), { code: 'ENOENT' });
  f.adb.update({ appError: true });
  const invalid = await f.cli(['app', 'start']); assert.equal(invalid.status, 3); assert.equal(JSON.parse(invalid.stderr).error.code, 'APP_START_FAILED');
  f.save({ ...f.c, adbTimeoutMs: 30 }); f.adb.update({ delayMs: 1000 });
  const timeout = await f.cli(['app', 'start']); assert.equal(timeout.status, 4); assert.equal(JSON.parse(timeout.stderr).error.code, 'ADB_TIMEOUT');
});

test('cold ordinary RPC wakes once after guard and then warm RPC never invokes ADB', async t => {
  for (const recover of [false, true]) {
  const f = await fixture(t);
  if (recover) {
    const bridge = createBridge(f.c); await bridge.listen(); t.after(() => bridge.close());
    const bad = new WebSocket(`ws://127.0.0.1:${f.c.port}/tv?token=${token}`); await once(bad, 'open');
    const closed = once(bad, 'close'); bad.send(JSON.stringify({ type: 'hello', data: { protocolVersion: 999 } })); await closed;
    assert.equal((await f.getHealth()).lastPeerError, 'PROTOCOL_MISMATCH');
  }
  const watcher = watch(f.adb.log);
  t.after(() => watcher.close());
  let waking = false;
  const connected = new Promise((resolve, reject) => {
    watcher.on('change', async () => {
      if (waking || !f.adb.calls().some(args => args.includes('keyevent'))) return;
      waking = true;
      watcher.close(); try { resolve(await peer(f)); } catch (error) { reject(error); }
    });
  });
  const first = f.cli(['status']); const p = await connected; const r = await first;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(p.calls(), 1);
  const before = f.adb.calls(); assert.equal(before.filter(args => args.includes('keyevent')).length, 1);
  const second = await f.cli(['status']); assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(f.adb.calls(), before);
  p.ws.close();
  }
});

async function waitForWakes(f, count) {
  for (let i = 0; i < 1000; i++) {
    if (f.adb.calls().filter(args => args.includes('keyevent')).length >= count) return;
    await delay(5);
  }
  assert.fail('Expected service wake was not sent');
}

test('a late hook receives a later guarded service pulse, while the actual RPC dispatches once', async t => {
  const f = await fixture(t, { wakeTimeoutMs: 3000, wakeRetryIntervalMs: 80 });
  const bridge = createBridge(f.c); await bridge.listen(); t.after(() => bridge.close());
  const result = f.cli(['key', 'down']);
  await waitForWakes(f, 2);
  const p = await peer(f);
  const r = await result; assert.equal(r.status, 0, r.stderr); assert.equal(p.calls(), 1);
  const calls = f.adb.calls(); assert.equal(calls.filter(args => args.includes('keyevent')).length, 2);
  assert.equal(calls.filter(args => args.includes('dumpsys')).length, 2);
  assert.ok(!calls.some(args => args.includes('am')));
  const warm = await f.cli(['status']); assert.equal(warm.status, 0, warm.stderr); assert.deepEqual(f.adb.calls(), calls);
});

test('wake retries stop on foreground switch, fresh protocol rejection or the total deadline', async t => {
  for (const reason of ['foreground', 'protocol', 'deadline']) {
    const f = await fixture(t, { wakeTimeoutMs: 1100, wakeRetryIntervalMs: 80 });
    const bridge = createBridge(f.c); await bridge.listen(); t.after(() => bridge.close());
    const started = performance.now();
    const result = f.cli(['key', 'down']);
    await waitForWakes(f, 1);
    if (reason === 'foreground') f.adb.update({ foreground: 'com.google.android.tvlauncher' });
    if (reason === 'protocol') {
      const ws = new WebSocket(`ws://127.0.0.1:${f.c.port}/tv?token=${token}`); await once(ws, 'open');
      const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'hello', data: { protocolVersion: 999 } })); await closed;
    }
    const r = await result;
    assert.equal(r.status, reason === 'deadline' ? 4 : 3, r.stderr);
    const error = JSON.parse(r.stderr).error;
    assert.equal(error.code, { foreground: 'APP_NOT_FOREGROUND', protocol: 'PROTOCOL_MISMATCH', deadline: 'PLUGIN_WAKE_TIMEOUT' }[reason]);
    assert.equal(error.outcome, undefined);
    const count = f.adb.calls().filter(args => args.includes('keyevent')).length;
    if (reason === 'deadline') { assert.ok(count >= 2); assert.ok(performance.now() - started < 2000); }
    else assert.equal(count, 1);
    await delay(130); assert.equal(f.adb.calls().filter(args => args.includes('keyevent')).length, count);
    assert.ok(!f.adb.calls().some(args => args.includes('am')));
  }
});

test('the wake budget also bounds an unresponsive ADB subprocess before any RPC', async t => {
  const f = await fixture(t, { wakeTimeoutMs: 150, adbTimeoutMs: 10000 }, { delayMs: 2000 });
  const bridge = createBridge(f.c); await bridge.listen(); t.after(() => bridge.close());
  const started = performance.now(); const r = await f.cli(['status']);
  assert.equal(r.status, 4, r.stderr); assert.equal(JSON.parse(r.stderr).error.code, 'PLUGIN_WAKE_TIMEOUT');
  assert.ok(performance.now() - started < 1000);
  assert.ok(!f.adb.calls().some(args => args.includes('input') || args.includes('am')));
});

test('doctor is passive and requires a fresh compatible status, not a stale live socket', async t => {
  for (const responsive of [false, true]) {
    const f = await fixture(t, { rpcTimeoutMs: 100 });
    const bridge = createBridge({ ...f.c, timeout: f.c.rpcTimeoutMs }); await bridge.listen(); t.after(() => bridge.close());
    const p = await peer(f, responsive, { screensaverActive: true });
    const r = await f.cli(['doctor']);
    if (responsive) { assert.equal(r.status, 0, r.stderr); const data = JSON.parse(r.stdout).data;
      assert.equal(data.ready, true); assert.equal(data.checks.plugin.screensaverActive, true); assert.ok(data.checks.plugin.hint); }
    else { assert.equal(r.status, 4, r.stderr); assert.equal(JSON.parse(r.stderr).meta.checks.plugin.code, 'TV_TIMEOUT'); assert.ok(JSON.parse(r.stderr).error.hint); }
    assert.equal(p.calls(), 1);
    assert.ok(!f.adb.calls().some(args => args.includes('input') || args.includes('reverse') || args.includes('am')));
  }
});

test('doctor reports absent ADB/bridge/plugin/protocol without starting or waking anything', async t => {
  const f = await fixture(t, {}, { devices: '' });
  const r = await f.cli(['doctor']); const error = JSON.parse(r.stderr);
  assert.equal(r.status, 3); assert.equal(error.meta.checks.adb.code, 'ADB_NO_DEVICE'); assert.equal(error.meta.checks.bridge.code, 'BRIDGE_UNAVAILABLE');
  assert.throws(() => readFileSync(join(f.directory, 'bridge.lock')), { code: 'ENOENT' });
  assert.ok(!f.adb.calls().some(args => args.includes('input') || args.includes('am')));
});

test('logs --follow holds idle and releases on SIGINT or TV disconnect without reconnect/wake', { timeout: 10000 }, async t => {
  for (const disconnect of [false, true]) {
    const f = await fixture(t, { idleTimeoutMs: 100 });
    const bridge = createBridge(f.c); await bridge.listen(); t.after(() => bridge.close());
    const held = await fetch(f.url + '/lease', { headers: { Authorization: `Bearer ${token}` } });
    const p = await peer(f);
    const running = f.start(['logs', '--follow']);
    t.after(async () => { if (running.child.exitCode === null) running.child.kill('SIGINT'); await running.result; });
    await once(running.child.stdout, 'data');
    await held.body.cancel();
    await delay(180); assert.equal(bridge.server.listening, true);
    const closed = once(bridge.server, 'close');
    if (disconnect) p.ws.terminate(); else running.child.kill('SIGINT');
    const result = await running.result;
    assert.equal(result.status, disconnect ? 4 : 130, result.stderr);
    if (disconnect) assert.equal(JSON.parse(result.stderr).error.code, 'TV_DISCONNECTED');
    await closed;
    assert.deepEqual(f.adb.calls(), []);
  }
});

test('doctor distinguishes foreground, missing handshake and incompatible protocol without mutations', async t => {
  for (const stage of ['foreground', 'handshake', 'protocol']) {
    const f = await fixture(t, {}, stage === 'foreground' ? { foreground: 'com.google.android.tvlauncher' } : {});
    const bridge = createBridge(f.c); await bridge.listen(); t.after(() => bridge.close());
    if (stage === 'foreground') await peer(f);
    else {
      const ws = new WebSocket(`ws://127.0.0.1:${f.c.port}/tv?token=${token}`); await once(ws, 'open');
      if (stage === 'protocol') { const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'hello', data: { protocolVersion: 999 } })); await closed; }
    }
    const result = await f.cli(['doctor']); assert.equal(result.status, 3, result.stderr);
    const report = JSON.parse(result.stderr);
    if (stage === 'foreground') assert.equal(report.meta.checks.foreground.code, 'APP_NOT_FOREGROUND');
    else assert.equal(report.meta.checks.protocol.code, stage === 'protocol' ? 'PROTOCOL_MISMATCH' : 'HANDSHAKE_MISSING');
    assert.ok(report.error.hint);
    assert.ok(!f.adb.calls().some(args => args.includes('input') || args.includes('am') || args.includes('reverse')));
  }
});
