import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { STATE_DIR, ensureStateDir, httpJson, httpRaw, resolveLiveTarget } from './phonebox-client.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);
const LOCK_PATH = path.join(STATE_DIR, 'telemetry.lock');
const WINHOST_PATH = path.join(HERE, 'phonebox-winhost.ps1');
const POPUP_PATH = path.join(HERE, 'phonebox-notif-popup.ps1');
ensureStateDir();

let cachedAdapters = null;
let lastPing = { pingMs: null, lossPct: null, fetchedAt: 0 };
let prevProcCpu = new Map();
let cachedProcesses = { totalProcs: 0, totalApps: 0, byRam: [], byCpu: [], fetchedAt: 0 };
let defaultsSynced = false;

let winHostProc = null;
let winHostReady = false;
let winReqSeq = 1;
const winPending = new Map();
const seenPhoneNotifs = new Map();
let callActiveNow = false;
let didAutoMuteForCall = false;
let latestSettings = {};
const DAEMON_BOOT_TS = Date.now();
let cachedControl = { vol: -1, muted: false, bright: -1, outputs: [], audioSessions: [], wins: [], smtc: { active: false }, fetchedAt: 0 };
let lastSmtcThumbKey = '';
let smtcArtFetchInFlight = false;
let smtcArtHasData = false;
let clipBootInitialized = false;
let lastLapClip = '';
let lastSyncedClip = '';
let appsSyncedOnce = false;
let fastPushFn = null;
let lastAlivePids = new Set();
let lastPidCpuMap = new Map();
const watchIdleStreaks = new Map();
const triggeredWatchIds = new Set();

const NEVER_KILL = new Set([
  'system', 'registry', 'smss', 'csrss', 'wininit', 'services', 'lsass',
  'svchost', 'memory compression', 'dwm', 'winlogon', 'fontdrvhost'
]);

const APP_DISPLAY_MAP = {
  antigravity: 'Antigravity IDE',
  'antigravity ide': 'Antigravity IDE',
  agy: 'Antigravity CLI',
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  msedgewebview2: 'Edge WebView2',
  code: 'Visual Studio Code',
  node: 'Node.js',
  python: 'Python',
  python3: 'Python',
  explorer: 'Windows Explorer',
  onedrive: 'Microsoft OneDrive',
  'docker desktop': 'Docker Desktop',
  discord: 'Discord',
  spotify: 'Spotify',
  slack: 'Slack',
  steam: 'Steam',
  obs64: 'OBS Studio',
  svchost: 'Windows Services',
  windowsterminal: 'Windows Terminal',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  java: 'Java Runtime',
  javaw: 'Java Runtime'
};

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function parseFinite(raw) {
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

export function triggerTelemetryStream() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      if (isPidAlive(Number(lock.pid)) && Date.now() - Number(lock.heartbeat || lock.startedAt || 0) < 90_000) {
        return;
      }
    }
    const child = spawn(process.execPath, [SELF_PATH, '--daemon'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  } catch (_) {}
}

function snapshotCpu() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  let speedSum = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
    speedSum += Number(c.speed || 0);
  }
  const rawModel = String(cpus[0]?.model || os.arch() || 'Unknown CPU').replace(/\s+/g, ' ').trim();
  const cleanModel = rawModel.replace(/\s+with\s+Radeon Graphics$/i, '').trim();
  return {
    idle,
    total,
    cores: cpus.length || 1,
    clockMhz: cpus.length ? Math.round(speedSum / cpus.length) : 0,
    cpuName: cleanModel || rawModel
  };
}

function computeCpuPct(prev, curr) {
  if (!prev || !curr) return null;
  const dTotal = curr.total - prev.total;
  const dIdle = curr.idle - prev.idle;
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)));
}

async function getAdaptersOnce() {
  if (cachedAdapters !== null) return cachedAdapters;
  try {
    if (process.platform === 'win32') {
      if (winHostReady) {
        const res = await requestWinCmd({ op: 'get_adapters' }, 2500);
        if (res && Array.isArray(res.adapters)) {
          cachedAdapters = res.adapters;
          return cachedAdapters;
        }
      }
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress'],
        { timeout: 3000, windowsHide: true }
      );
      const parsed = JSON.parse(String(stdout || '[]').trim() || '[]');
      const list = Array.isArray(parsed) ? parsed : [parsed];
      cachedAdapters = list
        .filter(x => x && x.Name)
        .map(x => ({
          name: String(x.Name).trim(),
          vramMb: Number(x.AdapterRAM) > 0 ? Math.round(Number(x.AdapterRAM) / (1024 * 1024)) : 0
        }));
      return cachedAdapters;
    }
  } catch (_) {}
  cachedAdapters = [];
  return cachedAdapters;
}

async function readNvidiaGpu() {
  try {
    if (process.platform === 'win32' && winHostReady) {
      const res = await requestWinCmd({ op: 'get_gpu' }, 1800);
      if (res && res.op === 'get_gpu') return res.gpu || null;
    }
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 1500, windowsHide: true }
    );
    const firstLine = String(stdout || '').trim().split(/\r?\n/)[0] || '';
    if (!firstLine) return null;
    const parts = firstLine.split(',').map(s => s.trim());
    if (parts.length < 6) return null;
    return {
      gpuName: parts[0],
      gpuPct: parseFinite(parts[1]),
      gpuTempC: parseFinite(parts[2]),
      gpuPowerW: parseFinite(parts[3]),
      vramUsedMb: parseFinite(parts[4]),
      vramTotalMb: parseFinite(parts[5])
    };
  } catch (_) {
    return null;
  }
}

function readDisks() {
  const drives = [];
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      try {
        const st = fs.statfsSync(`${letter}:/`);
        const total = Number(st.blocks) * Number(st.bsize);
        const free = Number(st.bavail) * Number(st.bsize);
        if (!Number.isFinite(total) || total <= 0) continue;
        const used = Math.max(0, total - free);
        const totalGb = round1(total / (1024 ** 3));
        const usedGb = round1(used / (1024 ** 3));
        const pct = Math.max(0, Math.min(100, Math.round((used / total) * 100)));
        drives.push({ label: `${letter}:`, usedGb, totalGb, pct });
      } catch (_) {}
    }
  } else {
    try {
      const st = fs.statfsSync('/');
      const total = Number(st.blocks) * Number(st.bsize);
      const free = Number(st.bavail) * Number(st.bsize);
      if (total > 0) {
        const used = Math.max(0, total - free);
        drives.push({
          label: '/',
          usedGb: round1(used / (1024 ** 3)),
          totalGb: round1(total / (1024 ** 3)),
          pct: Math.round((used / total) * 100)
        });
      }
    } catch (_) {}
  }
  return drives;
}

async function readNetBytes() {
  try {
    if (process.platform === 'win32') {
      if (winHostReady) {
        const res = await requestWinCmd({ op: 'get_net' }, 1500);
        if (res && typeof res.rx === 'number' && typeof res.tx === 'number') {
          return { rx: res.rx, tx: res.tx, ts: Date.now() };
        }
      }
      const { stdout } = await execFileAsync('netstat', ['-e'], { timeout: 1200, windowsHide: true });
      const m = String(stdout || '').match(/Bytes\s+(\d+)\s+(\d+)/i);
      if (m) return { rx: Number(m[1]), tx: Number(m[2]), ts: Date.now() };
    } else if (fs.existsSync('/proc/net/dev')) {
      const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
      let rx = 0, tx = 0;
      for (const ln of lines) {
        const parts = ln.trim().split(/[:\s]+/);
        if (parts.length >= 10 && parts[0] !== 'lo') {
          rx += Number(parts[1] || 0);
          tx += Number(parts[9] || 0);
        }
      }
      return { rx, tx, ts: Date.now() };
    }
  } catch (_) {}
  return null;
}

function computeNetRates(prevNet, currNet) {
  if (!prevNet || !currNet || currNet.ts <= prevNet.ts) return { rxKbps: 0, txKbps: 0 };
  const dt = (currNet.ts - prevNet.ts) / 1000;
  if (dt <= 0) return { rxKbps: 0, txKbps: 0 };
  const dRx = Math.max(0, currNet.rx - prevNet.rx);
  const dTx = Math.max(0, currNet.tx - prevNet.tx);
  return {
    rxKbps: round1((dRx / 1024) / dt),
    txKbps: round1((dTx / 1024) / dt)
  };
}

async function refreshPingIfStale(force = false) {
  const now = Date.now();
  if (!force && now - lastPing.fetchedAt < 10_000) return lastPing;
  try {
    if (process.platform === 'win32' && winHostReady) {
      const res = await requestWinCmd({ op: 'get_ping' }, 2200);
      if (res && res.op === 'get_ping') {
        lastPing = { pingMs: Number(res.pingMs ?? -1), lossPct: Number(res.lossPct ?? 100), fetchedAt: now };
        return lastPing;
      }
    }
    const args = process.platform === 'win32'
      ? ['-n', '2', '-w', '750', '8.8.8.8']
      : ['-c', '2', '-W', '1', '8.8.8.8'];
    const { stdout } = await execFileAsync('ping', args, { timeout: 2400, windowsHide: true });
    const txt = String(stdout || '');
    const avgM = txt.match(/Average\s*=\s*(\d+)\s*ms/i) || txt.match(/time[=<]\s*(\d+)\s*ms/i);
    const lossM = txt.match(/\((\d+)%\s*loss\)/i) || txt.match(/(\d+(?:\.\d+)?)%\s*packet\s*loss/i);
    lastPing = {
      pingMs: avgM ? Number(avgM[1]) : -1,
      lossPct: lossM ? Math.round(Number(lossM[1])) : 0,
      fetchedAt: now
    };
  } catch (e) {
    const out = String(e?.stdout || '');
    const lossM = out.match(/\((\d+)%\s*loss\)/i);
    lastPing = {
      pingMs: -1,
      lossPct: lossM ? Math.round(Number(lossM[1])) : 100,
      fetchedAt: now
    };
  }
  return lastPing;
}

async function syncSmtcArtwork(targetRef, smtc) {
  if (!targetRef?.online || !targetRef.base) return;
  if (!smtc?.active || !smtc?.hasThumb || !smtc?.thumbKey) {
    if (smtcArtHasData || lastSmtcThumbKey) {
      lastSmtcThumbKey = '';
      smtcArtHasData = false;
      await httpJson('DELETE', `${targetRef.base}/api/laptop/smtc-art`, {}, targetRef, 900);
    }
    return;
  }
  if (smtc.thumbKey === lastSmtcThumbKey || smtcArtFetchInFlight) return;
  smtcArtFetchInFlight = true;
  try {
    const res = await requestWinCmd({ op: 'get_smtc_art' }, 2800);
    if (res?.b64) {
      const buf = Buffer.from(res.b64, 'base64');
      const r = await httpRaw(
        'POST',
        `${targetRef.base}/api/laptop/smtc-art?key=${encodeURIComponent(smtc.thumbKey)}`,
        buf,
        { 'Content-Type': res.contentType || 'image/jpeg' },
        targetRef,
        1500
      );
      if (r.ok) {
        lastSmtcThumbKey = smtc.thumbKey;
        smtcArtHasData = true;
      }
    }
  } finally {
    smtcArtFetchInFlight = false;
  }
}

async function buildPayload(prevCpu, currCpu, prevNet, currNet, forceProcs = false, targetRef = null) {
  const [adapters, nvidia, ping, processes, ctrl] = await Promise.all([
    getAdaptersOnce(),
    readNvidiaGpu(),
    refreshPingIfStale(false),
    refreshProcessesIfStale(currCpu.cores, forceProcs),
    winHostReady ? requestWinCmd({ op: 'get_control_state' }, 1800) : Promise.resolve(null)
  ]);
  if (ctrl) {
    cachedControl = {
      vol: typeof ctrl.vol === 'number' ? ctrl.vol : cachedControl.vol,
      muted: Boolean(ctrl.muted),
      bright: typeof ctrl.bright === 'number' ? ctrl.bright : cachedControl.bright,
      outputs: Array.isArray(ctrl.outputs) ? ctrl.outputs : [],
      audioSessions: Array.isArray(ctrl.audioSessions) ? ctrl.audioSessions : [],
      wins: Array.isArray(ctrl.wins) ? ctrl.wins.slice(0, 20) : [],
      smtc: ctrl.smtc || { active: false },
      fetchedAt: Date.now()
    };
    syncSmtcArtwork(targetRef, cachedControl.smtc).catch(() => {});
    const clip = typeof ctrl.clip === 'string' ? ctrl.clip.trim() : '';
    if (!clipBootInitialized) {
      clipBootInitialized = true;
      lastLapClip = clip;
    } else if (clip && clip !== lastLapClip && clip !== lastSyncedClip && clip.length <= 4000) {
      lastLapClip = clip;
      if (latestSettings.clip_auto_sync !== '0' && targetRef?.online && targetRef.base) {
        lastSyncedClip = clip;
        httpJson('POST', `${targetRef.base}/api/clipboard`, { content: clip, source: 'laptop', copyToDevice: true }, targetRef, 800);
      }
    }
  }

  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();
  const usedMemBytes = Math.max(0, totalMemBytes - freeMemBytes);
  const ramTotalGb = round1(totalMemBytes / (1024 ** 3));
  const ramUsedGb = round1(usedMemBytes / (1024 ** 3));
  const ramPct = totalMemBytes > 0 ? Math.round((usedMemBytes / totalMemBytes) * 100) : 0;

  const cpuPct = computeCpuPct(prevCpu, currCpu);
  const net = computeNetRates(prevNet, currNet);
  const disks = readDisks();

  const isVirtual = (name) => /virtual|usb mobile|spacedesk|parsec|remote|mirror/i.test(name);
  const igpu = adapters
    .filter(a => !/nvidia|geforce|rtx|gtx|quadro/i.test(a.name) && !isVirtual(a.name))
    .sort((a, b) => (b.vramMb || 0) - (a.vramMb || 0))[0] || null;
  const fallbackDgpu = adapters.find(a => /nvidia|geforce|rtx|gtx|quadro/i.test(a.name)) || adapters.find(a => !isVirtual(a.name)) || adapters[0] || null;

  return {
    hostname: os.hostname(),
    platform: process.platform,
    osRelease: os.release(),
    uptimeSec: Math.floor(os.uptime()),
    cpuName: currCpu.cpuName,
    cpuPct: cpuPct ?? 0,
    cpuCores: currCpu.cores,
    cpuClockMhz: currCpu.clockMhz,
    hasNvidia: Boolean(nvidia),
    gpuName: nvidia?.gpuName || fallbackDgpu?.name || 'No GPU API',
    gpuPct: nvidia?.gpuPct ?? null,
    gpuTempC: nvidia?.gpuTempC ?? null,
    gpuPowerW: nvidia?.gpuPowerW ?? null,
    vramUsedMb: nvidia?.vramUsedMb ?? null,
    vramTotalMb: nvidia?.vramTotalMb ?? (fallbackDgpu?.vramMb || null),
    igpuName: igpu?.name || '',
    igpuVramMb: igpu?.vramMb || 0,
    ramUsedGb,
    ramTotalGb,
    ramPct,
    disks,
    netRxKbps: net.rxKbps,
    netTxKbps: net.txKbps,
    pingMs: ping.pingMs,
    lossPct: ping.lossPct,
    processes,
    control: cachedControl,
    sampledAt: Date.now()
  };
}

function friendlyAppName(procName, desc) {
  const key = String(procName || '').toLowerCase();
  if (APP_DISPLAY_MAP[key]) return APP_DISPLAY_MAP[key];
  const d = String(desc || '').replace(/\s+\(32 bit\)/i, '').trim();
  if (d && d.length >= 2 && !/^microsoft®?\s+windows®?\s+operating\s+system$/i.test(d)) return d;
  return String(procName || 'Unknown');
}

async function sampleRawProcesses() {
  if (process.platform !== 'win32') return [];
  if (winHostReady) {
    const res = await requestWinCmd({ op: 'get_processes' }, 3500);
    if (res && Array.isArray(res.items)) return res.items;
  }
  const ps = [
    "$ErrorActionPreference='SilentlyContinue';",
    '$meta=@{};',
    '$out=New-Object System.Collections.Generic.List[object];',
    'foreach($p in [System.Diagnostics.Process]::GetProcesses()){',
    '$pn=$p.ProcessName; if($pn -eq "Idle"){continue}',
    'if(-not $meta.ContainsKey($pn)){',
    '$d="";$f="";$prot=$false;',
    'try{$mm=$p.MainModule; if($mm){$f=[string]$mm.FileName; $d=[string]$mm.FileVersionInfo.FileDescription}}catch{$prot=$true}',
    'if($p.SessionId -eq 0 -or $pn -in @("System","Registry","smss","csrss","wininit","services","lsass","svchost","Memory Compression")){$prot=$true}',
    '$meta[$pn]=@($d,$f,$prot)',
    '}',
    '$m=$meta[$pn];',
    '$c=0.0; try{$c=[double]$p.TotalProcessorTime.TotalSeconds}catch{}',
    '$out.Add([PSCustomObject]@{i=$p.Id;n=$pn;d=$m[0];f=$m[1];p=[bool]$m[2];r=[long]$p.WorkingSet64;c=$c})',
    '}',
    '$out | ConvertTo-Json -Compress'
  ].join(' ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps],
    { timeout: 3500, maxBuffer: 4 * 1024 * 1024, windowsHide: true }
  );
  const raw = String(stdout || '[]').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function refreshProcessesIfStale(cpuCores, force = false) {
  const now = Date.now();
  if (!force && now - cachedProcesses.fetchedAt < 3800) return cachedProcesses;
  try {
    const list = await sampleRawProcesses();
    if (!list.length) return cachedProcesses;
    const nextCpu = new Map();
    const groups = new Map();
    const nextAlivePids = new Set();
    const nextPidCpuPct = new Map();

    for (const item of list) {
      const pid = Number(item.i);
      const procName = String(item.n || '');
      if (!pid || !procName) continue;
      const cpuSec = Number(item.c || 0);
      const ramBytes = Math.max(0, Number(item.r || 0));
      nextCpu.set(pid, { c: cpuSec, ts: now });
      nextAlivePids.add(pid);

      const prev = prevProcCpu.get(pid);
      let pidCpuPct = 0;
      if (prev && now > prev.ts && cpuSec >= prev.c) {
        const dtSec = (now - prev.ts) / 1000;
        pidCpuPct = ((cpuSec - prev.c) / (dtSec * Math.max(1, cpuCores))) * 100;
      }
      nextPidCpuPct.set(pid, pidCpuPct);

      const appName = friendlyAppName(procName, item.d);
      const key = appName.toLowerCase();
      let g = groups.get(key);
      if (!g) {
        g = {
          name: appName,
          processName: procName,
          count: 0,
          ramBytes: 0,
          cpuPct: 0,
          path: String(item.f || ''),
          protected: Boolean(item.p) || NEVER_KILL.has(procName.toLowerCase()),
          pids: []
        };
        groups.set(key, g);
      }
      g.count++;
      g.ramBytes += ramBytes;
      g.cpuPct += pidCpuPct;
      if (!g.path && item.f) g.path = String(item.f);
      if (item.p) g.protected = true;
      g.pids.push({ pid, ramMb: round1(ramBytes / (1024 * 1024)) });
    }
    prevProcCpu = nextCpu;
    lastAlivePids = nextAlivePids;
    lastPidCpuMap = nextPidCpuPct;

    const allGroups = [...groups.values()].map(g => {
      g.cpuPct = Math.min(100, round1(g.cpuPct));
      g.pids = g.pids.sort((a, b) => b.ramMb - a.ramMb).slice(0, 8).map(x => x.pid);
      return g;
    });

    cachedProcesses = {
      totalProcs: list.length,
      totalApps: allGroups.length,
      byRam: [...allGroups].sort((a, b) => b.ramBytes - a.ramBytes).slice(0, 14),
      byCpu: [...allGroups].sort((a, b) => (b.cpuPct - a.cpuPct) || (b.ramBytes - a.ramBytes)).slice(0, 14),
      fetchedAt: now
    };
  } catch (_) {}
  return cachedProcesses;
}

function fetchHttpsJson(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    try {
      const req = https.get(url, { timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { resolve(null); }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    } catch (_) {
      resolve(null);
    }
  });
}

async function ensureCityAndClocksOnPhone(base, pin) {
  if (defaultsSynced) return;
  try {
    const res = await httpJson('GET', `${base}/api/settings`, null, pin, 900);
    if (!res.ok || !res.data) return;
    const s = res.data;
    const needWeather = !String(s.weather_lat || '').trim() || !String(s.weather_lon || '').trim();
    const needClocks = !String(s.world_clocks || '').trim();
    if (!needWeather && !needClocks) {
      defaultsSynced = true;
      return;
    }

    const geo = await fetchHttpsJson('https://get.geojs.io/v1/ip/geo.json', 2500);
    const patch = {};
    if (needWeather && geo?.latitude && geo?.longitude) {
      patch.weather_city = [geo.city, geo.country].filter(Boolean).join(', ') || String(geo.city || '');
      patch.weather_lat = String(geo.latitude);
      patch.weather_lon = String(geo.longitude);
    }
    if (needClocks) {
      const localTz = String(geo?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || '').trim();
      const localLbl = String(geo?.city || localTz.split('/').pop() || 'LOCAL').toUpperCase();
      const candidates = [
        ...(localTz ? [`${localTz}|${localLbl}`] : []),
        'Europe/London|LONDON',
        'America/New_York|NEW YORK',
        'Asia/Tokyo|TOKYO',
        'Asia/Dubai|DUBAI',
        'Europe/Tallinn|TALLINN'
      ];
      const seen = new Set();
      const picked = [];
      for (const item of candidates) {
        const tz = item.split('|')[0];
        if (!seen.has(tz)) {
          seen.add(tz);
          picked.push(item);
        }
        if (picked.length >= 5) break;
      }
      if (picked.length) patch.world_clocks = picked.join(',');
    }
    if (Object.keys(patch).length) {
      const putRes = await httpJson('PUT', `${base}/api/settings`, patch, pin, 1000);
      if (putRes.ok) defaultsSynced = true;
    } else {
      defaultsSynced = true;
    }
  } catch (_) {}
}

async function handlePendingLaptopCommands(base, pin) {
  let didKill = false;
  try {
    const claimed = await httpJson('POST', `${base}/api/laptop/commands/claim`, {}, pin, 700);
    const list = Array.isArray(claimed.data?.commands) ? claimed.data.commands : [];
    for (const cmd of list) {
      if (cmd.action !== 'kill') continue;
      let payload = {};
      try { payload = typeof cmd.payload === 'string' ? JSON.parse(cmd.payload) : (cmd.payload || {}); } catch (_) {}
      const name = String(payload.name || payload.processName || '').trim();
      const procLower = String(payload.processName || name).toLowerCase();
      if (!name || NEVER_KILL.has(procLower)) continue;

      const pids = (Array.isArray(payload.pids) ? payload.pids : [])
        .map(x => Number(x))
        .filter(n => Number.isInteger(n) && n > 4 && n !== process.pid);
      let killed = 0;
      for (const pid of pids) {
        try {
          await execFileAsync('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 2500, windowsHide: true });
          killed++;
        } catch (_) {}
      }
      if (killed > 0) didKill = true;
      await httpJson('POST', `${base}/api/notify`, {
        title: killed > 0 ? 'Process Ended' : 'End Task Skipped',
        body: killed > 0 ? `Stopped ${name} (${killed} PID${killed > 1 ? 's' : ''})` : `Could not terminate ${name} (protected or already exited)`,
        level: killed > 0 ? 'ok' : 'warn'
      }, pin, 700);
    }
  } catch (_) {}
  return didKill;
}

export async function collectLaptopTelemetrySample(sampleWindowMs = 700) {
  const c0 = snapshotCpu();
  const n0 = await readNetBytes();
  await refreshProcessesIfStale(c0.cores, true);
  await Promise.all([
    new Promise(r => setTimeout(r, sampleWindowMs)),
    refreshPingIfStale(true),
    getAdaptersOnce()
  ]);
  const c1 = snapshotCpu();
  const n1 = await readNetBytes();
  return buildPayload(c0, c1, n0, n1, true);
}

function ensureWinHost() {
  if (process.platform !== 'win32') return null;
  if (winHostProc && !winHostProc.killed) return winHostProc;
  winHostReady = false;
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-Sta', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', WINHOST_PATH],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
    );
    winHostProc = child;
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.ready) { winHostReady = true; continue; }
          if (msg.id && winPending.has(String(msg.id))) {
            const p = winPending.get(String(msg.id));
            winPending.delete(String(msg.id));
            clearTimeout(p.timer);
            p.resolve(msg);
          }
        } catch (_) {}
      }
    });
    child.on('exit', () => {
      winHostProc = null;
      winHostReady = false;
      for (const [, p] of winPending) { clearTimeout(p.timer); p.resolve(null); }
      winPending.clear();
    });
    return child;
  } catch (_) {
    return null;
  }
}

function sendWinCmd(obj) {
  const wh = ensureWinHost();
  if (!wh || !wh.stdin || wh.killed) return false;
  try {
    wh.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  } catch (_) {
    return false;
  }
}

function requestWinCmd(obj, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const id = 'r' + (winReqSeq++);
    const timer = setTimeout(() => {
      winPending.delete(id);
      resolve(null);
    }, timeoutMs);
    winPending.set(id, { resolve, timer });
    if (!sendWinCmd({ ...obj, id })) {
      clearTimeout(timer);
      winPending.delete(id);
      resolve(null);
    }
  });
}

function extractOtp(title, body) {
  const combined = `${title || ''} ${body || ''}`.trim();
  const m1 = combined.match(/\b(?:otp|one[\s-]*time|verification\s*code|security\s*code|passcode|login\s*code|auth(?:entication)?\s*code|code\s*(?:is|:))\b[\s\S]{0,28}?\b(\d{4,8})\b/i);
  if (m1) return m1[1];
  const m2 = combined.match(/\b(\d{4,8})\b[\s\S]{0,20}?\b(?:is\s+your\s+)?(?:otp|verification\s*code|login\s*code|passcode)\b/i);
  if (m2) return m2[1];
  return '';
}

function spawnActionPopup(item, otp, targetRef) {
  if (process.platform !== 'win32') return;
  const fullText = String(item.bigText || item.text || '').trim();
  const actions = Array.isArray(item.actions) ? item.actions : [];
  const replyAct = actions.find(a => a.canReply);
  const tmpFile = path.join(os.tmpdir(), `pb_notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify({
      app: item.app || 'Phone',
      title: item.title || item.app || 'Notification',
      text: fullText,
      otp: otp || '',
      canReply: Boolean(replyAct),
      actionIndex: replyAct ? Number(replyAct.index || 0) : 0,
      key: item.key || '',
      baseUrl: targetRef?.base || '',
      pin: targetRef?.pin || '',
      token: targetRef?.token || ''
    }), 'utf8');
    const c = spawn(
      'powershell.exe',
      ['-NoProfile', '-Sta', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', POPUP_PATH, '-PayloadFile', tmpFile],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    c.unref();
  } catch (_) {}
}

function handlePhoneNotification(item, targetRef, skipOldCheck = false) {
  if (!item || !item.key) return;
  if (latestSettings.win_notif_mirror === '0') return;
  const postTime = Number(item.postTime || 0);
  if (!skipOldCheck && postTime > 0 && postTime < DAEMON_BOOT_TS - 4000) {
    seenPhoneNotifs.set(item.key, `${postTime}|${item.title}|${item.text}`);
    return;
  }
  const fullText = String(item.bigText || item.text || '').trim();
  const sig = `${postTime}|${item.title}|${fullText}`;
  if (seenPhoneNotifs.get(item.key) === sig) return;
  seenPhoneNotifs.set(item.key, sig);
  if (seenPhoneNotifs.size > 200) {
    const firstKey = seenPhoneNotifs.keys().next().value;
    if (firstKey) seenPhoneNotifs.delete(firstKey);
  }

  const otp = extractOtp(item.title, fullText);
  const hasReply = Array.isArray(item.actions) && item.actions.some(a => a.canReply);
  const isCall = item.category === 'call';
  if (otp || hasReply || isCall) {
    spawnActionPopup(item, otp, targetRef);
  } else {
    sendWinCmd({
      op: 'toast',
      title: `${item.app || 'Phone'}: ${item.title || 'Notification'}`,
      body: fullText || 'New notification on phone'
    });
  }
}

async function handleCallAutoMute(callState, settings) {
  const enabled = settings?.call_auto_mute !== '0';
  const active = Boolean(callState?.active);
  if (enabled && active && !callActiveNow) {
    callActiveNow = true;
    const res = await requestWinCmd({ op: 'set_mute', mute: true }, 2500);
    didAutoMuteForCall = Boolean(res && !res.wasMuted);
    sendWinCmd({
      op: 'toast',
      title: `Phone ${callState.mode === 'ringing' ? 'Incoming Call' : 'Call Active'}`,
      body: `${callState.caller ? callState.caller + ' · ' : ''}Laptop audio muted automatically`
    });
  } else if ((!active || !enabled) && callActiveNow) {
    callActiveNow = false;
    if (didAutoMuteForCall) {
      didAutoMuteForCall = false;
      await requestWinCmd({ op: 'set_mute', mute: false }, 2500);
      sendWinCmd({
        op: 'toast',
        title: 'Phone Call Ended',
        body: 'Laptop audio restored'
      });
    }
  }
}

async function syncInstalledAppsToPhone(targetRef) {
  if (!targetRef?.online || !targetRef.base || !winHostReady) return;
  const res = await requestWinCmd({ op: 'scan_apps' }, 8000);
  if (Array.isArray(res?.apps) && res.apps.length) {
    const r = await httpJson('POST', `${targetRef.base}/api/laptop/apps`, { apps: res.apps }, targetRef, 2000);
    if (r.ok) appsSyncedOnce = true;
  }
}

async function processLaptopInputEvent(ev, targetRef) {
  if (!ev || !ev.op) return;
  if (ev.op === 'capture') {
    const res = await requestWinCmd({
      op: 'capture',
      maxW: Number(ev.maxW || 960),
      quality: Number(ev.quality || 62)
    }, 4000);
    if (res?.b64 && targetRef.base) {
      const buf = Buffer.from(res.b64, 'base64');
      await httpRaw(
        'POST',
        `${targetRef.base}/api/laptop/screen?w=${res.w || 0}&h=${res.h || 0}`,
        buf,
        { 'Content-Type': 'image/jpeg' },
        targetRef,
        2000
      );
    }
  } else if (ev.op === 'scan_apps') {
    await syncInstalledAppsToPhone(targetRef);
  } else if (
    ['set_mute', 'toggle_mute', 'set_vol', 'set_bright', 'set_audio_output', 'set_app_audio', 'launch_app', 'win_act', 'profile', 'system_act', 'seek_smtc'].includes(ev.op) ||
    (ev.op === 'key' && String(ev.combo || '').startsWith('media_'))
  ) {
    await requestWinCmd(ev, 2500);
    if (typeof fastPushFn === 'function') {
      setTimeout(() => fastPushFn(), 220);
    }
  } else {
    sendWinCmd(ev);
  }
}

function fmtElapsedMs(ms) {
  const sec = Math.max(1, Math.round(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function evaluateProcessWatches(targetRef) {
  if (!targetRef?.online || !targetRef.base) return;
  let watches = [];
  try {
    watches = JSON.parse(latestSettings.laptop_watches || '[]');
    if (!Array.isArray(watches)) watches = [];
  } catch (_) { watches = []; }
  if (!watches.length || !lastAlivePids.size) return;

  for (const w of watches) {
    if (!w?.id || triggeredWatchIds.has(w.id)) continue;
    const pids = Array.isArray(w.pids) ? w.pids.map(Number).filter(n => n > 0) : [];
    const alivePids = pids.filter(pid => lastAlivePids.has(pid));
    const hasProcAlive = alivePids.length > 0 || (!pids.length && cachedProcesses.byRam?.some(g => g.processName?.toLowerCase() === String(w.processName || '').toLowerCase()));

    let doneReason = '';
    if (w.mode === 'exit') {
      if (!hasProcAlive) doneReason = 'Process exited';
    } else {
      if (!hasProcAlive) {
        doneReason = 'Process exited';
      } else {
        const cpuSum = alivePids.reduce((acc, pid) => acc + Number(lastPidCpuMap.get(pid) || 0), 0);
        if (cpuSum <= 0.8) {
          const streak = (watchIdleStreaks.get(w.id) || 0) + 1;
          watchIdleStreaks.set(w.id, streak);
          if (streak >= 4) doneReason = 'Activity went idle';
        } else {
          watchIdleStreaks.set(w.id, 0);
        }
      }
    }

    if (doneReason) {
      triggeredWatchIds.add(w.id);
      watchIdleStreaks.delete(w.id);
      const elapsed = fmtElapsedMs(Date.now() - Number(w.startedAt || Date.now()));
      try {
        const remaining = watches.filter(x => x.id !== w.id);
        latestSettings.laptop_watches = JSON.stringify(remaining);
      } catch (_) {}
      await httpJson('DELETE', `${targetRef.base}/api/laptop/watch/${encodeURIComponent(w.id)}`, null, targetRef, 900);
      await httpJson('POST', `${targetRef.base}/api/notify`, {
        title: `${w.name} Complete`,
        body: `${doneReason} after ${elapsed}`,
        level: 'ok',
        vibrate: true,
        highPriority: true,
        page: 'processes'
      }, targetRef, 900);
      sendWinCmd({ op: 'toast', title: 'Watch Complete -> Pinged Mobile', body: `${w.name}: ${doneReason}` });
    }
  }
}

function startFastInputLoop(targetRef, isAliveFn) {
  (async () => {
    while (isAliveFn()) {
      if (!targetRef.online || !targetRef.base) {
        await new Promise(r => setTimeout(r, 800));
        continue;
      }
      const res = await httpJson('GET', `${targetRef.base}/api/laptop/input/wait?timeout=8000`, null, targetRef, 10500);
      if (!res.ok) {
        await new Promise(r => setTimeout(r, 700));
        continue;
      }
      const events = Array.isArray(res.data?.events) ? res.data.events : [];
      for (const ev of events) {
        await processLaptopInputEvent(ev, targetRef);
      }
    }
  })();
}

function applyPhoneStateSnapshot(parsed, targetRef, skipOldCheck = false) {
  if (!parsed || typeof parsed !== 'object') return;
  latestSettings = parsed.settings || latestSettings;
  if (parsed.smtcArt && Number(parsed.smtcArt.ts || 0) === 0 && smtcArtHasData) {
    lastSmtcThumbKey = '';
    smtcArtHasData = false;
  }
  handleCallAutoMute(parsed.callState || {}, latestSettings);
  const list = Array.isArray(parsed.phoneNotifications) ? parsed.phoneNotifications : [];
  for (const n of list) handlePhoneNotification(n, targetRef, skipOldCheck);
}

function startPhoneEventStream(targetRef, isAliveFn) {
  const connect = () => {
    if (!isAliveFn()) return;
    if (!targetRef.online || !targetRef.base) {
      setTimeout(connect, 1200);
      return;
    }
    if (targetRef.isRelay) {
      (async () => {
        const res = await httpJson('GET', `${targetRef.base}/api/state`, null, targetRef, 4500);
        if (res.ok && res.data) applyPhoneStateSnapshot(res.data, targetRef, false);
        setTimeout(connect, 2200);
      })();
      return;
    }
    try {
      const u = new URL(`${targetRef.base}/api/stream`);
      const mod = u.protocol === 'https:' ? https : http;
      const headers = {};
      if (targetRef.pin) headers['X-PhoneBox-Pin'] = targetRef.pin;
      if (targetRef.token) headers['X-PhoneBox-Token'] = targetRef.token;
      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          setTimeout(connect, 2000);
          return;
        }
        let buf = '';
        let curEvent = 'message';
        let curData = [];
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() ?? '';
          for (const ln of lines) {
            if (ln.startsWith('event:')) curEvent = ln.slice(6).trim();
            else if (ln.startsWith('data:')) curData.push(ln.slice(5).trim());
            else if (ln === '') {
              const raw = curData.join('\n');
              curData = [];
              if (raw) {
                try {
                  const parsed = JSON.parse(raw);
                  if (curEvent === 'phone_notif') {
                    handlePhoneNotification(parsed, targetRef, true);
                  } else if (curEvent === 'clip_sync') {
                    if (latestSettings.clip_auto_sync !== '0' && parsed.source !== 'laptop' && parsed.content && parsed.content !== lastSyncedClip && parsed.content.length <= 4000) {
                      lastSyncedClip = lastLapClip = String(parsed.content);
                      sendWinCmd({ op: 'set_clip', text: lastSyncedClip });
                    }
                  } else if (curEvent === 'state') {
                    applyPhoneStateSnapshot(parsed, targetRef, false);
                  }
                } catch (_) {}
              }
              curEvent = 'message';
            }
          }
        });
        res.on('end', () => setTimeout(connect, 1200));
        res.on('error', () => setTimeout(connect, 1800));
      });
      req.on('error', () => setTimeout(connect, 2000));
      req.end();
    } catch (_) {
      setTimeout(connect, 2000);
    }
  };
  connect();
}

async function runDaemon() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const cur = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      const curPid = Number(cur.pid);
      if (curPid && curPid !== process.pid && isPidAlive(curPid) && Date.now() - Number(cur.heartbeat || cur.startedAt || 0) < 35_000) {
        process.exit(0);
      }
    }
  } catch (_) {}
  const writeLock = (extra = {}) => {
    try {
      ensureStateDir();
      fs.writeFileSync(LOCK_PATH, JSON.stringify({
        pid: process.pid,
        startedAt: extra.startedAt || Date.now(),
        heartbeat: Date.now()
      }));
    } catch (_) {}
  };
  const startedAt = Date.now();
  writeLock({ startedAt });
  ensureWinHost();
  for (let i = 0; i < 24 && !winHostReady; i++) {
    await new Promise(r => setTimeout(r, 100));
  }

  let alive = true;
  const targetRef = { base: '', pin: '', token: '', online: false, isRelay: false };
  const initialTarget = await resolveLiveTarget(950);
  Object.assign(targetRef, initialTarget);

  startFastInputLoop(targetRef, () => alive);
  startPhoneEventStream(targetRef, () => alive);

  let prevCpu = snapshotCpu();
  let prevNet = await readNetBytes();
  await Promise.all([refreshPingIfStale(true), getAdaptersOnce(), refreshProcessesIfStale(prevCpu.cores, true)]);
  await new Promise(r => setTimeout(r, 700));

  let lastOnlineAt = Date.now();

  const tick = async () => {
    writeLock({ startedAt });
    const t = await resolveLiveTarget(950);
    Object.assign(targetRef, t);
    let killedAny = false;
    if (t.online) {
      await ensureCityAndClocksOnPhone(t.base, t);
      if (!appsSyncedOnce && winHostReady) await syncInstalledAppsToPhone(targetRef);
      killedAny = await handlePendingLaptopCommands(t.base, t);
    }

    const hasActiveWatches = (() => {
      try { const w = JSON.parse(latestSettings.laptop_watches || '[]'); return Array.isArray(w) && w.length > 0; } catch (_) { return false; }
    })();
    const currCpu = snapshotCpu();
    const currNet = await readNetBytes();
    const payload = await buildPayload(prevCpu, currCpu, prevNet, currNet, killedAny || hasActiveWatches, targetRef);
    prevCpu = currCpu;
    if (currNet) prevNet = currNet;
    if (hasActiveWatches) await evaluateProcessWatches(targetRef);

    if (t.online) {
      lastOnlineAt = Date.now();
      await httpJson('POST', `${t.base}/api/laptop/telemetry`, payload, t, 1500);
    } else if (Date.now() - lastOnlineAt > 15 * 60 * 1000) {
      cleanupAndExit();
    }
  };
  fastPushFn = () => { if (!running) { running = true; tick().catch(() => {}).finally(() => { running = false; }); } };

  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); } catch (_) {}
    running = false;
  }, 2000);

  const cleanupAndExit = () => {
    alive = false;
    clearInterval(timer);
    try { winHostProc?.kill(); } catch (_) {}
    try {
      if (fs.existsSync(LOCK_PATH)) {
        const cur = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
        if (Number(cur.pid) === process.pid) fs.unlinkSync(LOCK_PATH);
      }
    } catch (_) {}
    process.exit(0);
  };

  process.on('SIGINT', cleanupAndExit);
  process.on('SIGTERM', cleanupAndExit);
  try { await tick(); } catch (_) {}
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF_PATH);
if (invokedDirectly) {
  if (process.argv.includes('--daemon')) {
    runDaemon();
  } else {
    const sample = await collectLaptopTelemetrySample(750);
    const target = await resolveLiveTarget(950);
    let pushed = false;
    if (target.online && !process.argv.includes('--no-push')) {
      const res = await httpJson('POST', `${target.base}/api/laptop/telemetry`, sample, target, 1200);
      pushed = Boolean(res.ok);
    }
    if (process.argv.includes('--push-only')) {
      process.stdout.write(JSON.stringify({ ok: true, online: target.online, pushed, sampledAt: sample.sampledAt }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ online: target.online, pushed, sample }, null, 2) + '\n');
    }
  }
}
