(function () {
    'use strict';
    if (window.__lampaRemoteLoader) return;
    var marker = '#lampa-remote=', config, loading, timer;
    function read(url) {
        if (typeof url !== 'string' || url.indexOf(marker) < 0) return null;
        try {
            var value = JSON.parse(decodeURIComponent(url.split(marker)[1].split(/[?&]/)[0]));
            var match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/plugin\.js\?token=[a-f0-9]{64}$/i.exec(value.url);
            if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535 ||
                !Number.isInteger(value.browserWakeCode) || value.browserWakeCode < 1 || value.browserWakeCode > 65535 ||
                !Number.isInteger(value.wakeTimeoutMs) || value.wakeTimeoutMs < 1 || value.wakeTimeoutMs > 60000) return null;
            return value;
        } catch (_) { return null; }
    }
    config = read(document.currentScript && document.currentScript.src);
    if (!config) {
        // Cached Lampa plugins execute inline; their original URLs remain in Storage.
        var stored = Lampa.Storage.get('plugins', []);
        var matches = Array.isArray(stored) ? stored.filter(function (item) { return typeof item === 'string' || item && item.status === 1; }).map(function (item) {
            return read(typeof item === 'string' ? item : item.url);
        }).filter(Boolean) : [];
        if (matches.length === 1) config = matches[0];
    }
    if (!config) { console.warn('Lampa Remote: installation configuration is missing or invalid.'); return; }
    Lampa.Manifest.plugins = { type: 'other', version: '0.2.0', name: 'Lampa Remote', description: 'Terminal control; connects only when requested by CLI', component: 'lampa_remote' };
    function clear() {
        clearTimeout(timer);
        if (loading) {
            loading.onload = loading.onerror = null;
            if (loading.parentNode) loading.parentNode.removeChild(loading);
            loading = null;
        }
    }
    function wake(e) {
        if ((e.keyCode || e.which) !== config.browserWakeCode || window.__lampaRemote) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.type !== 'keydown' || loading) return;
        loading = document.createElement('script');
        loading.onload = loading.onerror = clear;
        loading.src = config.url;
        timer = setTimeout(clear, config.wakeTimeoutMs);
        document.head.appendChild(loading);
    }
    window.addEventListener('keydown', wake, true);
    window.addEventListener('keyup', wake, true);
    window.__lampaRemoteLoader = { stop: function () {
        clear();
        window.removeEventListener('keydown', wake, true);
        window.removeEventListener('keyup', wake, true);
        delete window.__lampaRemoteLoader;
    } };
})();
