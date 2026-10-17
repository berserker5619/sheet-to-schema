#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Pacific/Kiritimati',
];

const failures = [];
for (const zone of ZONES) {
  process.stdout.write(`  ${zone.padEnd(22)}`);
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js'), '--silent', 'coerce|xlsx-source'],
    {
      cwd: ROOT,
      env: { ...process.env, TZ: zone },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    console.log('FAILED');
    failures.push({ zone, output: (result.stderr || result.stdout || '').trim() });
  } else {
    console.log('ok');
  }
}

if (failures.length) {
  console.error(`\nDate handling differs by timezone in ${failures.length} zone(s):\n`);
  for (const failure of failures) {
    console.error(`── ${failure.zone} ──────────────────────────────────`);
    console.error(failure.output.split('\n').slice(-30).join('\n'));
  }
  process.exit(1);
}
console.log(`\nDates hold in all ${ZONES.length} timezones.`);
