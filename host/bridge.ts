import http from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { defaults } from './state.js';
import { Envelope, Params, RemoteError, boundedShape, failure, isObject, protocolVersion, success, validateRpc, version } from './protocol.js';

export const pluginFile = new URL('../plugin/remote.js', import.meta.url);
export interface BridgeOptions { token: string; port?: number; timeout?: number; idleTimeoutMs?: number; wakeTimeoutMs?: number; browserWakeCode?: number }
export function createBridge({ token, port = defaults.port, timeout = defaults.rpcTimeoutMs, idleTimeoutMs = defaults.idleTimeoutMs, wakeTimeoutMs = defaults.wakeTimeoutMs, browserWakeCode = defaults.browserWakeCode }: BridgeOptions) {
  let peer: WebSocket | null = null;
  let hello: unknown = null;
  let sequence = 0;
  let active = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let stopping = false;
  let closing: Promise<void> | undefined;
  let lastPeerError: string | null = null;
  let peerGeneration = 0;
  const leases = new Set<http.ServerResponse>();
  const pending = new Map<string, { res: http.ServerResponse; timer: NodeJS.Timeout; started: number }>();
  const events: Params[] = [];
  const source = readFileSync(pluginFile, 'utf8');
  const sourceHash = () => createHash('sha256').update(source).digest('hex');
  const armIdle = () => { clearTimeout(idleTimer); if (!stopping && active === 0) idleTimer = setTimeout(() => { void close(); }, idleTimeoutMs); };
  const hold = (res: http.ServerResponse) => {
    clearTimeout(idleTimer); active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; leases.delete(res); armIdle(); } };
    res.once('finish', release); res.once('close', release);
  };
  const authorized = (value: unknown) => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  const record = (event: Params) => { events.push({ ...event, sequence: ++sequence }); if (events.length > 200) events.shift(); };
  const reply = (res: http.ServerResponse, code: number, body: Envelope) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body));
  };
  const reject = (res: http.ServerResponse, status: number, code: string, message: string, exit = 3, outcome?: 'unknown') =>
    reply(res, status, failure(new RemoteError(code, message, exit, undefined, outcome)));
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if ((req.headers.origin && url.pathname !== '/plugin.js') || !['127.0.0.1', 'localhost'].includes((req.headers.host || '').split(':')[0])) {
        return reject(res, 403, 'ORIGIN_OR_HOST_REJECTED', 'Only local non-browser API requests are accepted.');
      }
      const credential = url.pathname === '/plugin.js' ? url.searchParams.get('token') : req.headers.authorization?.replace(/^Bearer /, '');
      if (!authorized(credential)) return reject(res, 401, 'UNAUTHORIZED', 'Bridge authentication failed.');
      if (url.pathname !== '/plugin.js' && !(url.pathname === '/health' && url.searchParams.get('passive') === '1')) hold(res);
      if (req.method === 'GET' && url.pathname === '/lease') {
        leases.add(res); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }); res.flushHeaders(); return;
      }
      if (req.method === 'GET' && url.pathname === '/plugin.js') {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Bridge has no port');
        const config = { token, socket: `ws://127.0.0.1:${address.port}/tv`, version, protocolVersion, sourceHash: sourceHash(), browserWakeCode, wakeTimeoutMs };
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        return res.end(source.replace('__REMOTE_CONFIG__', JSON.stringify(config)));
      }
      if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, success({ version, protocolVersion, pid: process.pid, connected: !!peer, ready: !!hello, lastPeerError, peerGeneration, idleTimeoutMs, active, sourceHash: sourceHash(), hello }));
      if (req.method === 'GET' && url.pathname === '/events') {
        const since = Number(url.searchParams.get('since') || 0);
        if (!Number.isSafeInteger(since) || since < 0) return reject(res, 400, 'INVALID_PARAMS', 'Event cursor must be a non-negative integer.', 2);
        return reply(res, 200, success({ events: events.filter(e => Number(e.sequence) > since), connected: !!hello }));
      }
      if (req.method !== 'POST' || url.pathname !== '/rpc') return reject(res, 404, 'NOT_FOUND', 'Unknown bridge endpoint.', 2);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 16384) return reject(res, 413, 'REQUEST_TOO_LARGE', 'Request exceeds the size limit.', 2);
        chunks.push(Buffer.from(chunk));
      }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { return reject(res, 400, 'INVALID_REQUEST', 'Request must contain valid JSON.', 2); }
      const input = validateRpc(value);
      if (lastPeerError) return reject(res, 409, lastPeerError, 'Reload the Lampa Remote plugin to match this bridge.', 3);
      if (!peer || peer.readyState !== WebSocket.OPEN || !hello) return reject(res, 503, 'TV_DISCONNECTED', 'The Lampa plugin is not connected.', 4);
      const id = randomUUID();
      const started = performance.now();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(res, 504, 'TV_TIMEOUT', 'Timed out waiting for Lampa. Read state before retrying a mutation.', 4, 'unknown');
      }, timeout);
      pending.set(id, { res, timer, started });
      res.once('close', () => { const request = pending.get(id); if (request) clearTimeout(request.timer); pending.delete(id); });
      peer.send(JSON.stringify({ id, method: input.method, params: input.params, ttlMs: timeout }));
    } catch (error) {
      reply(res, error instanceof RemoteError ? 400 : 500, failure(error));
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try { url = new URL(req.url || '/', 'http://127.0.0.1'); }
    catch { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    if (url.pathname !== '/tv' || !authorized(url.searchParams.get('token')) || peer) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    peer = ws; hello = null; lastPeerError = null; peerGeneration++;
    const handshake = setTimeout(() => { lastPeerError = 'HANDSHAKE_TIMEOUT'; ws.close(1008, lastPeerError); }, wakeTimeoutMs);
    ws.on('error', () => {});
    ws.on('message', data => {
      let message: unknown;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (!isObject(message)) return;
      if (!boundedShape(message)) {
        if (typeof message.id === 'string') {
          const request = pending.get(message.id);
          if (request) {
            pending.delete(message.id); clearTimeout(request.timer);
            reject(request.res, 502, 'INVALID_PEER_MESSAGE', 'The peer returned an unsafe message shape.', 4, 'unknown');
          }
        }
        ws.terminate(); return;
      }
      if (message.type === 'hello') {
        if (!isObject(message.data) || message.data.protocolVersion !== protocolVersion || message.data.pluginVersion !== version || message.data.sourceHash !== sourceHash() || message.data.appready !== true || message.data.browserWakeCode !== browserWakeCode) {
          lastPeerError = 'PROTOCOL_MISMATCH'; clearTimeout(handshake); ws.close(1008, lastPeerError); return;
        }
        clearTimeout(handshake); lastPeerError = null; hello = message.data; record({ type: 'connected', at: Date.now(), data: hello });
      } else if (message.type === 'event') {
        if (isObject(message.data)) record({ type: 'tv', at: Date.now(), data: message.data });
      } else if (typeof message.id === 'string' && pending.has(message.id)) {
        if ((!Object.hasOwn(message, 'result') && !isObject(message.error)) ||
            (message.error !== undefined && (!isObject(message.error) || typeof message.error.code !== 'string'))) return;
        const request = pending.get(message.id)!;
        pending.delete(message.id); clearTimeout(request.timer);
        const meta = { roundTripMs: Math.round((performance.now() - request.started) * 10) / 10, ...(typeof message.executionMs === 'number' && Number.isFinite(message.executionMs) ? { executionMs: message.executionMs } : {}) };
        if (isObject(message.error)) {
          const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(String(message.error.code)) ? String(message.error.code) : 'PLUGIN_ERROR';
          reply(request.res, 422, { ...failure(new RemoteError(code, 'Lampa could not complete the command.', 3,
            code === 'SCREENSAVER_ACTIVE' ? 'Send an explicit key to dismiss the Lampa screensaver, then inspect current state.' : undefined)), meta });
        } else reply(request.res, 200, success(message.result, meta));
      }
    });
    ws.on('close', () => {
      clearTimeout(handshake);
      if (peer !== ws) return;
      peer = null; hello = null;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        reject(request.res, 503, 'TV_DISCONNECTED', 'Lampa disconnected. Read state before retrying a mutation.', 4, 'unknown');
      }
      pending.clear(); record({ type: 'disconnected', at: Date.now() });
    });
  });
  const heartbeat = setInterval(() => { if (peer?.readyState === WebSocket.OPEN) peer.ping(); }, 20000);
  heartbeat.unref();
  function close(): Promise<void> {
    if (!closing) {
      stopping = true;
      clearTimeout(idleTimer); clearInterval(heartbeat);
      closing = (async () => {
        for (const lease of leases) lease.end();
        if (peer) peer.terminate();
        await new Promise<void>(resolve => wss.close(() => resolve()));
        await new Promise<void>(resolve => server.close(() => resolve()));
      })();
    }
    return closing;
  }
  return {
    server,
    listen: () => new Promise<number>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { const address = server.address(); if (address && typeof address !== 'string') { armIdle(); resolve(address.port); } }); }),
    close,
  };
}
