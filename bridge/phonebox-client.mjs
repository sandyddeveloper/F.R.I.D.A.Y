import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execSync } from 'node:child_process';

export const STATE_DIR = path.join(os.homedir(), '.phonebox');
export const CREDS_PATH = path.join(STATE_DIR, 'credentials.json');
export const CACHE_PATH = path.join(STATE_DIR, 'active-target.json');

export function ensureStateDir() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (_) {}
}

export function loadCredentials() {
  try {
    if (fs.existsSync(CREDS_PATH)) {
      return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    }
  } catch (_) {}
  return null;
}

export function saveCredentials(creds) {
  ensureStateDir();
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), 'utf8');
}

export function clearCredentials() {
  try { if (fs.existsSync(CREDS_PATH)) fs.unlinkSync(CREDS_PATH); } catch (_) {}
  try { if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH); } catch (_) {}
}

export function loadConfiguredTarget() {
  const creds = loadCredentials() || {};
  const lanUrl = String(process.env.PHONEBOX_URL || creds.lanUrl || '').replace(/\/$/, '');
  const remoteUrl = String(process.env.PHONEBOX_REMOTE_URL || creds.remoteUrl || '').replace(/\/$/, '');
  const pin = String(process.env.PHONEBOX_PIN || creds.pin || '');
  const token = String(process.env.PHONEBOX_TOKEN || creds.token || '');
  return {
    base: lanUrl || remoteUrl,
    lanUrl,
    remoteUrl,
    pin,
    token,
    deviceId: creds.deviceId || '',
    phoneName: creds.phoneName || ''
  };
}

export function httpRaw(method, fullUrl, buffer, extraHeaders = {}, authOrPin = '', timeoutMs = 1500, tokenOpt = '') {
  return new Promise((resolve) => {
    try {
      const u = new URL(fullUrl);
      const mod = u.protocol === 'https:' ? https : http;
      const headers = { ...extraHeaders };
      if (buffer != null) headers['Content-Length'] = buffer.length;
      if (typeof authOrPin === 'object' && authOrPin !== null) {
        if (authOrPin.pin) headers['X-PhoneBox-Pin'] = authOrPin.pin;
        if (authOrPin.token) headers['X-PhoneBox-Token'] = authOrPin.token;
      } else {
        if (authOrPin) headers['X-PhoneBox-Pin'] = authOrPin;
        if (tokenOpt) headers['X-PhoneBox-Token'] = tokenOpt;
      }

      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
        timeout: timeoutMs
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, timeout: true }); });
      req.on('error', () => resolve({ ok: false }));
      if (buffer != null) req.write(buffer);
      req.end();
    } catch (_) {
      resolve({ ok: false });
    }
  });
}

export function httpJson(method, fullUrl, body, authOrPin = '', timeoutMs = 900, tokenOpt = '') {
  return new Promise((resolve) => {
    try {
      const u = new URL(fullUrl);
      const mod = u.protocol === 'https:' ? https : http;
      const payload = body == null ? null : JSON.stringify(body);
      const headers = {};
      if (payload != null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      if (typeof authOrPin === 'object' && authOrPin !== null) {
        if (authOrPin.pin) headers['X-PhoneBox-Pin'] = authOrPin.pin;
        if (authOrPin.token) headers['X-PhoneBox-Token'] = authOrPin.token;
      } else {
        if (authOrPin) headers['X-PhoneBox-Pin'] = authOrPin;
        if (tokenOpt) headers['X-PhoneBox-Token'] = tokenOpt;
      }

      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
        timeout: timeoutMs
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = JSON.parse(text);
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed });
          } catch (_) {
            resolve({ ok: false, status: res.statusCode, data: null });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, timeout: true }); });
      req.on('error', () => resolve({ ok: false }));
      if (payload != null) req.write(payload);
      req.end();
    } catch (_) {
      resolve({ ok: false });
    }
  });
}

export function isFridayHealth(data) {
  return Boolean(data && (data.app === 'F.R.I.D.A.Y.' || data.app === 'PhoneBox Server' || data.service === 'friday-server'));
}

export async function discoverLanPhones(port = 8765, timeoutMs = 500) {
  const candidates = new Set(['http://127.0.0.1:' + port]);
  try {
    const mdns = execSync('adb mdns services', { timeout: 700, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString('utf8');
    for (const m of mdns.matchAll(/(\d+\.\d+\.\d+\.\d+):\d+/g)) {
      candidates.add(`http://${m[1]}:${port}`);
    }
  } catch (_) {}
  try {
    const arp = execSync('arp -a', { timeout: 600, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString('utf8');
    for (const line of arp.split(/\r?\n/)) {
      if (!/dynamic/i.test(line)) continue;
      const m = line.match(/(\d+\.\d+\.\d+\.\d+)/);
      if (m && !m[1].endsWith('.1') && !m[1].endsWith('.255')) candidates.add(`http://${m[1]}:${port}`);
    }
  } catch (_) {}

  const found = [];
  await Promise.all([...candidates].slice(0, 18).map(async (url) => {
    const r = await httpJson('GET', `${url}/api/health`, null, '', timeoutMs);
    if (r.ok && isFridayHealth(r.data)) {
      found.push({ url, deviceName: r.data.deviceName || 'F.R.I.D.A.Y.', requiresPairing: Boolean(r.data.requiresPairing) });
    }
  }));
  return found;
}

async function pingFirstLive(candidates, auth, timeoutMs) {
  for (const cand of candidates) {
    const r = await httpJson('GET', `${cand}/api/health`, null, auth, timeoutMs);
    if (r.ok && isFridayHealth(r.data)) return cand;
  }
  return '';
}

export async function resolveLiveTarget(timeoutMs = 950) {
  const cfg = loadConfiguredTarget();
  const auth = { pin: cfg.pin, token: cfg.token };
  let cachedUrl = '';
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const c = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      if (c.url) cachedUrl = String(c.url).replace(/\/$/, '');
    }
  } catch (_) {}

  const envUrl = process.env.PHONEBOX_URL ? String(process.env.PHONEBOX_URL).replace(/\/$/, '') : '';
  const localFirst = [...new Set([envUrl, cachedUrl, cfg.lanUrl].filter(u => u && !u.includes('/r/')))];
  let hit = await pingFirstLive(localFirst, auth, timeoutMs);

  // If LAN unreachable, scan neighbors briefly ONLY on same subnet, then fall back to Remote/Relay URL!
  if (!hit && !envUrl && cfg.token) {
    const neighbors = (await discoverLanPhones(8765, 450)).map(x => x.url).filter(u => !localFirst.includes(u));
    if (neighbors.length) hit = await pingFirstLive(neighbors, auth, 500);
  }
  if (!hit && cfg.remoteUrl) {
    hit = await pingFirstLive([cfg.remoteUrl], auth, 2800);
  }

  if (hit) {
    if (hit !== cachedUrl) {
      ensureStateDir();
      try { fs.writeFileSync(CACHE_PATH, JSON.stringify({ url: hit, updatedAt: Date.now() })); } catch (_) {}
    }
    return { base: hit, pin: cfg.pin, token: cfg.token, online: true, isRelay: hit.includes('/r/') };
  }
  return { base: cfg.base, pin: cfg.pin, token: cfg.token, online: false, isRelay: Boolean(cfg.base && cfg.base.includes('/r/')) };
}
