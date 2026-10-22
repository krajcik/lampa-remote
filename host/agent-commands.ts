import { setTimeout as delay } from 'node:timers/promises';
import { Config } from './state.js';
import { Params, RemoteError, isObject, validateRpc } from './protocol.js';
import { request } from './runtime.js';

export function parseAgent(command: string, args: string[]): Params {
  const usage = () => { throw new RemoteError('INVALID_ARGUMENTS', 'Invalid selector, value or option.', 2, 'Run lampa --help.'); };
  if (command === 'action' && args.length === 1 && !args[0].startsWith('--')) return validateRpc({ method: 'action', params: { id: args[0] } }).params;
  const options: Params = {};
  const allowed = command === 'ui' ? ['text', 'key', 'section', 'full', 'limit'] : command === 'action' ? ['text', 'key', 'section'] : ['screen', 'text', 'key', 'section', 'setting', 'value', 'timeout'];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) usage();
    const name = args[i].slice(2);
    if (!allowed.includes(name) || Object.hasOwn(options, name)) usage();
    if (name === 'full') { options.full = true; continue; }
    const value = args[++i];
    if (value === undefined || value.length === 0 || value.startsWith('--')) usage();
    if (name === 'limit' || name === 'timeout') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > (name === 'limit' ? 150 : 60000)) usage();
      options[name] = Number(value);
    } else if (name === 'value') {
      try { options.value = JSON.parse(value); } catch { usage(); }
      if (options.value !== null && !['boolean', 'number', 'string'].includes(typeof options.value) || typeof options.value === 'number' && !Number.isFinite(options.value)) usage();
    } else { if (value.length > 200) usage(); options[name] = value; }
  }
  if (command !== 'wait') return validateRpc({ method: command, params: options }).params;
  if (['screen', 'text', 'key', 'section', 'setting'].filter(key => Object.hasOwn(options, key)).length !== 1 ||
      Object.hasOwn(options, 'setting') !== Object.hasOwn(options, 'value')) usage();
  return options;
}

export async function waitForState(c: Config, condition: Params): Promise<Params> {
  const started = performance.now();
  const deadline = started + Number(condition.timeout ?? c.rpcTimeoutMs);
  let polls = 0;
  while (true) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new RemoteError('WAIT_TIMEOUT', 'The requested state was not observed before the deadline.', 3, 'Inspect current state and adjust the condition or timeout.');
    const method = condition.screen !== undefined ? 'status' : condition.setting !== undefined ? 'settings.get' : 'ui';
    const params = method === 'status' ? {} : method === 'settings.get' ? { key: condition.setting } : {
      ...Object.fromEntries(['text', 'key', 'section'].filter(key => Object.hasOwn(condition, key)).map(key => [key, condition[key]])), limit: 1,
    };
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    let data: unknown;
    try { data = (await request(c, '/rpc', { method, params }, signal)).data; }
    catch (error) {
      if (signal.aborted) throw new RemoteError('WAIT_READ_TIMEOUT', 'The state read did not complete before the wait deadline.', 4, 'Check plugin responsiveness; no mutation was sent.');
      if (error instanceof RemoteError) throw new RemoteError(error.code, error.message, 4, error.hint);
      throw new RemoteError('WAIT_READ_FAILED', 'Could not read the current state.', 4);
    }
    polls++;
    if (performance.now() > deadline) throw new RemoteError('WAIT_READ_TIMEOUT', 'The state read exceeded the wait deadline.', 4);
    if (!isObject(data) || method === 'status' && typeof data.controller !== 'string' ||
        method === 'settings.get' && (data.key !== condition.setting || !Object.hasOwn(data, 'value') || data.value !== null && !['boolean', 'number', 'string'].includes(typeof data.value)) ||
        method === 'ui' && (!Array.isArray(data.items) || !data.items.every(item => isObject(item) && typeof item.id === 'string' && typeof item.text === 'string'))) {
      throw new RemoteError('INVALID_PLUGIN_RESPONSE', 'The plugin returned an invalid state observation.', 4);
    }
    const matched = method === 'status' ? data.controller === condition.screen : method === 'settings.get' ? data.value === condition.value : (data.items as unknown[]).length > 0;
    if (matched) return { matched: true, polls, elapsedMs: Math.round((performance.now() - started) * 10) / 10 };
    const pause = Math.min(50, deadline - performance.now());
    if (pause > 0) await delay(Math.ceil(pause));
  }
}
