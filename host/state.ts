import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { isObject, RemoteError } from './protocol.js';

export const stateDir = resolve(process.env.LAMPA_REMOTE_STATE || fileURLToPath(new URL('../.local/', import.meta.url)));
export const defaults = {
  port: 18657, idleTimeoutMs: 3600000, rpcTimeoutMs: 5000, adbTimeoutMs: 10000, wakeTimeoutMs: 5000,
  serial: null as string | null, appPackage: 'ru.twicker.lampa', appActivity: '.ui.MainActivity',
  androidWakeCode: 'KEYCODE_F8', browserWakeCode: 119,
};
export type Config = typeof defaults & { token: string };

export function writePrivateJson(file: string, data: unknown, exclusive = false): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); }
  finally { closeSync(fd); }
  try { if (exclusive) linkSync(temporary, file); else renameSync(temporary, file); }
  finally { try { unlinkSync(temporary); } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; } }
}

export function config(create = true): Config {
  const file = join(stateDir, 'config.json');
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw new RemoteError('CONFIG_UNREADABLE', 'Could not read the private configuration.', 3, 'Check state directory permissions.');
    if (!create) throw new RemoteError('CONFIG_MISSING', 'No private configuration exists.', 3, 'Run lampa start to initialize it.');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    try { writePrivateJson(file, { token: randomBytes(32).toString('hex'), ...defaults }, true); }
    catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error; }
    return config(false);
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new RemoteError('CONFIG_INVALID', 'Configuration is not valid JSON.', 3, 'Finish the edit before running a command; use an atomic file replacement.'); }
  if (!isObject(value) || Object.keys(value).some(key => key !== 'token' && !Object.hasOwn(defaults, key))) throw new RemoteError('CONFIG_INVALID', 'Unknown configuration field or invalid object.');
  const c = { ...defaults, ...value } as Config;
  const integer = (v: unknown, min: number, max: number) => Number.isInteger(v) && Number(v) >= min && Number(v) <= max;
  if (typeof c.token !== 'string' || !/^[a-f0-9]{64}$/i.test(c.token) || !integer(c.port, 1, 65535) ||
      !integer(c.idleTimeoutMs, 1, 604800000) || !integer(c.rpcTimeoutMs, 1, 60000) || !integer(c.adbTimeoutMs, 1, 60000) || !integer(c.wakeTimeoutMs, 1, 60000) ||
      (c.serial !== null && (typeof c.serial !== 'string' || !/^[\w.:[\]-]{1,200}$/.test(c.serial))) ||
      typeof c.appPackage !== 'string' || !/^[a-zA-Z]\w*(?:\.\w+)+$/.test(c.appPackage) ||
      typeof c.appActivity !== 'string' || !/^\.?[a-zA-Z_]\w*(?:\.\w+)*$/.test(c.appActivity) ||
      typeof c.androidWakeCode !== 'string' || !/^KEYCODE_[A-Z0-9_]{1,50}$/.test(c.androidWakeCode) || !integer(c.browserWakeCode, 1, 65535)) {
    throw new RemoteError('CONFIG_INVALID', 'Invalid runtime configuration type or range.', 3, 'Check the fields listed by lampa --help; time values are milliseconds.');
  }
  if ((statSync(file).mode & 0o077) !== 0) throw new RemoteError('CONFIG_PERMISSIONS', 'Configuration must be private.', 3, 'Set config.json permissions to 0600.');
  if (readFileSync(file, 'utf8') !== raw) throw new RemoteError('CONFIG_CHANGED', 'Configuration changed while being read.', 3, 'Finish editing and run the command again.');
  return c;
}

export const lockFile = join(stateDir, 'bridge.lock');
export function releaseLock(pid = process.pid): void {
  try { const raw = readFileSync(lockFile, 'utf8'); if (JSON.parse(raw).pid === pid && readFileSync(lockFile, 'utf8') === raw) unlinkSync(lockFile); }
  catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
}
