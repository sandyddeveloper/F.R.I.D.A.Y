#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  STATE_DIR, ensureStateDir, loadCredentials, saveCredentials, clearCredentials,
  httpJson, discoverLanPhones, resolveLiveTarget, isFridayHealth
} from '../bridge/phonebox-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TELEMETRY_PATH = path.join(ROOT, 'bridge', 'phonebox-telemetry.mjs');
const LOCK_PATH = path.join(STATE_DIR, 'telemetry.lock');

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function askPrompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

function stopDaemon() {
  let stopped = false;
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      const pid = Number(lock.pid);
      if (pid && isPidAlive(pid)) {
        process.kill(pid, 'SIGTERM');
        console.log(`Stopped F.R.I.D.A.Y. bridge daemon (PID ${pid}).`);
        stopped = true;
      }
      try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
    }
    if (process.platform === 'win32') {
      const psCmd = "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and (($_.Name -eq 'node.exe' -and $_.CommandLine -like '*phonebox-telemetry.mjs*--daemon*') -or ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*-File*phonebox-winhost.ps1*')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
      execFileSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psCmd], { timeout: 3000, stdio: 'ignore', windowsHide: true });
    }
    return stopped;
  } catch (e) {
    console.log('Stop check:', e?.message || 'done');
    return stopped;
  }
}

function startDaemon() {
  ensureStateDir();
  try {
  if (fs.existsSync(LOCK_PATH)) {
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (isPidAlive(Number(lock.pid)) && Date.now() - Number(lock.heartbeat || 0) < 35_000) {
      console.log(`F.R.I.D.A.Y. daemon already running (PID ${lock.pid}).`);
      return;
    }
  }
  } catch (_) {}
  const child = spawn(process.execPath, [TELEMETRY_PATH, '--daemon'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  console.log(`Started F.R.I.D.A.Y. background bridge (PID ${child.pid}).`);
}

async function cmdConnect(argUrl) {
  let targetUrl = String(argUrl || '').trim().replace(/\/$/, '');
  if (targetUrl && !/^https?:\/\//i.test(targetUrl)) targetUrl = 'http://' + targetUrl;

  if (!targetUrl) {
    console.log('Scanning LAN for F.R.I.D.A.Y. devices...');
    const found = await discoverLanPhones(8765, 700);
    if (found.length === 1) {
      targetUrl = found[0].url;
      console.log(`Found ${found[0].deviceName} at ${targetUrl}`);
    } else if (found.length > 1) {
      found.forEach((f, i) => console.log(`  [${i + 1}] ${f.deviceName} (${f.url})`));
      const pick = await askPrompt('Select device number or paste URL: ');
      const idx = Number(pick) - 1;
      targetUrl = found[idx] ? found[idx].url : pick;
    } else {
      targetUrl = await askPrompt('Enter Phone URL (e.g. http://192.168.1.25:8765 or https://relay.example.com/r/ROOM): ');
    }
  }
  targetUrl = String(targetUrl || '').trim().replace(/\/$/, '');
  if (!targetUrl) { console.error('No URL provided.'); process.exit(1); }

  const health = await httpJson('GET', `${targetUrl}/api/health`, null, {}, 2500);
  if (!health.ok || !isFridayHealth(health.data)) {
    console.error(`Could not reach F.R.I.D.A.Y. Server at ${targetUrl}`);
    process.exit(1);
  }
  const phoneName = health.data.deviceName || 'F.R.I.D.A.Y.';
  console.log(`\nConnected to ${phoneName}. Requesting pairing permission...`);

  const reqRes = await httpJson('POST', `${targetUrl}/api/pair/request`, {
    deviceName: os.hostname(),
    platform: process.platform
  }, {}, 3000);

  if (!reqRes.ok || !reqRes.data?.requestId) {
    console.error('Pairing request failed:', reqRes.data?.error || 'Unknown error');
    process.exit(1);
  }
  const requestId = reqRes.data.requestId;

  console.log('\n======================================================');
  console.log(` 1. Check "${phoneName}" — tap [Allow & Show 6-Digit Code]`);
  console.log(' 2. Enter that 6-digit code here to confirm access');
  console.log('======================================================\n');

  let finalCreds = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const code = (await askPrompt('Enter 6-digit confirmation code from phone: ')).replace(/\D+/g, '');
    if (code.length !== 6) {
      console.log('Please enter all 6 digits.');
      continue;
    }
    const conf = await httpJson('POST', `${targetUrl}/api/pair/confirm`, { requestId, code }, {}, 3500);
    if (conf.ok && conf.data?.token) {
      const existing = loadCredentials() || {};
      const isRelay = targetUrl.includes('/r/');
      finalCreds = {
        lanUrl: isRelay ? (existing.lanUrl || '') : targetUrl,
        remoteUrl: isRelay ? targetUrl : (existing.remoteUrl || ''),
        token: conf.data.token,
        deviceId: conf.data.deviceId,
        deviceName: conf.data.deviceName || os.hostname(),
        phoneName: conf.data.phoneName || phoneName,
        pairedAt: Date.now()
      };
      saveCredentials(finalCreds);
      break;
    }
    console.error(`Confirmation failed: ${conf.data?.error || 'Check code and ensure you tapped Allow on F.R.I.D.A.Y.'}`);
  }

  if (!finalCreds) {
    console.error('Pairing incomplete.');
    process.exit(1);
  }

  console.log(`\nPaired permanently with ${finalCreds.phoneName} (saved in ~/.phonebox/credentials.json)!`);
  if (!finalCreds.remoteUrl) {
    const optRemote = await askPrompt('Optional Remote/Tailscale/Relay URL for anywhere access (Enter to skip): ');
    if (optRemote) {
      finalCreds.remoteUrl = optRemote.replace(/\/$/, '');
      saveCredentials(finalCreds);
    }
  }
  stopDaemon();
  startDaemon();
  console.log('F.R.I.D.A.Y. active: Telemetry, Process Watch, Screen Peek, Trackpad & Music Studio!');
}

async function cmdStatus() {
  const creds = loadCredentials();
  if (!creds?.token) {
    console.log('Status: Not paired. Run `friday connect` to pair with your phone using the 6-digit code.');
  } else {
    console.log(`Paired Phone: ${creds.phoneName || 'F.R.I.D.A.Y.'} (${creds.deviceId})`);
    if (creds.lanUrl) console.log(`  LAN URL:    ${creds.lanUrl}`);
    if (creds.remoteUrl) console.log(`  Remote URL: ${creds.remoteUrl}`);
  }
  const live = await resolveLiveTarget(1500);
  console.log(`Reachable:    ${live.online ? `YES (${live.base}${live.isRelay ? ' via Relay' : ' via LAN'})` : 'Offline'}`);
  if (fs.existsSync(LOCK_PATH)) {
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    console.log(`Daemon PID:   ${lock.pid} (${isPidAlive(Number(lock.pid)) ? 'running' : 'stale'})`);
  } else {
    console.log('Daemon PID:   stopped');
  }
}

async function cmdUnpair() {
  const creds = loadCredentials();
  if (creds?.token) {
    const live = await resolveLiveTarget(1500);
    if (live.online && creds.deviceId) {
      await httpJson('DELETE', `${live.base}/api/pair/devices/${encodeURIComponent(creds.deviceId)}`, null, { token: creds.token }, 1800);
    }
  }
  stopDaemon();
  clearCredentials();
  console.log('Unpaired laptop and removed F.R.I.D.A.Y. credentials.');
}

function cmdInstallService() {
  ensureStateDir();
  if (process.platform === 'win32') {
    const vbsPath = path.join(STATE_DIR, 'launch-friday.vbs');
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const vbs = `CreateObject("WScript.Shell").Run ${q(`${q(process.execPath)} ${q(TELEMETRY_PATH)} --daemon`)}, 0, False\r\n`;
    fs.writeFileSync(vbsPath, vbs, 'utf8');
    execFileSync('schtasks.exe', [
      '/Create', '/TN', 'FRIDAY-Bridge-Daemon', '/SC', 'ONLOGON',
      '/RL', 'LIMITED', '/F', '/TR', `wscript.exe //B //Nologo "${vbsPath}"`
    ], { stdio: 'inherit', windowsHide: true });
    console.log('Installed Windows auto-start task: FRIDAY-Bridge-Daemon (hidden on logon).');
    return;
  }
  if (process.platform === 'darwin') {
    const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(plistDir, { recursive: true });
    const plistPath = path.join(plistDir, 'com.friday.control.plist');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.friday.control</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${TELEMETRY_PATH}</string><string>--daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>\n`;
    fs.writeFileSync(plistPath, plist, 'utf8');
    try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch (_) {}
    execFileSync('launchctl', ['load', plistPath], { stdio: 'inherit' });
    console.log(`Installed macOS LaunchAgent: ${plistPath}`);
    return;
  }
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, 'friday-bridge.service');
  const unit = `[Unit]
Description=F.R.I.D.A.Y. Control Center Host Bridge
After=network-online.target

[Service]
ExecStart="${process.execPath}" "${TELEMETRY_PATH}" --daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unit, 'utf8');
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  execFileSync('systemctl', ['--user', 'enable', '--now', 'friday-bridge.service'], { stdio: 'inherit' });
  console.log(`Installed Linux systemd user service: ${unitPath}`);
}

function cmdUninstallService() {
  if (process.platform === 'win32') {
    try { execFileSync('schtasks.exe', ['/Delete', '/TN', 'FRIDAY-Bridge-Daemon', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
    try { fs.unlinkSync(path.join(STATE_DIR, 'launch-friday.vbs')); } catch (_) {}
    console.log('Removed Windows auto-start task: FRIDAY-Bridge-Daemon.');
    return;
  }
  if (process.platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.friday.control.plist');
    try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch (_) {}
    try { fs.unlinkSync(plistPath); } catch (_) {}
    console.log('Removed macOS LaunchAgent.');
    return;
  }
  const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'friday-bridge.service');
  try { execFileSync('systemctl', ['--user', 'disable', '--now', 'friday-bridge.service'], { stdio: 'ignore' }); } catch (_) {}
  try { fs.unlinkSync(unitPath); } catch (_) {}
  console.log('Removed Linux systemd user service.');
}

const cmd = (process.argv[2] || 'help').toLowerCase();
if (cmd === 'connect' || cmd === 'pair') {
  cmdConnect(process.argv[3]).catch(e => { console.error(e); process.exit(1); });
} else if (cmd === 'start') {
  const creds = loadCredentials();
  if (!creds?.token && !process.argv.includes('--force')) {
    console.error('Laptop is not paired yet. Run `friday connect` first to confirm the 6-digit pairing code.');
    process.exit(1);
  }
  startDaemon();
} else if (cmd === 'stop') {
  stopDaemon();
} else if (cmd === 'restart') {
  stopDaemon();
  setTimeout(startDaemon, 300);
} else if (cmd === 'status') {
  cmdStatus();
} else if (cmd === 'unpair') {
  cmdUnpair();
} else if (cmd === 'install-service') {
  cmdInstallService();
} else if (cmd === 'uninstall-service') {
  cmdUninstallService();
} else {
  console.log(`F.R.I.D.A.Y. CLI v2.0 (Open Source)
Usage:
  friday connect [url]      Discover phone or connect via LAN/Tailscale/Relay & confirm 6-digit code
  friday start              Start laptop telemetry & control daemon
  friday stop               Stop background daemon
  friday status             Check phone reachability (LAN / Relay) & pairing state
  friday install-service    Auto-start F.R.I.D.A.Y. bridge silently on system login
  friday uninstall-service  Remove auto-start service
  friday unpair             Revoke access on phone & clear local credentials`);
}
