import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { createBridge } from '../dist/bridge.js';

async function fixture(t, timeout = 1000, appOrigin = 'http://lampa.mx') {
  const bridge = createBridge({ port: 0, timeout, appOrigin });
  const port = await bridge.listen();
  t.after(() => bridge.close());
  const url = `http://127.0.0.1:${port}`;
  const call = async (method = 'status', params = {}) => {
    const r = await fetch(url + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    return { status: r.status, body: await r.json() };
  };
  const tv = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tv`, { origin: appOrigin });
    await once(ws, 'open');
    const h = (await (await fetch(url + '/health?passive=1', { headers: { 'Content-Type': 'application/json' } })).json()).data;
    ws.send(JSON.stringify({ type: 'hello', data: { protocolVersion: 2, pluginVersion: h.version, browserWakeCode: 119, origin: appOrigin, appready: true, appVersion: '3.3.8' } }));
    return ws;
  };
  return { url, call, tv, port, address: bridge.server.address() };
}

test('tokenless loopback API rejects browser HTTP, rebinding hosts and foreign or missing WS origins', async t => {
  const f = await fixture(t);
  assert.equal(f.address.address, '127.0.0.1');
  const rawStatus = (path, headers, body) => new Promise((resolve, reject) => {
    const req = httpRequest(f.url + path, { method: body ? 'POST' : 'GET', headers }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject); req.end(body);
  });
  assert.equal((await fetch(f.url + '/health')).status, 200);
  assert.equal((await fetch(f.url + '/plugin.js')).status, 404);
  for (const headers of [{ Origin: 'https://example.org' }, { Origin: 'http://lampa.mx' }, { Host: 'evil.example' }, { Host: '127.0.0.1:1' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal(await rawStatus('/health', headers), 403, JSON.stringify(headers));
    assert.equal(await rawStatus('/rpc', { ...headers, 'Content-Type': 'application/json' }, '{"method":"key","params":{"key":"enter"}}'), 403);
  }
  const form = await fetch(f.url + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'method=key' });
  assert.equal(form.status, 415);
  for (const options of [{}, { origin: 'https://example.org' }, { origin: 'null' }, { origin: 'http://lampa.mx', headers: { Host: 'evil.example' } }]) {
    const ws = new WebSocket(`ws://127.0.0.1:${f.port}/tv`, options);
    const [error] = await once(ws, 'error'); assert.match(error.message, /403/);
  }
  assert.equal((await f.call()).body.error.code, 'TV_DISCONNECTED');
  const ws = await f.tv();
  ws.once('message', data => { const r = JSON.parse(data); ws.send(JSON.stringify({ id: r.id, result: { survived: true } })); });
  assert.equal((await f.call()).body.data.survived, true);
  const custom = await fixture(t, 1000, 'https://tv.example');
  const wrong = new WebSocket(`ws://127.0.0.1:${custom.port}/tv`, { origin: 'http://lampa.mx' });
  const [error] = await once(wrong, 'error'); assert.match(error.message, /403/);
  const allowed = await custom.tv();
  allowed.once('message', data => { const r = JSON.parse(data); allowed.send(JSON.stringify({ id: r.id, result: { configuredOrigin: true } })); });
  assert.equal((await custom.call()).body.data.configuredOrigin, true);
});

test('malformed HTTP/WS objects including null do not crash or poison the next RPC', async t => {
  const f = await fixture(t);
  for (const value of [null, [], 7, true, { method: 'ui', params: null }]) {
    const response = await fetch(f.url + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
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
  const health = await fetch(f.url + '/health', { headers: { 'Content-Type': 'application/json' } });
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

test('deep WS hello/event/response cannot overflow redaction or poison the next health/RPC', async t => {
  const f = await fixture(t);
  const deep = '['.repeat(10000) + '0' + ']'.repeat(10000);
  for (const type of ['hello', 'event', 'response']) {
    const ws = await f.tv(); const closed = once(ws, 'close');
    if (type === 'response') {
      ws.once('message', data => { const r = JSON.parse(data); ws.send('{"id":' + JSON.stringify(r.id) + ',"result":' + deep + '}'); });
      const r = await f.call(); assert.equal(r.body.error.outcome, 'unknown'); assert.equal(r.body.error.code, 'INVALID_PEER_MESSAGE');
    } else ws.send('{"type":' + JSON.stringify(type) + ',"data":' + deep + '}');
    await closed;
    assert.equal((await fetch(f.url + '/health?passive=1', { headers: { 'Content-Type': 'application/json' } })).status, 200);
    const next = await f.tv();
    next.once('message', data => { const r = JSON.parse(data); next.send(JSON.stringify({ id: r.id, result: { survived: type } })); });
    assert.equal((await f.call()).body.data.survived, type);
    const nextClosed = once(next, 'close'); next.close(); await nextClosed;
  }
});
