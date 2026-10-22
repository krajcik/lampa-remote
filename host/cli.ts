#!/usr/bin/env node
import { chmodSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge } from './bridge.js';
import { Adb } from './adb.js';
import { config, releaseLock, stateDir } from './state.js';
import { doctor, ensureBridge, ensurePeer, health, lease, request } from './runtime.js';
import { parseAgent, waitForState } from './agent-commands.js';
import { Envelope, Params, RemoteError, exitFor, failure, isObject, success, validateRpc, version } from './protocol.js';
export { config, stateDir } from './state.js';
export { request } from './runtime.js';

const help = `Usage: lampa <command> [arguments]

Bridge:
  start [ADB_SERIAL]              Start bridge; optionally establish adb reverse
  stop                           Stop bridge (does not stop Lampa)
  bridge                         Start/read bridge health
  doctor                         Diagnose without starting bridge or waking TV
  app start|stop|restart         Explicit Android application lifecycle
  install-url                    Write installation URL to private state file

Lampa (must already be running):
  status | player                Read plugin or video state
  ui [--full] [--limit 1..150] [--text TEXT | --key KEY | --section SECTION]
                                 Compact UI (default limit50); text substring filter
  action ID | --text TEXT | --key KEY | --section SECTION
                                 Activate one exact unique visible target
  wait --screen CONTROLLER | --text TEXT | --key KEY | --section SECTION
  wait --setting KEY --value JSON [--timeout MS]
                                 Bounded read-only wait; text substring, timeout1..60000
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
Edit config.json there (0600); restart bridge to apply changed runtime values.
Fields: port, serial, idleTimeoutMs (3600000), rpcTimeoutMs (5000),
adbTimeoutMs (10000), wakeTimeoutMs (20000), wakeRetryIntervalMs (1000), appPackage, appActivity,
androidWakeCode (KEYCODE_F8), browserWakeCode (119).
Reload the plugin after changing the browser wake code.
`;
export function parse(argv: string[]): { command: string; args: string[]; rpc?: ReturnType<typeof validateRpc>; condition?: Params } {
  if (argv[0] === '--help' || argv[0] === 'help' || argv.length === 0 || argv.length === 2 && argv[1] === '--help') return { command: 'help', args: [] };
  if (argv.length === 1 && argv[0] === '--version') return { command: 'version', args: [] };
  const [command, ...args] = argv;
  const usage = () => { throw new RemoteError('INVALID_ARGUMENTS', 'Invalid command or arguments.', 2, 'Run lampa --help.'); };
  if (command === 'app') { if (args.length !== 1 || !['start', 'stop', 'restart'].includes(args[0])) usage(); return { command, args }; }
  if (['start', 'stop', 'bridge', 'install-url', 'serve', 'doctor'].includes(command)) {
    if (args.length > (command === 'start' ? 1 : 0) || args.some(a => a.startsWith('-'))) usage();
    return { command, args };
  }
  if (['ui', 'action', 'wait'].includes(command)) {
    const params = parseAgent(command, args);
    return command === 'wait' ? { command, args, condition: params } : { command, args, rpc: validateRpc({ method: command, params }) };
  }
  let method = command;
  const params: Params = {};
  if (['status', 'player'].includes(command)) { if (args.length) usage(); }
  else if (command === 'logs') { if (args.length > 1 || (args.length === 1 && args[0] !== '--follow')) usage(); }
  else if (command === 'key') { if (args.length !== 1) usage(); params.key = args[0]; }
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
  const { command, args, rpc, condition } = parse(argv);
  if (command === 'help') { process.stdout.write(help); return; }
  if (command === 'version') { process.stdout.write(version + '\n'); return; }
  const c = config(command !== 'doctor');
  if (command === 'doctor') {
    const report = await doctor(c);
    if (report.error) {
      process.stderr.write(JSON.stringify({ ...failure(report.error), meta: { checks: report.checks } }) + '\n');
      process.exitCode = report.error.exitCode;
    } else output(success({ ready: true, checks: report.checks }));
    return;
  }
  if (command === 'app') { output(success(await new Adb(c).app(args[0]))); return; }
  if (command === 'serve') {
    const bridge = createBridge({ ...c, timeout: c.rpcTimeoutMs });
    bridge.server.once('close', () => releaseLock());
    await bridge.listen();
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void bridge.close().then(() => { process.exitCode = 0; }); });
    return;
  }
  if (command === 'stop') {
    const h = await health(c);
    process.kill(Number(h.pid), 'SIGTERM');
    const deadline = performance.now() + c.wakeTimeoutMs;
    while (performance.now() < deadline) {
      await delay(25);
      try { await health(c); } catch (error) { if (error instanceof RemoteError && error.code === 'BRIDGE_UNAVAILABLE') { output(success({ stopped: true })); return; } throw error; }
    }
    throw new RemoteError('BRIDGE_STOP_NOT_CONFIRMED', 'Bridge shutdown was not confirmed.', 4);
  }
  if (command === 'install-url') {
    const file = join(stateDir, 'install-url.txt');
    writeFileSync(file, `http://127.0.0.1:${c.port}/plugin.js?token=${c.token}\n`, { mode: 0o600 }); chmodSync(file, 0o600);
    output(success({ file })); return;
  }
  const current = await ensureBridge(c);
  const release = await lease(c);
  try {
    if (command === 'start' && args[0]) await new Adb({ ...c, serial: args[0] }).reverse();
    if (command === 'start' || command === 'bridge') { output(success(await health(c))); return; }
    await ensurePeer(c, current);
    if (command === 'wait') { output(success(await waitForState(c, condition!))); return; }
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
          if (data.connected === false) throw new RemoteError('TV_DISCONNECTED', 'Lampa disconnected while following logs.', 4);
          await delay(250, undefined, { signal: abort.signal });
        }
      } catch (error) { if (!abort.signal.aborted) throw error; }
      finally { process.removeListener('SIGINT', stop); }
      return;
    }
    output(await request(c, '/rpc', rpc));
  } finally { await release(); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(JSON.stringify(failure(error)) + '\n'); process.exitCode = exitFor(error); });
}
