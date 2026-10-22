(function (config) {
    'use strict';
    if (window.__lampaRemote) return;
    Lampa.Manifest.plugins = { type: 'other', version: config.version, name: 'Lampa Remote', description: 'Local terminal control and diagnostics via ADB reverse', component: 'lampa_remote' };
    var socket, timer, stopped = false, chain = Promise.resolve();
    var targets = {}, snapshot = 0, session = Math.random().toString(36).slice(2);
    var logs = [], logId = 0, settingsSection = null;
    var sensitive = /token|password|passwd|secret|cookie|email|login|authorization|account|credential|api.?key|key$|парол|токен|почт|логин|ключ|(^|[^a-z0-9])(key|auth|session|pass)(?=$|[^a-z0-9])/i;
    function error(code) { throw new Error(code); }
    function clean(value) {
        var text = String(value || '');
        if (sensitive.test(text)) return '[sensitive diagnostic redacted]';
        return text.replace(/https?:\/\/[^\s"'<>]+/g, '[url]').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]').replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[opaque]').slice(0, 300);
    }
    function send(value) { if (socket && socket.readyState === 1) socket.send(JSON.stringify(value)); }
    function record(kind, message) {
        var entry = { id: ++logId, at: Date.now(), kind: kind, message: clean(message) };
        logs.push(entry); if (logs.length > 100) logs.shift();
        send({ type: 'event', data: entry });
    }
    function controller() { return Lampa.Controller.enabled().name; }
    function status() {
        var a = Lampa.Activity.active() || {};
        return { pluginVersion: config.version, protocolVersion: config.protocolVersion, browserWakeCode: config.browserWakeCode, sourceHash: config.sourceHash, appVersion: Lampa.Manifest.app_version, appready: !!window.appready, origin: location.origin, component: a.component || null, title: clean(a.title), controller: controller(), settingsSection: settingsSection, visibility: document.visibilityState, viewport: { width: innerWidth, height: innerHeight }, at: Date.now() };
    }
    function label(el) {
        var child = el.querySelector('.settings-param__name,.settings-folder__name,.menu__text,.card__title,.selectbox-item__title');
        return clean((child && child.innerText) || el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.className).replace(/\s+/g, ' ').trim().slice(0, 160);
    }
    function visible(el) {
        if (!document.documentElement.contains(el)) return false;
        for (var p = el; p && p.nodeType === 1; p = p.parentElement) {
            var style = getComputedStyle(p);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        }
        var r = el.getBoundingClientRect();
        var left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
        if (right <= left || bottom <= top) return false;
        var points = [[(left + right) / 2, (top + bottom) / 2], [left + 1, top + 1], [right - 1, bottom - 1]];
        return points.some(function (pt) { var hit = document.elementFromPoint(pt[0], pt[1]); return hit && (hit === el || el.contains(hit)); });
    }
    function identity(el, name) {
        var row = el.closest('[data-name]') || el;
        var section = el.closest('[data-component]');
        return { el: el, label: label(el), key: row.getAttribute('data-name'), section: section ? section.getAttribute('data-component') : null, controller: name };
    }
    function eligible(el) { return !el.disabled && el.getAttribute('aria-disabled') !== 'true' && visible(el); }
    function candidates() {
        var name = controller();
        var root = name === 'settings' || name === 'settings_component' ? document.querySelector('.settings') : document;
        return Array.prototype.filter.call((root || document).querySelectorAll('.selector'), eligible).map(function (el) { return identity(el, name); });
    }
    function matches(target, p, exact) {
        var text = sensitive.test(target.key || '') ? '[sensitive setting]' : target.label;
        return (p.text === undefined || (exact ? text === p.text : text.indexOf(p.text) >= 0)) &&
            (p.key === undefined || target.key === p.key) && (p.section === undefined || target.section === p.section);
    }
    function sameTarget(target) {
        if (!eligible(target.el) || controller() !== target.controller) return false;
        var current = identity(target.el, controller());
        return current.label === target.label && current.key === target.key && current.section === target.section;
    }
    function ui(p) {
        p = p || {};
        var filters = ['text', 'key', 'section'].filter(function (key) { return p[key] !== undefined; });
        if (filters.length > 1 || filters.some(function (key) { return typeof p[key] !== 'string' || !p[key].length; }) ||
            (p.full !== undefined && typeof p.full !== 'boolean') || (p.limit !== undefined && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 150))) error('INVALID_UI_PARAMS');
        targets = {}; snapshot++;
        var all = candidates(), selected = all.filter(function (target) { return matches(target, p, false); });
        var limit = p.limit === undefined ? (p.full ? 150 : 50) : p.limit;
        var items = selected.slice(0, limit).map(function (target, index) {
            var el = target.el, id = session + ':' + snapshot + ':' + index;
            targets[id] = target;
            var val = el.querySelector('.settings-param__value');
            var item = { id: id, text: sensitive.test(target.key || '') ? '[sensitive setting]' : target.label, key: target.key, section: target.section,
                value: sensitive.test(target.key || '') ? '[redacted]' : val ? clean(val.innerText) : null, focused: el.classList.contains('focus') };
            if (p.full) { var r = el.getBoundingClientRect(); item.bounds = [r.left, r.top, r.right, r.bottom].map(Math.round); }
            return item;
        });
        var current = status();
        var result = { state: p.full ? current : { controller: current.controller, component: current.component, title: current.title },
            snapshot: session + ':' + snapshot, items: items, totalVisible: all.length, matchedVisible: selected.length, returned: items.length, limit: limit, truncated: selected.length > items.length };
        if (p.full) result.visibilityMethod = 'DOM styles + viewport + hit testing';
        return result;
    }
    function activate(el, target) {
        if (!visible(el)) error('TARGET_NOT_VISIBLE');
        Lampa.Controller.collectionFocus(el, el.parentElement, true);
        if (target && !sameTarget(target)) error('STALE_TARGET: request ui again');
        Lampa.Utils.trigger(el, 'hover:enter');
    }
    function waitFor(predicate, timeout) {
        var deadline = performance.now() + (timeout || 1200);
        return new Promise(function (resolve, reject) {
            function check() {
                if (predicate()) return resolve();
                if (performance.now() >= deadline) return reject(new Error('STATE_NOT_CONFIRMED'));
                setTimeout(check, 25);
            }
            check();
        });
    }
    // shortcut: a DOM snapshot acknowledges dispatch, not network/render completion; the caller must check its task-specific condition.
    function settle() { return new Promise(function (resolve) {
        var timer = setTimeout(resolve, 250);
        requestAnimationFrame(function () { requestAnimationFrame(function () { clearTimeout(timer); resolve(); }); });
    }); }
    function setting(key) {
        if (typeof key !== 'string' || sensitive.test(key) || !Object.prototype.hasOwnProperty.call(Lampa.Params.defaults, key)) error('SETTING_NOT_AVAILABLE');
        var value = Lampa.Storage.field(key);
        if (value !== null && !['string', 'boolean', 'number'].includes(typeof value)) error('COMPLEX_SETTING_NOT_SUPPORTED');
        return { key: key, value: typeof value === 'string' ? clean(value) : value };
    }
    function player() {
        var v = document.querySelector('video');
        if (!v) return { webVideo: false, note: 'External/native player is outside this plugin.' };
        return { webVideo: true, paused: v.paused, currentTime: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : null, readyState: v.readyState, networkState: v.networkState, videoWidth: v.videoWidth, videoHeight: v.videoHeight, muted: v.muted, volume: v.volume, error: v.error ? { code: v.error.code, message: clean(v.error.message) } : null };
    }
    function input(p) {
        var fields = Array.prototype.filter.call(document.querySelectorAll('input,textarea'), visible);
        var field = fields.indexOf(document.activeElement) >= 0 ? document.activeElement : fields.length === 1 ? fields[0] : null;
        if (!field) error('NO_UNIQUE_EDITABLE_FIELD');
        var context = field.closest('.settings-input') || field.parentElement;
        var title = context.querySelector('.settings-input__title');
        if (field.type === 'password' || [field.name, field.id, field.getAttribute('data-name'), field.autocomplete].some(function (name) { return sensitive.test(name || ''); }) || (title && sensitive.test(title.textContent))) error('SENSITIVE_INPUT_REFUSED');
        if (p.text !== undefined) {
            if (document.hidden || field.disabled || field.readOnly) error('INPUT_NOT_EDITABLE');
            if (typeof p.text !== 'string' || p.text.length > 4096 || (field.maxLength >= 0 && p.text.length > field.maxLength)) error('INVALID_INPUT_TEXT');
            field.value = p.text;
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            if (field.value !== p.text) error('INPUT_NOT_CONFIRMED');
        }
        var panel = field.closest('.settings-input,.search__body,.search-box');
        var mirror = panel ? Array.prototype.filter.call(panel.querySelectorAll('.search__input,.settings-input__input'), function (el) { return el !== field && document.documentElement.contains(el); }) : [];
        var appText = mirror.length === 1 ? mirror[0].textContent.replace(/\u00a0/g, ' ') : null;
        return { value: clean(field.value), length: field.value.length, domWritten: p.text === undefined ? null : field.value === p.text, appConfirmed: p.text === undefined || appText === null ? null : appText === p.text, appText: appText === null ? null : clean(appText), submitted: false };
    }
    async function execute(method, p) {
        if (method === 'status') return status();
        if (method === 'ui') return ui(p);
        if (method === 'logs') return { entries: logs };
        if (method === 'player') return player();
        if (method === 'input') return input(p);
        if (method === 'settings.get') {
            if (p.key) return setting(p.key);
            return { settings: Object.keys(Lampa.Params.defaults).filter(function (key) { return !sensitive.test(key); }).map(function (key) { try { return setting(key); } catch (e) { return { key: key, unavailable: true }; } }) };
        }
        if (document.hidden) error('APP_HIDDEN');
        if (method === 'settings.open') {
            var button = document.querySelector('.open--settings');
            if (!button) error('SETTINGS_BUTTON_NOT_FOUND');
            Lampa.Utils.trigger(button, 'hover:enter');
            await waitFor(function () { return document.body.classList.contains('settings--open'); });
            if (p.section) {
                if (!/^[a-z0-9_-]+$/i.test(p.section)) error('INVALID_SECTION');
                var section = document.querySelector('.settings [data-component="' + p.section + '"]');
                if (!section) error('SECTION_NOT_FOUND');
                // Known settings controller scrolls the focused folder into view before activation.
                Lampa.Controller.collectionFocus(section, section.parentElement, true);
                await waitFor(function () { return visible(section); });
                activate(section);
            }
        } else if (method === 'settings.set') {
            var before = setting(p.key);
            if (typeof before.value !== 'boolean' || typeof p.value !== 'boolean') error('ONLY_BOOLEAN_SETTINGS_SUPPORTED');
            var rows = Array.prototype.filter.call(document.querySelectorAll('.settings [data-name]'), function (el) { return el.getAttribute('data-name') === p.key && el.getAttribute('data-type') === 'toggle' && visible(el); });
            if (rows.length !== 1) error('SETTING_MUST_BE_VISIBLE');
            if (before.value !== p.value) activate(rows[0]);
            await waitFor(function () { return Lampa.Storage.field(p.key) === p.value; });
            await settle();
            var after = setting(p.key);
            record('settings', p.key + ': ' + before.value + ' -> ' + after.value);
            return { before: before, after: after, confirmed: after.value === p.value, state: ui() };
        } else if (method === 'action') {
            var filters = ['text', 'key', 'section'].filter(function (key) { return p[key] !== undefined; });
            var target;
            if (p.id !== undefined) {
                if (typeof p.id !== 'string' || filters.length) error('INVALID_SELECTOR');
                target = Object.prototype.hasOwnProperty.call(targets, p.id) ? targets[p.id] : null;
                if (!target || !sameTarget(target)) error('STALE_TARGET: request ui again');
            } else {
                if (filters.length !== 1 || typeof p[filters[0]] !== 'string' || !p[filters[0]].length) error('INVALID_SELECTOR');
                var found = candidates().filter(function (item) { return matches(item, p, true); });
                if (!found.length) error('TARGET_NOT_FOUND');
                if (found.length !== 1) error('AMBIGUOUS_TARGET');
                target = found[0];
            }
            targets = {}; activate(target.el, target);
        } else if (method === 'key') {
            if (['up', 'down', 'left', 'right'].includes(p.key)) Lampa.Controller.move(p.key);
            else if (['enter', 'back', 'long'].includes(p.key)) Lampa.Controller[p.key]();
            else error('INVALID_KEY');
        } else error('UNKNOWN_METHOD');
        await settle();
        return { dispatched: true, state: ui(), note: 'DOM snapshot after dispatch; rendering and network completion are not asserted.' };
    }
    function connect() {
        if (stopped || socket) return;
        socket = new WebSocket(config.socket + '?token=' + encodeURIComponent(config.token));
        var connection = socket;
        timer = setTimeout(function () { if (connection.readyState < 2) connection.close(); }, config.wakeTimeoutMs);
        socket.onopen = function () { clearTimeout(timer); send({ type: 'hello', data: status() }); };
        socket.onmessage = function (event) {
            var request;
            try { request = JSON.parse(event.data); } catch (e) { return; }
            if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.id !== 'string' || request.id.length > 200 || typeof request.method !== 'string' || !['status', 'ui', 'action', 'key', 'input', 'settings.get', 'settings.set', 'settings.open', 'player', 'logs'].includes(request.method) || !request.params || typeof request.params !== 'object' || Array.isArray(request.params) || !Number.isFinite(request.ttlMs) || request.ttlMs <= 0 || request.ttlMs > 60000) return;
            var receivedAt = performance.now();
            chain = chain.then(async function () {
                var start = performance.now();
                try {
                    if (socket !== connection || connection.readyState !== 1) error('COMMAND_CANCELLED');
                    if (performance.now() - receivedAt >= request.ttlMs) error('COMMAND_EXPIRED');
                    var result = await execute(request.method, request.params || {});
                    send({ id: request.id, result: result, executionMs: Math.round((performance.now() - start) * 10) / 10 });
                } catch (e) { var code = String(e && e.message || '').split(':')[0];
                    send({ id: request.id, error: { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'PLUGIN_ERROR' } }); }
            });
        };
        socket.onclose = function () { clearTimeout(timer); if (socket === connection) socket = null; };
        socket.onerror = function () {};
    }
    function onWake(event) {
        if (event.keyCode !== config.browserWakeCode && event.which !== config.browserWakeCode) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.type === 'keydown' && !event.repeat) connect();
    }
    var original = {}, wrappers = {};
    ['warn', 'error'].forEach(function (level) {
        original[level] = console[level];
        wrappers[level] = function () { original[level].apply(console, arguments); record(level, Array.prototype.map.call(arguments, function (v) { return typeof v === 'string' ? v : v && v.message ? v.message : '[object]'; }).join(' ')); };
        console[level] = wrappers[level];
    });
    function onError(e) { record('error', e.message || 'JavaScript error'); }
    function onRejection(e) { record('rejection', e.reason && e.reason.message || 'Unhandled promise rejection'); }
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    function onSettings(e) { settingsSection = e.name; }
    function ready() {
        Lampa.Listener.remove('app', onApp);
        Lampa.Settings.listener.follow('open', onSettings);
        window.addEventListener('keydown', onWake, true);
        window.addEventListener('keyup', onWake, true);
    }
    function onApp(e) { if (e.type === 'ready') ready(); }
    window.__lampaRemote = { version: config.version, stop: function () {
        stopped = true; clearTimeout(timer); if (socket) socket.close();
        window.removeEventListener('keydown', onWake, true); window.removeEventListener('keyup', onWake, true);
        Lampa.Listener.remove('app', onApp);
        window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection);
        Lampa.Settings.listener.remove('open', onSettings);
        ['warn', 'error'].forEach(function (level) { if (console[level] === wrappers[level]) console[level] = original[level]; });
        delete window.__lampaRemote;
    } };
    if (window.appready) ready();
    else Lampa.Listener.follow('app', onApp);
})(__REMOTE_CONFIG__);
