import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

export function fakeAdb(t, settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lampa-fake-adb-'));
  const config = join(dir, 'fake.json'), log = join(dir, 'calls.jsonl');
  writeFileSync(config, JSON.stringify(settings)); writeFileSync(log, '');
  writeFileSync(join(dir, 'adb'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(process.env.FAKE_ADB_CONFIG));
fs.appendFileSync(process.env.FAKE_ADB_LOG, JSON.stringify(args)+'\\n');
setTimeout(() => {
  if (args[0] === 'devices') console.log('List of devices attached\\n' + (c.devices === undefined ? 'TV1 device model:FakeTV' : c.devices));
  else if (args.includes('dumpsys')) console.log('mResumedActivity: ActivityRecord{123 u0 '+(c.foreground || 'ru.twicker.lampa')+'/.ui.MainActivity t1}');
  else if (args.includes('--list')) console.log(c.reverse === undefined ? '' : c.reverse);
  else if (args.includes('am') && args.includes('start')) console.log(c.appError ? 'Error type 3\\nActivity class does not exist.' : 'Status: ok');
}, c.delayMs || 0);
`, { mode: 0o755 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    env: { PATH: dir + delimiter + process.env.PATH, FAKE_ADB_CONFIG: config, FAKE_ADB_LOG: log },
    log, calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)),
    update: value => writeFileSync(config, JSON.stringify(value)),
  };
}
