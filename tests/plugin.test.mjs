import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginFixture } from './plugin-fixture.mjs';
import { defaults } from '../dist/state.js';
import { version, protocolVersion } from '../dist/protocol.js';

test('public standalone script works without injection or HTTP loading, including cached custom options', async t => {
  const base = 'https://krajcik.github.io/lampa-remote/plugin/remote.js?v=0.3.0';
  for (const cached of [false, true]) {
    const f = pluginFixture({ autoWake: false, cached, installUrl: base }); t.after(f.stop);
    assert.equal(f.connections(), 0); assert.equal(f.timers(), 0);
    f.wake(); assert.equal(f.getSocket().url, `ws://127.0.0.1:${defaults.port}/tv`);
    f.open(); const status = await f.response(f.send('status'));
    assert.equal(status.result.pluginVersion, version); assert.equal(status.result.protocolVersion, protocolVersion);
    assert.equal(status.result.browserWakeCode, defaults.browserWakeCode);
    assert.equal(status.result.sourceHash, undefined);
    const listener = f.listeners.get('keydown'); f.run(); assert.equal(f.listeners.get('keydown'), listener);
  }
  const custom = pluginFixture({ autoWake: false, cached: true, remoteConfig: { port: 20000, browserWakeCode: 120, wakeTimeoutMs: 25 } }); t.after(custom.stop);
  custom.wake(); assert.equal(custom.connections(), 0);
  custom.wake('keydown', false, 120); assert.equal(custom.getSocket().url, 'ws://127.0.0.1:20000/tv');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(custom.timers(), 0); assert.equal(custom.connections(), 1);
});

test('standalone options reject invalid endpoints, codes, timeout and ambiguous cached registrations', () => {
  const base = 'https://krajcik.github.io/lampa-remote/plugin/remote.js';
  for (const value of [null, [], { socket: 'ws://example.org/tv' }, { port: 0 }, { port: 65536 }, { browserWakeCode: '119' }, { wakeTimeoutMs: 60001 }, { constructor: 1 }]) {
    const f = pluginFixture({ autoWake: false, installUrl: base + '#lampa-remote=' + encodeURIComponent(JSON.stringify(value)) });
    assert.equal(f.window.__lampaRemote, undefined); assert.equal(f.listeners.size, 0); assert.equal(f.connections(), 0);
  }
  const f = pluginFixture({ autoWake: false, cached: true, storedPlugins: [{ url: base, status: 1 }, { url: base + '#lampa-remote=%7B%22port%22%3A20000%7D', status: 1 }] });
  assert.equal(f.window.__lampaRemote, undefined); assert.equal(f.listeners.size, 0);
});

test('clock skew does not expire a newly received command; stale queued actions never execute', async t => {
  const f = pluginFixture({ clockSkew: 60000 }); t.after(f.stop);
  const status = await f.response(f.send('status'));
  assert.equal(status.error, undefined);
  assert.equal(status.result.appVersion, '3.3.8');
  const first = f.send('key', { key: 'up' }, 1000);
  const stale = f.send('key', { key: 'down' }, 10);
  f.advance(100);
  assert.equal((await f.response(first)).error, undefined);
  assert.equal((await f.response(stale)).error.code, 'COMMAND_EXPIRED');
  assert.deepEqual(f.moved, ['up']);
});

test('credential fields are refused or redacted even when their values are short', async t => {
  const f = pluginFixture({ fieldName: 'jackett_key' }); t.after(f.stop);
  const settings = await f.response(f.send('settings.get'));
  const ui = await f.response(f.send('ui'));
  const field = await f.response(f.send('settings.get', { key: 'jackett_key' }));
  const input = await f.response(f.send('input'));
  assert.equal(field.error.code, 'SETTING_NOT_AVAILABLE');
  assert.equal(input.error.code, 'SENSITIVE_INPUT_REFUSED');
  assert.equal(ui.result.items[0].value, '[redacted]');
  assert.doesNotMatch(JSON.stringify([settings, ui, field, input]), /DUMMY1234/);
  assert.equal(settings.result.settings.length, 1);
});

test('input distinguishes DOM writes, application mismatch, confirmation and unavailable mirrors', async t => {
  for (const [options, expected] of [[{ mirror: 'old' }, false], [{ mirror: 'old', reflectInput: true }, true], [{ mirror: null }, null]]) {
    const f = pluginFixture(options); t.after(f.stop);
    const reply = await f.response(f.send('input', { text: 'Привет 🌊' }));
    assert.equal(reply.error, undefined);
    assert.equal(reply.result.domWritten, true);
    assert.equal(reply.result.appConfirmed, expected);
    assert.equal(reply.result.confirmed, undefined);
    assert.equal(reply.result.submitted, false);
  }
});

test('invalid WS requests are ignored and a subsequent valid command still works', async t => {
  const f = pluginFixture(); t.after(f.stop);
  for (const value of [null, [], {}, { id: 'x', method: 'eval', params: {}, ttlMs: 1000 }]) f.socket.onmessage({ data: JSON.stringify(value) });
  assert.equal((await f.response(f.send('player'))).result.webVideo, false);
});

test('UI/action/settings/logs retain their basic behavior and stale IDs cannot activate a new target', async t => {
  const f = pluginFixture(); t.after(f.stop);
  const initial = await f.response(f.send('ui'));
  const firstId = initial.result.items.find(item => item.key === 'background').id;
  await f.response(f.send('ui'));
  assert.equal((await f.response(f.send('action', { id: firstId }))).error.code, 'STALE_TARGET');
  assert.equal(f.actions(), 0);
  const current = await f.response(f.send('ui'));
  const id = current.result.items.find(item => item.key === 'background').id;
  assert.equal((await f.response(f.send('action', { id }))).result.dispatched, true);
  assert.equal((await f.response(f.send('settings.get', { key: 'background' }))).result.value, true);
  const setting = await f.response(f.send('settings.set', { key: 'background', value: false }));
  assert.equal(setting.result.before.value, true);
  assert.equal(setting.result.after.value, false);
  assert.equal(setting.result.confirmed, true);
  assert.equal((await f.response(f.send('settings.open', { section: 'interface' }))).result.dispatched, true);
  f.warn('jackett_key DUMMY1234');
  f.warn('Network unavailable');
  const logs = await f.response(f.send('logs'));
  assert.doesNotMatch(JSON.stringify(logs), /DUMMY1234/);
  assert.match(JSON.stringify(logs), /Network unavailable/);
});

test('passive wake consumes both key phases, attempts once, never polls, and stop removes owned listeners', async t => {
  const f = pluginFixture({ autoWake: false }); t.after(() => { if (f.listeners.has('keydown')) f.stop(); });
  assert.equal(f.connections(), 0);
  assert.equal(f.timers(), 0);
  assert.deepEqual(f.wake('keydown', false, 120), { prevented: false, stopped: false, capture: true });
  assert.equal(f.connections(), 0);
  assert.deepEqual(f.wake(), { prevented: true, stopped: true, capture: true });
  assert.deepEqual(f.wake('keyup'), { prevented: true, stopped: true, capture: true });
  f.wake('keydown', true);
  assert.equal(f.connections(), 1);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.connections(), 1);
  assert.equal(f.timers(), 0);
  f.wake(); f.open();
  assert.equal(f.connections(), 2);
  f.getSocket().close();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.connections(), 2);
  assert.equal(f.timers(), 0);
  f.stop();
  assert.equal(f.listeners.size, 0);
  f.wake(); assert.equal(f.connections(), 2);
  const closing = pluginFixture({ autoWake: false });
  t.after(() => { if (closing.listeners.has('keydown')) closing.stop(); });
  closing.wake(); closing.getSocket().readyState = 2; closing.wake();
  assert.equal(closing.connections(), 1);
  closing.stop();
});

test('hidden current input mirror confirms app state, while unrelated or ambiguous mirrors do not', async t => {
  for (const [options, expected] of [
    [{ hiddenMirror: true, reflectInput: true }, true],
    [{ hiddenMirror: true }, false],
    [{ hiddenMirror: true, reflectInput: true, unrelatedMirror: true }, null],
    [{ hiddenMirror: true, reflectInput: true, extraMirror: true }, null],
  ]) {
    const f = pluginFixture(options); t.after(f.stop);
    const response = await f.response(f.send('input', { text: 'Тест Lampa 123' }));
    assert.equal(response.error, undefined);
    const result = response.result;
    assert.equal(result.domWritten, true);
    assert.equal(result.appConfirmed, expected);
  }
});
