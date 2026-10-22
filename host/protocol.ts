import { readFileSync } from 'node:fs';

export const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const protocolVersion = 1;
export const methods = ['status', 'ui', 'action', 'key', 'input', 'settings.get', 'settings.set', 'settings.open', 'player', 'logs'] as const;
export type Method = typeof methods[number];
export type Params = Record<string, unknown>;
export type Outcome = 'unknown';
export type Envelope = { ok: true; data: unknown; meta?: Record<string, unknown> } | {
  ok: false; error: { code: string; message: string; hint?: string; outcome?: Outcome }; meta?: Record<string, unknown>;
};
export class RemoteError extends Error {
  constructor(public code: string, message: string, public exitCode = 3, public hint?: string, public outcome?: Outcome) {
    super(message);
  }
}
export const isObject = (value: unknown): value is Params => value !== null && typeof value === 'object' && !Array.isArray(value);
export const sensitiveField = (key: string): boolean => /token|password|passwd|secret|cookie|email|login|authorization|account|credential|api.?key|key$|парол|токен|почт|логин|ключ|(^|[^a-z0-9])(key|auth|session|pass)(?=$|[^a-z0-9])/i.test(key);

export function boundedShape(value: unknown): boolean {
  const work: [unknown, number][] = [[value, 0]];
  let count = 0;
  while (work.length) {
    const [item, depth] = work.pop()!;
    if (++count > 20000 || depth > 32) return false;
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) work.push([child, depth + 1]);
    }
  }
  return true;
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isObject(value)) return value;
  const sensitive = typeof value.key === 'string' && sensitiveField(value.key);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    (key !== 'key' && sensitiveField(key)) || (sensitive && key !== 'key') ? '[redacted]' : redact(item),
  ]));
}
export function success(data: unknown, meta?: Record<string, unknown>): Envelope {
  return { ok: true, data: redact(data), ...(meta ? { meta } : {}) };
}
export function failure(error: unknown): Envelope & { ok: false } {
  const e = error instanceof RemoteError ? error : new RemoteError('INTERNAL_ERROR', 'Unexpected internal error.', 1);
  return { ok: false, error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}), ...(e.outcome ? { outcome: e.outcome } : {}) } };
}
export function exitFor(error: unknown): number { return error instanceof RemoteError ? error.exitCode : 1; }
export function validateRpc(value: unknown): { method: Method; params: Params } {
  if (!boundedShape(value) || !isObject(value) || typeof value.method !== 'string' || !(methods as readonly string[]).includes(value.method) ||
      (value.params !== undefined && !isObject(value.params))) {
    throw new RemoteError('INVALID_COMMAND', 'Expected a supported method and an object of parameters.', 2);
  }
  const method = value.method as Method;
  const params = value.params as Params | undefined ?? {};
  const text = (key: string, required = true, max = 200): boolean =>
    (!required && params[key] === undefined) || (typeof params[key] === 'string' && (params[key] as string).length > 0 && (params[key] as string).length <= max);
  const valid = method === 'action' ? text('id') : method === 'key' ? typeof params.key === 'string' && ['up', 'down', 'left', 'right', 'enter', 'back', 'long'].includes(params.key) :
    method === 'input' ? params.text === undefined || (typeof params.text === 'string' && params.text.length <= 4096) :
    method === 'settings.get' ? text('key', false) : method === 'settings.set' ? text('key') && typeof params.value === 'boolean' :
    method === 'settings.open' ? text('section', false) && (params.section === undefined || /^[a-z0-9_-]+$/i.test(String(params.section))) : true;
  if (!valid) throw new RemoteError('INVALID_PARAMS', 'Invalid parameters for this command.', 2);
  return { method, params };
}
