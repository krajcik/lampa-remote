import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Config } from './state.js';
import { RemoteError } from './protocol.js';

export class Adb {
  private selected?: string;
  constructor(private c: Config, private deadline = Infinity) {}
  async run(args: string[], mutation = false): Promise<string> {
    const remaining = this.deadline - performance.now();
    if (remaining <= 0) throw new RemoteError('PLUGIN_WAKE_TIMEOUT', 'The wake budget expired before an ADB command.', 4);
    try { return (await promisify(execFile)('adb', args, { timeout: Math.max(1, Math.ceil(Math.min(this.c.adbTimeoutMs, remaining))), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true })).stdout; }
    catch (error) {
      const e = error as NodeJS.ErrnoException & { killed?: boolean };
      const code = e.code === 'ENOENT' ? 'ADB_NOT_FOUND' : e.killed || e.code === 'ETIMEDOUT' ? 'ADB_TIMEOUT' : 'ADB_COMMAND_FAILED';
      throw new RemoteError(code, code === 'ADB_TIMEOUT' ? 'ADB command exceeded adbTimeoutMs.' : 'ADB command could not complete.', code === 'ADB_NOT_FOUND' ? 3 : 4,
        code === 'ADB_NOT_FOUND' ? 'Install Android platform-tools or fix PATH.' : 'Check the TV connection; adjust adbTimeoutMs if needed.', mutation && code !== 'ADB_NOT_FOUND' ? 'unknown' : undefined);
    }
  }
  async serial(): Promise<string> {
    if (this.selected) return this.selected;
    const list = (await this.run(['devices', '-l'])).split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length >= 2 && !parts[0].startsWith('*') && parts[0] !== 'List');
    const devices = this.c.serial ? list.filter(parts => parts[0] === this.c.serial) : list;
    if (devices.length !== 1) throw new RemoteError(devices.length ? 'ADB_AMBIGUOUS' : 'ADB_NO_DEVICE', devices.length ? 'More than one ADB device matches.' : 'No ADB device matches.', 3, 'Set serial in config.json and check adb devices.');
    if (devices[0][1] !== 'device') throw new RemoteError('ADB_NOT_READY', 'The selected ADB device is not authorized and online.', 3, 'Authorize the selected device and check its connection.');
    this.selected = devices[0][0];
    return this.selected;
  }
  async command(args: string[], mutation = false): Promise<string> { return this.run(['-s', await this.serial(), ...args], mutation); }
  async foreground(): Promise<boolean> {
    const text = await this.command(['shell', 'dumpsys', 'activity', 'activities']);
    const top = text.split('\n').filter(line => /topResumedActivity/.test(line));
    const lines = top.length ? top : text.split('\n').filter(line => /mResumedActivity|ResumedActivity/.test(line));
    const packages = new Set(lines.map(line => line.match(/\b([a-zA-Z]\w*(?:\.\w+)+)\/[.\w$]+/)?.[1]).filter(Boolean));
    if (packages.size !== 1) throw new RemoteError('FOREGROUND_UNKNOWN', 'Could not identify a unique foreground application.', 3, 'Unlock the TV and check its foreground activity.');
    return packages.has(this.c.appPackage);
  }
  async reverse(): Promise<void> {
    const matches = (text: string) => text.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.at(-2) === `tcp:${this.c.port}`);
    const current = matches(await this.command(['reverse', '--list']));
    if (current.some(parts => parts.at(-1) !== `tcp:${this.c.port}`)) throw new RemoteError('ADB_PORT_ALREADY_OWNED', 'The reverse port belongs to a different mapping.', 3, 'Choose another port or resolve the mapping owner explicitly.');
    if (current.length) return;
    try { await this.command(['reverse', '--no-rebind', `tcp:${this.c.port}`, `tcp:${this.c.port}`]); }
    catch (error) {
      const after = matches(await this.command(['reverse', '--list']));
      if (after.length === 1 && after[0].at(-1) === `tcp:${this.c.port}`) return;
      throw error;
    }
  }
  async wake(): Promise<void> {
    if (!await this.foreground()) throw new RemoteError('APP_NOT_FOREGROUND', 'Lampa is not the foreground application.', 3, 'Run lampa app start explicitly.');
    await this.command(['shell', 'input', 'keyevent', this.c.androidWakeCode]);
  }
  async app(action: string): Promise<{ action: string; dispatched: true }> {
    if (action !== 'start') await this.command(['shell', 'am', 'force-stop', this.c.appPackage], true);
    if (action !== 'stop') {
      const text = await this.command(['shell', 'am', 'start', '-W', '-n', `${this.c.appPackage}/${this.c.appActivity}`], true);
      if (/\bError:|Exception|does not exist/i.test(text)) throw new RemoteError('APP_START_FAILED', 'Android rejected the configured activity.', 3, 'Check appPackage/appActivity in config.json.');
    }
    return { action, dispatched: true };
  }
}
