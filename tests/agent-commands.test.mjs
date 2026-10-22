import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createBridge } from '../dist/bridge.js';
import { defaults } from '../dist/state.js';
import { fakeAdb } from './fake-adb.mjs';
import { pluginFixture } from './plugin-fixture.mjs';

const executable = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const token = 'a'.repeat(64);
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert.fail('Expected test observation was not reached');
}
async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lampa-agent-'));
  const adb = fakeAdb(t, { devices: '' });
  const bridge = createBridge({ token, port: 0, timeout: 500 }); const port = await bridge.listen();
  const c = { ...defaults, token, port, rpcTimeoutMs: 500 };
  writeFileSync(join(directory, 'config.json'), JSON.stringify(c), { mode: 0o600 });
  const h = (await (await fetch(`http://127.0.0.1:${port}/health?passive=1`, { headers: { Authorization: `Bearer ${token}` } })).json()).data;
  const model = pluginFixture({ replaceRows: true, ...options, remoteConfig: { sourceHash: h.sourceHash, version: h.version } });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tv?token=${token}`); await once(ws, 'open');
  ws.send(JSON.stringify(model.sent.find(item => item.type === 'hello')));
  const calls = [];
  let dropReads = false;
  ws.on('message', async data => {
    const call = JSON.parse(data); calls.push(call);
    if (dropReads) return;
    model.getSocket().onmessage({ data: JSON.stringify(call) });
    const reply = await model.response(call.id);
    if (ws.readyState === 1) ws.send(JSON.stringify(reply));
  });
  const children = new Set();
  t.after(async () => {
    for (const child of children) child.kill('SIGTERM');
    model.stop(); ws.terminate(); await bridge.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const cli = async args => {
    const child = spawn(process.execPath, [executable, ...args], { env: { ...process.env, ...adb.env, LAMPA_REMOTE_STATE: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const [status] = await once(child, 'close'); children.delete(child);
    return { status, stdout, stderr, data: stdout ? JSON.parse(stdout).data : undefined, error: stderr ? JSON.parse(stderr).error : undefined };
  };
  return { cli, model, adb, calls, directory, dropReads: () => { dropReads = true; } };
}

test('public UI is compact by default, full is opt-in, filters/counts apply before limits', async t => {
  const rows = Array.from({ length: 70 }, (_, i) => ({ text: `Movie ${i}`, attrs: { 'data-name': `row_${i}`, 'data-component': `section_${i}` } }));
  rows[0].text = rows[69].text = 'Duplicate';
  const f = await fixture(t, { rows });
  const compact = await f.cli(['ui']); assert.equal(compact.status, 0, compact.stderr);
  assert.equal(compact.data.items.length, 50); assert.equal(compact.data.totalVisible, 70);
  assert.equal(compact.data.matchedVisible, 70); assert.equal(compact.data.returned, 50); assert.equal(compact.data.truncated, true);
  assert.equal(compact.data.items[0].bounds, undefined); assert.equal(compact.data.state.viewport, undefined);
  const full = await f.cli(['ui', '--full']); assert.equal(full.status, 0, full.stderr);
  assert.equal(full.data.items.length, 70); assert.equal(full.data.truncated, false);
  assert.equal(full.data.items[0].bounds.length, 4); assert.equal(typeof full.data.state.viewport.width, 'number');
  const filtered = await f.cli(['ui', '--text', 'Duplicate', '--limit', '1']);
  assert.equal(filtered.data.totalVisible, 70); assert.equal(filtered.data.matchedVisible, 2); assert.equal(filtered.data.returned, 1); assert.equal(filtered.data.truncated, true);
  const keyed = await f.cli(['ui', '--key', 'row_65']); assert.equal(keyed.data.items[0].key, 'row_65'); assert.equal(keyed.data.matchedVisible, 1);
  const section = await f.cli(['ui', '--section', 'section_65']); assert.equal(section.data.items[0].section, 'section_65');
  const present = await f.cli(['wait', '--text', 'Duplicate']); assert.equal(present.status, 0, present.stderr); assert.equal(f.model.actions(), 0);
  assert.deepEqual(f.adb.calls(), []);
});

test('public semantic actions scan beyond output limits and refuse no-match/ambiguity without dispatch', async t => {
  const rows = Array.from({ length: 70 }, (_, i) => ({ text: `Movie ${i}`, attrs: { 'data-name': `row_${i}`, 'data-component': `section_${i}` } }));
  rows[0].text = rows[69].text = 'Duplicate'; rows[65].text = 'Choose me';
  const f = await fixture(t, { rows });
  await f.cli(['ui', '--text', 'Duplicate', '--limit', '1']);
  for (const [args, code] of [[['action', '--text', 'Duplicate'], 'AMBIGUOUS_TARGET'], [['action', '--key', 'missing'], 'TARGET_NOT_FOUND'], [['action', '--text', 'Choose'], 'TARGET_NOT_FOUND']]) {
    const r = await f.cli(args); assert.equal(r.status, 3, r.stderr); assert.equal(r.error.code, code); assert.equal(f.model.actions(), 0);
  }
  for (const args of [['action', '--text', 'Choose me'], ['action', '--key', 'row_65'], ['action', '--section', 'section_65']]) {
    const r = await f.cli(args); assert.equal(r.status, 0, r.stderr); assert.equal(r.data.dispatched, true);
  }
  assert.equal(f.model.actions(), 3); assert.deepEqual(f.adb.calls(), []);
});

test('IDs refuse recycled key/section, changed controller or detached DOM before dispatch', async t => {
  let recycleOnFocus = false;
  const f = await fixture(t, { rows: [{ text: 'One', attrs: { 'data-name': 'original', 'data-component': 'interface' } }], onFocus: el => { if (recycleOnFocus) el.attrs['data-name'] = 'recycled'; } });
  const row = f.model.rows[0];
  for (const change of [() => { row.attrs['data-name'] = 'other'; }, () => { row.attrs['data-component'] = 'other'; }, () => f.model.setController('select'), () => { row.detached = true; }]) {
    row.attrs['data-name'] = 'original'; row.attrs['data-component'] = 'interface'; row.detached = false; f.model.setController('content');
    const ui = await f.cli(['ui']); const id = ui.data.items[0].id;
    change(); const action = await f.cli(['action', id]);
    assert.equal(action.status, 3, action.stderr); assert.equal(action.error.code, 'STALE_TARGET'); assert.equal(f.model.actions(), 0);
  }
  const inherited = await f.cli(['action', 'constructor']); assert.equal(inherited.error.code, 'STALE_TARGET');
  row.detached = false; f.model.setController('content');
  const current = await f.cli(['ui']); recycleOnFocus = true;
  const focused = await f.cli(['action', current.data.items[0].id]);
  assert.equal(focused.error.code, 'STALE_TARGET'); assert.equal(f.model.actions(), 0);
});

test('wait observes transient state without blocking a concurrent action or retrying setup', async t => {
  let model;
  const f = await fixture(t, { rows: [{ text: 'Finish', attrs: { 'data-name': 'finish' } }], onAction: () => model.setController('done') }); model = f.model;
  const waiting = f.cli(['wait', '--screen', 'done', '--timeout', '1500']);
  await until(() => f.calls.some(call => call.method === 'status'));
  const action = await f.cli(['action', '--key', 'finish']); assert.equal(action.status, 0, action.stderr);
  const result = await waiting; assert.equal(result.status, 0, result.stderr); assert.equal(result.data.matched, true);
  assert.equal(f.model.actions(), 1); assert.ok(result.data.polls >= 2);
  assert.ok(f.calls.every(call => ['status', 'action'].includes(call.method))); assert.deepEqual(f.adb.calls(), []);
});

test('wait screen means current controller, unmet timeout is exit3, selectors and settings are read-only', async t => {
  const f = await fixture(t, { rows: [{ text: 'Visible title', attrs: { 'data-name': 'ready', 'data-component': 'interface' } }] });
  f.model.setSection('interface'); f.model.setController('select');
  const unmet = await f.cli(['wait', '--screen', 'interface', '--timeout', '160']);
  assert.equal(unmet.status, 3, unmet.stderr); assert.equal(unmet.error.code, 'WAIT_TIMEOUT'); assert.equal(unmet.error.outcome, undefined);
  for (const args of [['wait', '--screen', 'select'], ['wait', '--text', 'title'], ['wait', '--key', 'ready'], ['wait', '--section', 'interface'], ['wait', '--setting', 'background', '--value', 'false']]) {
    const r = await f.cli(args); assert.equal(r.status, 0, r.stderr); assert.equal(r.data.matched, true);
  }
  const settingWait = f.cli(['wait', '--setting', 'background', '--value', 'true', '--timeout', '1500']);
  await until(() => f.calls.some(call => call.method === 'settings.get'));
  f.model.setBackground(true);
  assert.equal((await settingWait).status, 0);
  for (const value of [null, 12, 'Готово']) {
    f.model.setBackground(value);
    const primitive = await f.cli(['wait', '--setting', 'background', '--value', JSON.stringify(value)]);
    assert.equal(primitive.status, 0, primitive.stderr);
  }
  assert.equal(f.model.actions(), 0); assert.deepEqual(f.adb.calls(), []);
});

test('a missing state response is transport4 rather than a false WAIT_TIMEOUT or mutation unknown', async t => {
  const f = await fixture(t);
  f.dropReads();
  const result = await f.cli(['wait', '--screen', 'done', '--timeout', '50']);
  assert.equal(result.status, 4, result.stderr); assert.equal(result.error.code, 'WAIT_READ_TIMEOUT'); assert.equal(result.error.outcome, undefined);
  assert.equal(f.calls.length, 1); assert.equal(f.model.actions(), 0);
});

test('invalid agent arguments fail before any configuration or runtime side effect', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lampa-agent-usage-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const adb = fakeAdb(t, { devices: '' });
  for (const args of [
    ['ui', '--limit', '0'], ['ui', '--limit', '151'], ['ui', '--text', 'a', '--key', 'b'], ['ui', '--full', 'true'],
    ['action'], ['action', 'id', '--text', 'a'], ['action', '--text', 'a', '--section', 'b'],
    ['wait'], ['wait', '--screen', 'content', '--text', 'a'], ['wait', '--text', 'a', '--timeout', '0'],
    ['wait', '--setting', 'background'], ['wait', '--value', 'true'], ['wait', '--setting', 'background', '--value', '{}'], ['wait', '--text', '--timeout'],
  ]) {
    const p = spawn(process.execPath, [executable, ...args], { env: { ...process.env, ...adb.env, LAMPA_REMOTE_STATE: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', chunk => { out += chunk; }); p.stderr.on('data', chunk => { err += chunk; });
    const [status] = await once(p, 'close'); assert.equal(status, 2, err); assert.equal(out, ''); assert.equal(JSON.parse(err).ok, false);
  }
  assert.throws(() => readFileSync(join(dir, 'config.json')), { code: 'ENOENT' }); assert.deepEqual(adb.calls(), []);
});
