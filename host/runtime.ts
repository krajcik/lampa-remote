import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Adb } from './adb.js';
import { Config, lockFile, releaseLock, stateDir, writePrivateJson } from './state.js';
import { Envelope, Params, RemoteError, isObject, protocolVersion, version } from './protocol.js';

export async function request(c: Config, path: string, body?: unknown, signal?: AbortSignal): Promise<Envelope & { ok: true }> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${c.port}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(c.rpcTimeoutMs + 2000)]) : AbortSignal.timeout(c.rpcTimeoutMs + 2000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const refused = error instanceof Error && isObject(error.cause) && error.cause.code === 'ECONNREFUSED';
    throw new RemoteError(refused ? 'BRIDGE_UNAVAILABLE' : 'BRIDGE_TRANSPORT_ERROR', refused ? 'The bridge is not running.' : 'Could not get a response from the bridge.', 4,
      refused ? 'Run lampa start.' : 'Read current state before retrying a mutation.', body === undefined || refused ? undefined : 'unknown');
  }
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new RemoteError('INVALID_BRIDGE_RESPONSE', 'The bridge returned invalid JSON.', 4, undefined, body === undefined ? undefined : 'unknown'); }
  if (!isObject(data) || typeof data.ok !== 'boolean' || (data.ok && (!response.ok || !Object.hasOwn(data, 'data'))) || (!data.ok && !isObject(data.error))) {
    throw new RemoteError('INVALID_BRIDGE_RESPONSE', 'The bridge returned an unsupported envelope.', 4, undefined, body === undefined ? undefined : 'unknown');
  }
  if (!data.ok) {
    const e = data.error as Params;
    if (typeof e.code !== 'string' || typeof e.message !== 'string') throw new RemoteError('INVALID_BRIDGE_RESPONSE', 'Invalid error envelope from the bridge.', 4);
    const exit = e.code === 'INTERNAL_ERROR' ? 1 : response.status >= 500 || e.outcome === 'unknown' ? 4 : response.status === 400 || response.status === 404 || response.status === 413 || response.status === 415 ? 2 : 3;
    throw new RemoteError(e.code, e.message, exit, typeof e.hint === 'string' ? e.hint : undefined, e.outcome === 'unknown' ? 'unknown' : undefined);
  }
  return data as Envelope & { ok: true };
}

export async function health(c: Config, signal?: AbortSignal): Promise<Params> {
  const data = (await request(c, '/health?passive=1', undefined, signal)).data;
  if (!isObject(data) || data.protocolVersion !== protocolVersion || data.version !== version || !Number.isInteger(data.pid) || Number(data.pid) <= 1) {
    throw new RemoteError('PROTOCOL_MISMATCH', 'The bridge version is incompatible.', 3, 'Stop the old bridge explicitly and start the installed version.');
  }
  return data;
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH'); } };
export async function ensureBridge(c: Config): Promise<Params> {
  const deadline = performance.now() + c.wakeTimeoutMs;
  while (performance.now() < deadline) {
    try { return await health(c); } catch (error) { if (!(error instanceof RemoteError) || error.code !== 'BRIDGE_UNAVAILABLE') throw error; }
    const owner = { pid: process.pid, port: c.port, id: randomUUID() };
    try { writePrivateJson(lockFile, owner, true); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      let raw: string;
      try { raw = readFileSync(lockFile, 'utf8'); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue; throw error; }
      let lock: unknown;
      try { lock = JSON.parse(raw); } catch { throw new RemoteError('BRIDGE_LOCK_INVALID', 'The bridge owner record is invalid.', 3, 'Inspect the private bridge.lock file; no process was killed.'); }
      if (!isObject(lock) || !Number.isInteger(lock.pid) || Number(lock.pid) <= 1) throw new RemoteError('BRIDGE_LOCK_INVALID', 'The bridge owner record is invalid.');
      if (!alive(Number(lock.pid))) {
        try { if (readFileSync(lockFile, 'utf8') === raw) unlinkSync(lockFile); }
        catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
        continue;
      }
      if (lock.port !== c.port) throw new RemoteError('BRIDGE_CONFIG_CHANGED', 'A bridge with another port still owns this state directory.', 3, 'Stop that bridge using its previous configuration before changing port.');
      await delay(25); continue;
    }
    let childPid: number | undefined;
    try {
      const log = openSync(join(stateDir, 'bridge.log'), 'a', 0o600);
      const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'serve'], { detached: true, stdio: ['ignore', log, log], env: process.env });
      let failed = false; child.once('error', () => { failed = true; }); child.unref(); closeSync(log);
      childPid = child.pid;
      if (childPid) writePrivateJson(lockFile, { ...owner, pid: childPid });
      while (!failed && performance.now() < deadline) {
        await delay(25);
        try { return await health(c); } catch (error) { if (!(error instanceof RemoteError) || error.code !== 'BRIDGE_UNAVAILABLE') throw error; }
        if (childPid && !alive(childPid)) break;
      }
    } finally {
      if (!childPid) releaseLock();
      else if (!alive(childPid)) releaseLock(childPid);
    }
    break;
  }
  throw new RemoteError('BRIDGE_START_FAILED', 'The bridge did not become ready within wakeTimeoutMs.', 4, 'Inspect the private bridge.log and bridge.lock files.');
}

export async function lease(c: Config): Promise<() => Promise<void>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.wakeTimeoutMs);
  let response: Response;
  try { response = await fetch(`http://127.0.0.1:${c.port}/lease`, { signal: controller.signal }); }
  catch { throw new RemoteError('BRIDGE_TRANSPORT_ERROR', 'Could not acquire an active CLI lease.', 4); }
  finally { clearTimeout(timer); }
  if (!response.ok) { await response.body?.cancel(); throw new RemoteError('BRIDGE_LEASE_REJECTED', 'The bridge refused an active CLI lease.', 3); }
  return async () => { await response.body?.cancel(); };
}

export async function ensurePeer(c: Config, current: Params): Promise<void> {
  if (current.ready === true && isObject(current.hello)) return;
  const deadline = performance.now() + c.wakeTimeoutMs;
  const adb = new Adb(c, deadline);
  let nextWake = 0;
  try {
    await adb.reverse();
    while (performance.now() < deadline) {
      const next = await health(c, AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))));
      if (next.ready === true && isObject(next.hello)) return;
      if (next.lastPeerError && (!current.lastPeerError || next.peerGeneration !== current.peerGeneration)) throw new RemoteError(String(next.lastPeerError), 'The plugin handshake was rejected.', 3, 'Reload the installed Lampa Remote plugin.');
      if (performance.now() >= nextWake) {
        await adb.wake();
        nextWake = performance.now() + c.wakeRetryIntervalMs;
      }
      await delay(Math.max(1, Math.min(25, deadline - performance.now())));
    }
  } catch (error) { if (performance.now() < deadline) throw error; }
  throw new RemoteError('PLUGIN_WAKE_TIMEOUT', 'No compatible plugin responded within wakeTimeoutMs.', 4, 'Check the installed plugin and calibrate the Android/browser wake codes.');
}

export async function doctor(c: Config): Promise<{ checks: Params; error?: RemoteError }> {
  const checks: Params = {};
  let first: RemoteError | undefined;
  const failed = (error: unknown) => {
    const e = error instanceof RemoteError ? error : new RemoteError('DIAGNOSTIC_FAILED', 'A diagnostic stage failed.');
    e.hint ??= 'Check the TV connection and the installed Lampa Remote plugin.';
    first ??= e; return { ok: false, code: e.code, hint: e.hint };
  };
  const adb = new Adb(c);
  try {
    checks.adb = { ok: true, serial: await adb.serial() };
    try {
      const foreground = await adb.foreground();
      checks.foreground = foreground ? { ok: true } : failed(new RemoteError('APP_NOT_FOREGROUND', 'Lampa is not foreground.', 3, 'Run lampa app start explicitly.'));
    } catch (error) { checks.foreground = failed(error); }
  } catch (error) { checks.adb = failed(error); checks.foreground = { ok: false, code: 'ADB_UNAVAILABLE' }; }
  try {
    const h = await health(c);
    checks.bridge = { ok: true, pid: h.pid, idleTimeoutMs: h.idleTimeoutMs };
    checks.plugin = h.lastPeerError ? failed(new RemoteError(String(h.lastPeerError), 'The plugin handshake was rejected.', 3, 'Reload the installed plugin.')) : h.connected ? { ok: true } : failed(new RemoteError('TV_DISCONNECTED', 'The plugin is disconnected.', 4, 'Run an ordinary command to attempt one foreground-guarded wake.'));
    checks.protocol = h.ready ? { ok: true } : failed(new RemoteError(String(h.lastPeerError || 'HANDSHAKE_MISSING'), 'No compatible plugin handshake.', 3, 'Reload the plugin or check the wake signal.'));
    if (h.ready) {
      try {
        const live = (await request(c, '/rpc', { method: 'status', params: {} })).data;
        if (!isObject(live) || live.protocolVersion !== protocolVersion || live.pluginVersion !== version || live.browserWakeCode !== c.browserWakeCode || live.origin !== c.appOrigin || live.appready !== true) {
          checks.protocol = failed(new RemoteError('PROTOCOL_MISMATCH', 'The live plugin status did not match its handshake.', 3, 'Reload the installed plugin.'));
        } else {
          checks.plugin = { ok: true, screensaverActive: typeof live.screensaverActive === 'boolean' ? live.screensaverActive : null,
            ...(live.screensaverActive === true ? { hint: 'Send an explicit key to dismiss the Lampa screensaver before another mutation.' } : {}) };
          if (live.visibility === 'hidden') checks.foreground = failed(new RemoteError('APP_HIDDEN', 'The plugin reports that Lampa is hidden.', 3, 'Return to Lampa explicitly.'));
        }
      } catch (error) { checks.plugin = failed(error); }
    }
  } catch (error) { checks.bridge = failed(error); checks.plugin = { ok: false, code: 'BRIDGE_UNAVAILABLE' }; checks.protocol = { ok: false, code: 'BRIDGE_UNAVAILABLE' }; }
  return { checks, error: first };
}
