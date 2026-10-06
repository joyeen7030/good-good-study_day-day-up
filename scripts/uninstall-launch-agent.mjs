import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

if (process.platform !== 'darwin') {
  console.error('The background notification helper currently supports macOS only.');
  process.exit(1);
}
const label = 'com.local.task-companion';
const assistantLabel = 'com.local.task-companion.assistant';
const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = path.join(launchAgentsDir, `${label}.plist`);
const assistantPlistPath = path.join(launchAgentsDir, `${assistantLabel}.plist`);
const domain = `gui/${process.getuid()}`;
const { spawnSync } = await import('node:child_process');
spawnSync('/bin/launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
spawnSync('/bin/launchctl', ['bootout', domain, assistantPlistPath], { stdio: 'ignore' });
await fs.rm(plistPath, { force: true });
await fs.rm(assistantPlistPath, { force: true });
console.log('Task Companion and its floating companion have been removed from login startup. Local task data was kept.');
