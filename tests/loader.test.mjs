import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../plugin/loader.js', import.meta.url), 'utf8');
const token = 'ab'.repeat(32);
const config = { url: `http://127.0.0.1:18657/plugin.js?token=${token}`, browserWakeCode: 119, wakeTimeoutMs: 20000 };
const install = value => 'https://raw.githubusercontent.com/krajcik/lampa-remote/main/plugin/loader.js#lampa-remote=' + encodeURIComponent(JSON.stringify(value));

function fixture({ current = install(config), stored = [], pairing = config } = {}) {
  const listeners = new Map(), timers = new Map(), requests = [], warnings = [];
  const head = {
    appendChild(script) { script.parentNode = head; requests.push(script); },
    removeChild(script) { script.parentNode = null; },
  };
  const context = vm.createContext({
    document: { currentScript: current ? { src: current } : null, head, createElement: () => ({}) },
    Lampa: { Storage: { get: () => stored }, Manifest: {} },
    console: { warn: message => warnings.push(message) },
    setTimeout(fn, ms) { const id = timers.size + 1; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, handler, capture) { assert.equal(capture, true); listeners.set(type, handler); },
    removeEventListener(type, handler, capture) { assert.equal(capture, true); if (listeners.get(type) === handler) listeners.delete(type); },
  });
  context.window = context;
  const run = () => vm.runInContext(source, context);
  const key = (type, code = pairing.browserWakeCode) => {
    const event = { type, keyCode: code, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    listeners.get(type)?.(event); return event;
  };
  run();
  return { context, run, key, timers, listeners, requests, warnings };
}

test('GitHub loader is passive until wake, bounds one load and yields service keys to the real plugin', () => {
  const f = fixture();
  assert.equal(f.requests.length, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.key('keydown', 19).stopped, false);
  assert.equal(f.key('keydown').stopped, true);
  assert.equal(f.key('keyup').prevented, true);
  f.key('keydown');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].src, config.url);
  assert.equal([...f.timers.values()][0].ms, config.wakeTimeoutMs);
  f.context.__lampaRemote = {};
  f.requests[0].onload();
  assert.equal(f.timers.size, 0); assert.equal(f.requests[0].parentNode, null);
  assert.equal(f.key('keydown').stopped, false);
  assert.equal(f.key('keyup').stopped, false);
  assert.equal(f.requests.length, 1);
});

test('offline bridge does not cause polling; error and timeout allow only a later explicit wake', () => {
  const f = fixture();
  f.key('keydown'); f.requests[0].onerror();
  assert.equal(f.timers.size, 0); assert.equal(f.requests.length, 1);
  f.key('keyup'); assert.equal(f.requests.length, 1);
  f.key('keydown'); assert.equal(f.requests.length, 2);
  [...f.timers.values()][0].fn();
  assert.equal(f.timers.size, 0); assert.equal(f.requests[1].parentNode, null);
  assert.equal(f.requests.length, 2);
  f.key('keydown'); assert.equal(f.requests.length, 3);
  f.context.__lampaRemoteLoader.stop();
  assert.equal(f.listeners.size, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.requests[2].parentNode, null);
  assert.equal(f.context.__lampaRemoteLoader, undefined);
});

test('cached inline loader finds one enabled local registration, honors configured codes and avoids duplicate hooks', () => {
  const custom = { ...config, browserWakeCode: 120, wakeTimeoutMs: 1800 };
  const f = fixture({ current: null, pairing: custom, stored: [
    { url: install(config), status: 0 }, { url: install(custom), status: 1 },
  ] });
  const listener = f.listeners.get('keydown'); f.run();
  assert.equal(f.listeners.get('keydown'), listener);
  assert.equal(f.key('keydown', 119).stopped, false);
  f.key('keydown');
  assert.equal(f.requests.length, 1); assert.equal([...f.timers.values()][0].ms, 1800);
  for (const stored of [[install(config)], [{ url: install(config), status: 1 }]]) {
    const cached = fixture({ current: null, stored });
    cached.key('keydown'); assert.equal(cached.requests[0].src, config.url);
  }
  const ambiguous = fixture({ current: null, stored: [install(config), install(custom)] });
  assert.equal(ambiguous.listeners.size, 0); assert.equal(ambiguous.requests.length, 0);
});

test('loader rejects malformed or non-loopback configuration without leaking credentials', () => {
  for (const value of [null, {}, { ...config, url: `https://example.com/?token=${token}` },
    { ...config, url: config.url.replace('18657', '65536') }, { ...config, url: config.url + '&redirect=x' },
    { ...config, url: config.url.replace('/plugin.js', '/other.js') },
    { ...config, browserWakeCode: 0 }, { ...config, wakeTimeoutMs: 60001 }]) {
    const f = fixture({ current: install(value) });
    assert.equal(f.listeners.size, 0); assert.equal(f.requests.length, 0); assert.equal(f.timers.size, 0);
    assert.doesNotMatch(f.warnings.join('\n'), new RegExp(token));
  }
  const malformed = fixture({ current: 'https://example.com/loader.js#lampa-remote=%ZZ' });
  assert.equal(malformed.listeners.size, 0);
  // Lampa appends metadata after the fragment with its string-based addUrlComponent.
  const appended = fixture({ current: install(config) + '?logged=false&reset=0.1' });
  appended.key('keydown'); assert.equal(appended.requests[0].src, config.url);
});
