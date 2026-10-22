import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

export function pluginFixture({ mirror = 'old', fieldName = 'query', clockSkew = 0, reflectInput = false, autoWake = true, hiddenMirror = false, unrelatedMirror = false, extraMirror = false } = {}) {
  let monotonic = 0;
  const sent = [], moved = [], listeners = new Map(), timers = new Set();
  let connections = 0;
  let background = false, actions = 0;
  const root = { nodeType: 0, parentElement: null };
  function element(text = '', attrs = {}, left = 0) {
    return {
      textContent: text, innerText: text, className: 'selector', classList: { contains: () => false }, nodeType: 1,
      parentElement: root, attrs, disabled: false, readOnly: false, maxLength: -1,
      getAttribute(name) { return this.attrs[name] ?? null; },
      contains(child) { return child === this || child.parentElement === this; },
      closest(selector) { return selector === '[data-name]' ? this.attrs['data-name'] ? this : null : unrelatedMirror && selector.includes(',') ? null : context; },
      getBoundingClientRect: () => ({ left, top: 0, right: left + 100, bottom: 40 }),
      querySelector: () => null,
      dispatchEvent(event) { if (reflectInput && event.type === 'input' && appMirror) appMirror.textContent = this.value; },
    };
  }
  const context = { querySelector: () => null, querySelectorAll: () => [appMirror, extraMirror ? otherMirror : null].filter(Boolean) };
  const field = Object.assign(element('', {}, 0), { value: 'old', name: fieldName, id: '', type: 'text', autocomplete: '' });
  const appMirror = mirror === null ? null : element(mirror, {}, 200);
  if (appMirror) appMirror.hidden = hiddenMirror;
  const otherMirror = element('unrelated', {}, 300);
  const secretRow = element('Jackett key DUMMY1234', { 'data-name': 'jackett_key' }, 400);
  secretRow.querySelector = selector => selector === '.settings-param__value' ? { innerText: 'DUMMY1234' } : null;
  const backgroundRow = element('Background', { 'data-name': 'background', 'data-type': 'toggle', 'data-component': 'interface' }, 600);
  backgroundRow.querySelector = selector => selector === '.settings-param__value' ? { innerText: String(background) } : null;
  const settingsButton = element('Settings', {}, 800);
  const nodes = [field, appMirror, extraMirror ? otherMirror : null, secretRow, backgroundRow, settingsButton].filter(Boolean);
  const document = {
    hidden: false, visibilityState: 'visible', activeElement: field,
    body: { classList: { contains: () => true } },
    documentElement: { contains: el => nodes.includes(el) },
    querySelector: selector => selector === '.open--settings' ? settingsButton : selector === '.settings [data-component="interface"]' ? backgroundRow : null,
    querySelectorAll: selector => selector === 'input,textarea' ? [field] : selector === '.selector' || selector === '.settings [data-name]' ? [secretRow, backgroundRow] : selector === '.search__input,.settings-input__input' ? appMirror ? [appMirror] : [] : [],
    elementFromPoint: x => nodes.find(el => { const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right; }),
  };
  class Socket {
    static current;
    constructor() { connections++; Socket.current = this; this.readyState = 0; }
    send(value) { sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  class WallClock extends Date { static now() { return Date.now() + clockSkew; } }
  const window = { appready: true, addEventListener: (name, fn, capture) => listeners.set(name, { fn, capture }), removeEventListener: name => listeners.delete(name) };
  const sandbox = {
    window, document, console: { warn() {}, error() {} }, location: { origin: 'http://test' }, innerWidth: 1000, innerHeight: 1000,
    getComputedStyle: el => ({ display: el.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' }),
    setTimeout: (fn, ms) => { const handle = setTimeout(() => { timers.delete(handle); fn(); }, ms); timers.add(handle); return handle; }, clearTimeout: handle => { timers.delete(handle); clearTimeout(handle); }, requestAnimationFrame: fn => queueMicrotask(fn), WebSocket: Socket, performance: { now: () => monotonic }, Date: WallClock,
    Event: class { constructor(type) { this.type = type; } },
    Lampa: {
      Manifest: { app_version: '3.3.8' }, Activity: { active: () => ({}) },
      Controller: { enabled: () => ({ name: 'content' }), move: key => moved.push(key), collectionFocus() {} },
      Params: { defaults: { jackett_key: '', background: true } },
      Storage: { field: key => key === 'jackett_key' ? 'DUMMY1234' : background },
      Utils: { trigger: element => { actions++; if (element === backgroundRow) background = !background; } },
      Settings: { listener: { follow() {}, remove() {} } }, Listener: { follow() {}, remove() {} },
    },
  };
  const source = readFileSync(new URL('../plugin/remote.js', import.meta.url), 'utf8').replace('__REMOTE_CONFIG__', JSON.stringify({ token: 'test', socket: 'ws://test', version: '0.2.0', protocolVersion: 1, sourceHash: 'fixture', browserWakeCode: 119, wakeTimeoutMs: 30 }));
  vm.runInNewContext(source, sandbox);
  function wake(type = 'keydown', repeat = false, code = 119) {
    let prevented = false, stopped = false;
    const event = { type, repeat, keyCode: code, preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => { stopped = true; } };
    listeners.get(type)?.fn(event);
    return { prevented, stopped, capture: listeners.get(type)?.capture };
  }
  function open() { Socket.current.readyState = 1; Socket.current.onopen(); }
  if (autoWake) { wake(); wake('keyup'); open(); }
  let sequence = 0;
  function send(method, params = {}, ttlMs = 1000) {
    const id = String(++sequence);
    Socket.current.onmessage({ data: JSON.stringify({ id, method, params, ttlMs, expiresAt: Date.now() + ttlMs }) });
    return id;
  }
  async function response(id) {
    for (let i = 0; i < 50; i++) {
      const result = sent.find(m => m.id === id);
      if (result) return result;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Plugin did not respond to ' + id);
  }
  return { send, response, sent, moved, field, appMirror, advance: ms => { monotonic += ms; }, stop: () => window.__lampaRemote.stop(), socket: Socket.current, actions: () => actions, warn: message => sandbox.console.warn(message), wake, open, connections: () => connections, timers: () => timers.size, listeners, getSocket: () => Socket.current };
}
