import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { WebSocket } from 'ws';
import { createBridge } from '../dist/bridge.js';

const token = 'a'.repeat(64);
async function fixture(t, timeout = 1000) {
  const bridge = createBridge({ token, port: 0, timeout });
  const port = await bridge.listen();
  t.after(() => bridge.close());
  const url = `http://127.0.0.1:${port}`;
  const call = async (method = 'status', params = {}) => {
    const r = await fetch(url + '/rpc', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ method, params }) });
    return { status: r.status, body: await r.json() };
  };
  const tv = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tv?token=${token}`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', data: { protocolVersion: 1, appVersion: '3.3.8' } }));
    return ws;
  };
  return { url, call, tv, port };
}

test('HTTP and WS auth, origin policy, and authorized plugin delivery are preserved', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url + '/health')).status, 401);
  assert.equal((await fetch(f.url + '/plugin.js?token=' + encodeURIComponent('é'.repeat(64)))).status, 401);
  assert.equal((await fetch(f.url + '/health', { headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.org' } })).status, 403);
  const script = await fetch(f.url + '/plugin.js?token=' + token, { headers: { Origin: 'http://lampa.mx' } });
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('access-control-allow-origin'), '*');
  assert.match(await script.text(), /protocolVersion/);
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/tv?token=wrong`);
  const [error] = await once(ws, 'error');
  assert.match(error.message, /403/);
  assert.equal((await f.call()).body.error.code, 'TV_DISCONNECTED');
});

test('malformed HTTP/WS objects including null do not crash or poison the next RPC', async t => {
  const f = await fixture(t);
  for (const value of [null, [], 7, true, { method: 'ui', params: null }]) {
    const response = await fetch(f.url + '/rpc', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(value) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).ok, false);
  }
  const ws = await f.tv();
  for (const value of [null, [], 7, true, {}, { type: 'event', data: null }, '{']) ws.send(typeof value === 'string' ? value : JSON.stringify(value));
  ws.on('message', data => { const r = JSON.parse(data); ws.send(JSON.stringify({ id: r.id, result: { alive: true } })); });
  const result = await f.call();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, { alive: true });
});

test('malformed upgrade URL is rejected before auth without killing the bridge', async t => {
  const f = await fixture(t);
  const raw = connect(f.port, '127.0.0.1');
  await once(raw, 'connect');
  let response = ''; raw.on('data', chunk => { response += chunk; });
  raw.write('GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: YWJjZGVmZ2hpamtsbW5vcA==\r\n\r\n');
  await once(raw, 'close');
  assert.match(response, /^HTTP\/1.1 400/);
  const health = await fetch(f.url + '/health', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(health.status, 200);
  const ws = await f.tv();
  ws.on('message', data => { const r = JSON.parse(data); ws.send(JSON.stringify({ id: r.id, result: { survived: true } })); });
  assert.equal((await f.call()).body.data.survived, true);
});

test('RPC correlation, validation, protocol TTL and credential redaction', async t => {
  const f = await fixture(t);
  const ws = await f.tv();
  let calls = 0;
  ws.on('message', data => {
    calls++;
    const r = JSON.parse(data);
    assert.equal(r.ttlMs, 1000);
    assert.equal(r.expiresAt, undefined);
    ws.send(JSON.stringify({ id: r.id, result: { method: r.method, settings: [{ key: 'jackett_key', value: 'DUMMY1234' }], auth_token: 'SHORTSECRET' } }));
  });
  const results = await Promise.all([f.call('status'), f.call('ui')]);
  assert.deepEqual(results.map(r => r.body.data.method), ['status', 'ui']);
  assert.equal(results[0].body.data.settings[0].key, 'jackett_key');
  assert.equal(results[0].body.data.settings[0].value, '[redacted]');
  assert.doesNotMatch(JSON.stringify(results), /DUMMY1234|SHORTSECRET/);
  assert.equal((await f.call('eval')).status, 400);
  assert.equal((await f.call('key', { key: 'wrong' })).status, 400);
  assert.equal((await f.call('settings.set', { key: 'background', value: 'true' })).status, 400);
  assert.equal(calls, 2);
});

test('disconnect and timeout expose unknown outcome without replaying mutations', async t => {
  const f = await fixture(t, 50);
  let ws = await f.tv();
  ws.once('message', () => ws.close());
  const disconnected = await f.call('key', { key: 'enter' });
  assert.equal(disconnected.body.error.outcome, 'unknown');
  ws = await f.tv();
  let calls = 0;
  ws.on('message', () => calls++);
  const timedOut = await f.call('key', { key: 'enter' });
  assert.equal(timedOut.status, 504);
  assert.equal(timedOut.body.error.code, 'TV_TIMEOUT');
  assert.equal(timedOut.body.error.outcome, 'unknown');
  assert.equal(calls, 1);
});
