import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

export function pluginFixture({ mirror = 'old', fieldName = 'query', clockSkew = 0, reflectInput = false, autoWake = true, hiddenMirror = false, unrelatedMirror = false, extraMirror = false, rows = [], replaceRows = false, remoteConfig = {}, onAction, onFocus, screensaver = null, hitTesting = {} } = {}) {
  let monotonic = 0;
  const sent = [], moved = [], listeners = new Map(), timers = new Set();
  let connections = 0;
  let background = false, actions = 0;
  let controllerName = 'content', settingsListener;
  const root = { nodeType: 0, parentElement: null };
  function element(text = '', attrs = {}, left = 0) {
    return {
      textContent: text, innerText: text, className: 'selector', classList: { contains: () => false }, nodeType: 1,
      parentElement: root, attrs, disabled: false, readOnly: false, maxLength: -1,
      getAttribute(name) { return this.attrs[name] ?? null; },
      contains(child) { return child === this || child.parentElement === this; },
      closest(selector) { return selector === '[data-name]' || selector === '[data-component]' ? this.attrs[selector.slice(1, -1)] ? this : null : unrelatedMirror && selector.includes(',') ? null : context; },
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
  const scenarioRows = rows.map((row, index) => {
    const el = element(row.text, { ...row.attrs }, 0);
    const left = index % 10 * 90, top = 100 + Math.floor(index / 10) * 28;
    el.getBoundingClientRect = () => ({ left, top, right: left + 80, bottom: top + 20 });
    return el;
  });
  const selectors = replaceRows ? scenarioRows : [secretRow, backgroundRow, ...scenarioRows];
  const saver = screensaver && { active: !!screensaver.active, overlayVisible: !!screensaver.active, resets: 0, stops: 0 };
  const overlay = element('Screensaver'); Object.defineProperty(overlay, 'hidden', { get: () => !saver?.overlayVisible });
  const nodes = [field, appMirror, extraMirror ? otherMirror : null, secretRow, backgroundRow, settingsButton, overlay, ...scenarioRows].filter(Boolean);
  const document = {
    hidden: false, visibilityState: 'visible', activeElement: field,
    head: { querySelectorAll: () => hitTesting.styles || [] },
    body: { classList: { contains: () => true } },
    documentElement: { contains: el => nodes.includes(el) && !el.detached },
    querySelector: selector => selector === '.open--settings' ? settingsButton : selector === '.settings [data-component="interface"]' ? backgroundRow : null,
    querySelectorAll: selector => selector === '.screensaver-layer' ? saver ? [overlay] : [] : selector === 'input,textarea' ? [field] : selector === '.selector' ? selectors : selector === '.settings [data-name]' ? selectors.filter(el => el.attrs['data-name']) : selector === '.search__input,.settings-input__input' ? appMirror ? [appMirror] : [] : [],
    elementFromPoint: (x, y) => {
      if (hitTesting.throw) throw new Error('Synthetic hit-test failure');
      if ((hitTesting.styles || []).some(style => !style.sheet.disabled && style.textContent.includes('pointer-events: none !important'))) return root;
      return saver?.overlayVisible || hitTesting.occluded ? overlay : nodes.find(el => { const r = el.getBoundingClientRect(); return !el.hidden && !el.detached && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
    },
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
      Screensaver: saver ? { isWorked: () => saver.active, resetTimer: () => { saver.resets++; }, stop: () => { saver.stops++; saver.active = false; } } : undefined,
      Controller: { enabled: () => ({ name: controllerName }), move: key => moved.push(key), collectionFocus: el => onFocus?.(el) },
      Params: { defaults: { jackett_key: '', background: true } },
      Storage: { field: key => key === 'jackett_key' ? 'DUMMY1234' : background },
      Utils: { trigger: element => { actions++; if (element === backgroundRow) background = !background; onAction?.(element); } },
      Settings: { listener: { follow: (_, fn) => { settingsListener = fn; }, remove: () => { settingsListener = undefined; } } }, Listener: { follow() {}, remove() {} },
    },
  };
  const source = readFileSync(new URL('../plugin/remote.js', import.meta.url), 'utf8').replace('__REMOTE_CONFIG__', JSON.stringify({ token: 'test', socket: 'ws://test', version: '0.2.0', protocolVersion: 1, sourceHash: 'fixture', browserWakeCode: 119, wakeTimeoutMs: 30, ...remoteConfig }));
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
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const result = sent.find(m => m.id === id);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.fail('Plugin did not respond to ' + id);
  }
  return { send, response, sent, moved, field, appMirror, saver, finishFade: () => { saver.overlayVisible = false; }, rows: scenarioRows, setController: name => { controllerName = name; }, setSection: name => settingsListener?.({ name }), setBackground: value => { background = value; }, advance: ms => { monotonic += ms; }, stop: () => window.__lampaRemote.stop(), socket: Socket.current, actions: () => actions, warn: message => sandbox.console.warn(message), wake, open, connections: () => connections, timers: () => timers.size, listeners, getSocket: () => Socket.current };
}
