import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('The background notification helper currently supports macOS only.');
  process.exit(1);
}
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodePath = process.execPath;
const homeDir = os.homedir();
const label = 'com.local.task-companion';
const assistantLabel = 'com.local.task-companion.assistant';
const launchAgentsDir = path.join(homeDir, 'Library', 'LaunchAgents');
const plistPath = path.join(launchAgentsDir, `${label}.plist`);
const supportDir = path.join(packageDir, 'data');
const assistantApp = path.join(supportDir, 'TaskCompanionAssistant.app');
const assistantExecutable = path.join(assistantApp, 'Contents', 'MacOS', 'TaskCompanionAssistant');
const assistantSource = path.join(packageDir, 'assistant-helper', 'main.swift');
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(path.join(packageDir, 'server.mjs'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(packageDir)}</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(supportDir, 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(supportDir, 'server-error.log'))}</string>
</dict></plist>
`;
await fs.mkdir(path.dirname(assistantExecutable), { recursive: true });
const build = spawnSync('/usr/bin/swiftc', ['-parse-as-library', '-framework', 'AppKit', '-framework', 'SwiftUI', '-framework', 'UserNotifications', assistantSource, '-o', assistantExecutable], { stdio: 'inherit' });
if (build.status !== 0) {
  console.error('Could not build the Mac floating companion. The dashboard service was not reconfigured.');
  process.exit(build.status || 1);
}
const assistantInfo = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>TaskCompanionAssistant</string><key>CFBundleIdentifier</key><string>com.local.task-companion.assistant-app</string><key>CFBundleName</key><string>Task Companion Assistant</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>1.0</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/><key>NSUserNotificationUsageDescription</key><string>在陪跑计时到点时提醒你汇报进度。</string></dict></plist>`;
await fs.writeFile(path.join(assistantApp, 'Contents', 'Info.plist'), assistantInfo, { mode: 0o644 });
const sign = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--identifier', 'com.local.task-companion.assistant-app', assistantApp], { stdio: 'inherit' });
if (sign.status !== 0) process.exit(sign.status || 1);
const assistantPlistPath = path.join(launchAgentsDir, `${assistantLabel}.plist`);
const assistantPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${assistantLabel}</string>
  <key>ProgramArguments</key><array><string>${xml(assistantExecutable)}</string></array>
  <key>WorkingDirectory</key><string>${xml(packageDir)}</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(supportDir, 'assistant.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(supportDir, 'assistant-error.log'))}</string>
</dict></plist>
`;
await fs.mkdir(launchAgentsDir, { recursive: true });
await fs.mkdir(supportDir, { recursive: true });
await fs.writeFile(plistPath, plist, { mode: 0o600 });
const domain = `gui/${process.getuid()}`;
spawnSync('/bin/launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
spawnSync('/bin/launchctl', ['bootout', domain, assistantPlistPath], { stdio: 'ignore' });
const result = spawnSync('/bin/launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
if (result.status !== 0) {
  console.error(`LaunchAgent file created at ${plistPath}, but launchctl could not start it.`);
  process.exit(result.status || 1);
}
await fs.writeFile(assistantPlistPath, assistantPlist, { mode: 0o600 });
const assistantResult = spawnSync('/bin/launchctl', ['bootstrap', domain, assistantPlistPath], { stdio: 'inherit' });
if (assistantResult.status !== 0) {
  console.error(`Dashboard is running, but the floating companion could not start. LaunchAgent: ${assistantPlistPath}`);
  process.exit(assistantResult.status || 1);
}
console.log('Task Companion will now run after login.');
console.log('The floating companion also starts after login; allow macOS notifications when prompted.');
console.log('Open http://127.0.0.1:43129');
console.log(`LaunchAgent: ${plistPath}`);
