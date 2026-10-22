#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge } from './bridge.js';
import { Envelope, Params, RemoteError, exitFor, failure, isObject, protocolVersion, success, validateRpc, version } from './protocol.js';

export const stateDir = resolve(process.env.LAMPA_REMOTE_STATE || fileURLToPath(new URL('../.local/', import.meta.url)));
export interface Config { token: string; port: number }
export function config(): Config {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, 'config.json');
  const read = (): Config => {
    let value: unknown;
    try { value = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new RemoteError('CONFIG_INVALID', 'Could not read the bridge configuration.', 3, 'Check the state directory permissions and config.json.'); }
    if (!isObject(value) || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/i.test(value.token) || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) {
      throw new RemoteError('CONFIG_INVALID', 'Bridge configuration must contain a token and a valid port.');
    }
    chmodSync(file, 0o600);
    return { token: value.token, port: Number(value.port) };
  };
  try { readFileSync(file); return read(); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  const value = { token: randomBytes(32).toString('hex'), port: 18657 };
  try { writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); return value; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return read(); throw error; }
}

export async function request(c: Config, path: string, body?: unknown, signal?: AbortSignal): Promise<Envelope & { ok: true }> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${c.port}${path}`, {
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(7000)]) : AbortSignal.timeout(7000),
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
    const exit = e.code === 'INTERNAL_ERROR' ? 1 : response.status >= 500 || e.outcome === 'unknown' ? 4 : response.status === 400 || response.status === 404 || response.status === 413 ? 2 : 3;
    throw new RemoteError(e.code, e.message, exit, typeof e.hint === 'string' ? e.hint : undefined, e.outcome === 'unknown' ? 'unknown' : undefined);
  }
  return data as Envelope & { ok: true };
}

const help = `Usage: lampa <command> [arguments]

Bridge:
  start [ADB_SERIAL]              Start bridge; optionally establish adb reverse
  stop                           Stop bridge (does not stop Lampa)
  bridge                         Read bridge health
  install-url                    Write installation URL to private state file

Lampa (must already be running):
  status | ui | player            Read plugin state, visible UI, or video state
  action ID                      Activate a target from the latest UI snapshot
  key up|down|left|right|enter|back|long
  input [TEXT]                   Read/write one editable non-sensitive field
  settings open [SECTION]        Open settings or one section
  settings get [KEY]             Read supported non-sensitive settings
  settings set KEY true|false    Change a visible boolean setting
  logs [--follow]                Read diagnostics, optionally keep following

  --help | help                  Show help without contacting TV
  --version                      Show version without contacting TV

Ordinary results are JSON stdout; errors are JSON stderr.
Exit codes: 0 success, 1 unexpected, 2 usage, 3 precondition, 4 transport/unknown.
LAMPA_REMOTE_STATE overrides the private .local/ state directory.
`;
export function parse(argv: string[]): { command: string; args: string[]; rpc?: ReturnType<typeof validateRpc> } {
  if (argv.includes('--help') || argv[0] === 'help' || argv.length === 0) return { command: 'help', args: [] };
  if (argv.length === 1 && argv[0] === '--version') return { command: 'version', args: [] };
  const [command, ...args] = argv;
  const usage = () => { throw new RemoteError('INVALID_ARGUMENTS', 'Invalid command or arguments.', 2, 'Run lampa --help.'); };
  if (['start', 'stop', 'bridge', 'install-url', 'serve'].includes(command)) {
    if (args.length > (command === 'start' ? 1 : 0) || args.some(a => a.startsWith('-'))) usage();
    return { command, args };
  }
  let method = command;
  const params: Params = {};
  if (['status', 'ui', 'player'].includes(command)) { if (args.length) usage(); }
  else if (command === 'logs') { if (args.length > 1 || (args.length === 1 && args[0] !== '--follow')) usage(); }
  else if (command === 'action' || command === 'key') { if (args.length !== 1) usage(); params[command === 'action' ? 'id' : 'key'] = args[0]; }
  else if (command === 'input') { if (args.length > 1) usage(); if (args.length) params.text = args[0]; }
  else if (command === 'settings') {
    method = `settings.${args[0]}`;
    if (args[0] === 'get' || args[0] === 'open') { if (args.length > 2) usage(); if (args[1] !== undefined) params[args[0] === 'get' ? 'key' : 'section'] = args[1]; }
    else if (args[0] === 'set') { if (args.length !== 3 || !['true', 'false'].includes(args[2])) usage(); params.key = args[1]; params.value = args[2] === 'true'; }
    else usage();
  } else usage();
  return { command, args, rpc: validateRpc({ method, params }) };
}
const output = (value: Envelope) => process.stdout.write(JSON.stringify(value) + '\n');
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, args, rpc } = parse(argv);
  if (command === 'help') { process.stdout.write(help); return; }
  if (command === 'version') { process.stdout.write(version + '\n'); return; }
  const c = config();
  if (command === 'serve') {
    const bridge = createBridge(c);
    await bridge.listen();
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void bridge.close().then(() => { process.exitCode = 0; }); });
    return;
  }
  if (command === 'start') {
    if (args[0]) {
      let existing: string;
      try { existing = (await promisify(execFile)('adb', ['-s', args[0], 'reverse', '--list'])).stdout; }
      catch { throw new RemoteError('ADB_UNAVAILABLE', 'Could not read ADB reverse mappings.'); }
      const match = existing.split('\n').find(line => line.split(/\s+/)[1] === `tcp:${c.port}`);
      if (match && match.trim().split(/\s+/)[2] !== `tcp:${c.port}`) throw new RemoteError('ADB_PORT_ALREADY_OWNED', 'The ADB reverse port belongs to another mapping.');
      try { await promisify(execFile)('adb', ['-s', args[0], 'reverse', `tcp:${c.port}`, `tcp:${c.port}`]); }
      catch { throw new RemoteError('ADB_REVERSE_FAILED', 'Could not establish the ADB reverse mapping.'); }
    }
    try { output(await request(c, '/health')); return; } catch (error) { if (!(error instanceof RemoteError) || error.code !== 'BRIDGE_UNAVAILABLE') throw error; }
    const logFile = join(stateDir, 'bridge.log');
    const log = openSync(logFile, 'a', 0o600); chmodSync(logFile, 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: ['ignore', log, log], env: process.env });
    let spawnFailed = false; child.once('error', () => { spawnFailed = true; }); child.unref(); closeSync(log);
    for (let i = 0; i < 30 && !spawnFailed; i++) {
      await delay(100);
      try { output(await request(c, '/health')); return; } catch (error) { if (!(error instanceof RemoteError) || error.code !== 'BRIDGE_UNAVAILABLE') throw error; }
    }
    throw new RemoteError('BRIDGE_START_FAILED', 'Could not start the bridge.', 4, 'Inspect the private bridge.log file.');
  }
  if (command === 'stop') {
    const health = await request(c, '/health');
    if (!isObject(health.data) || !Number.isInteger(health.data.pid) || Number(health.data.pid) <= 1 || health.data.protocolVersion !== protocolVersion) throw new RemoteError('INVALID_BRIDGE_RESPONSE', 'Bridge identity was not confirmed.', 4);
    process.kill(Number(health.data.pid), 'SIGTERM');
    for (let i = 0; i < 30; i++) {
      await delay(100);
      try { await request(c, '/health'); } catch (error) { if (error instanceof RemoteError && error.code === 'BRIDGE_UNAVAILABLE') { output(success({ stopped: true })); return; } throw error; }
    }
    throw new RemoteError('BRIDGE_STOP_NOT_CONFIRMED', 'Bridge shutdown was not confirmed.', 4);
  }
  if (command === 'bridge') { output(await request(c, '/health')); return; }
  if (command === 'install-url') {
    const file = join(stateDir, 'install-url.txt');
    writeFileSync(file, `http://127.0.0.1:${c.port}/plugin.js?token=${c.token}\n`, { mode: 0o600 }); chmodSync(file, 0o600);
    output(success({ file })); return;
  }
  if (command === 'logs' && args[0] === '--follow') {
    let since = 0;
    const abort = new AbortController();
    const stop = () => { process.exitCode = 130; abort.abort(); };
    process.once('SIGINT', stop);
    try {
      while (!abort.signal.aborted) {
        const data = (await request(c, `/events?since=${since}`, undefined, abort.signal)).data;
        if (!isObject(data) || !Array.isArray(data.events)) throw new RemoteError('INVALID_BRIDGE_RESPONSE', 'Invalid diagnostics stream.', 4);
        for (const event of data.events) { if (!isObject(event) || !Number.isSafeInteger(event.sequence)) throw new RemoteError('INVALID_BRIDGE_RESPONSE', 'Invalid event cursor.', 4); output(success(event)); since = Number(event.sequence); }
        await delay(250, undefined, { signal: abort.signal });
      }
    } catch (error) { if (!abort.signal.aborted) throw error; }
    finally { process.removeListener('SIGINT', stop); }
    return;
  }
  output(await request(c, '/rpc', rpc));
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(JSON.stringify(failure(error)) + '\n'); process.exitCode = exitFor(error); });
}
