import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
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

function extractRelayParts(fullUrl) {
  const m = String(fullUrl || '').match(/^(https?:\/\/[^/]+\/r\/[A-Za-z0-9_-]+)(\/.*)?$/);
  if (!m) return null;
  return { root: m[1], subPath: m[2] || '/' };
}

function deriveE2eKey(token) {
  return crypto.createHash('sha256').update(`friday-e2e:${token}`).digest();
}

function shouldUseE2e(fullUrl, authObj) {
  if (!authObj?.token || !authObj?.deviceId) return false;
  const parts = extractRelayParts(fullUrl);
  if (!parts) return false;
  if (parts.subPath.startsWith('/api/health') || parts.subPath.startsWith('/api/pair/')) return false;
  return true;
}

async function sendE2eRequest(method, fullUrl, bodyBuf, extraHeaders, authObj, timeoutMs) {
  const parts = extractRelayParts(fullUrl);
  const key = deriveE2eKey(authObj.token);
  const iv = crypto.randomBytes(12);
  const innerPayload = JSON.stringify({
    method,
    path: parts.subPath,
    headers: extraHeaders || {},
    bodyB64: bodyBuf && bodyBuf.length ? bodyBuf.toString('base64') : ''
  });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(innerPayload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const outerRes = await httpRawDirect(
    'POST',
    `${parts.root}/_e2e`,
    Buffer.from(JSON.stringify({
      deviceId: authObj.deviceId,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ct: ct.toString('base64')
    }), 'utf8'),
    { 'Content-Type': 'application/json' },
    timeoutMs
  );
  if (!outerRes.ok) return { ok: false, status: outerRes.status, text: outerRes.text };
  try {
    const env = JSON.parse(outerRes.text);
    const dec = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
    dec.setAuthTag(Buffer.from(env.tag, 'base64'));
    const plain = Buffer.concat([dec.update(Buffer.from(env.ct, 'base64')), dec.final()]).toString('utf8');
    const inner = JSON.parse(plain);
    const rawBuf = inner.bodyB64 ? Buffer.from(inner.bodyB64, 'base64') : Buffer.alloc(0);
    const bodyText = rawBuf.toString('utf8');
    const status = Number(inner.status || 200);
    return { ok: status >= 200 && status < 300, status, buffer: rawBuf, text: bodyText };
  } catch (_) {
    return { ok: false, status: 500, buffer: Buffer.alloc(0), text: '' };
  }
}

function httpRawDirect(method, fullUrl, buffer, extraHeaders = {}, timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      const u = new URL(fullUrl);
      const mod = u.protocol === 'https:' ? https : http;
      const headers = { ...extraHeaders };
      if (buffer != null) headers['Content-Length'] = buffer.length;
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
          const rawBuf = Buffer.concat(chunks);
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, buffer: rawBuf, text: rawBuf.toString('utf8') });
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, timeout: true, buffer: Buffer.alloc(0), text: '' }); });
      req.on('error', () => resolve({ ok: false, buffer: Buffer.alloc(0), text: '' }));
      if (buffer != null) req.write(buffer);
      req.end();
    } catch (_) {
      resolve({ ok: false, buffer: Buffer.alloc(0), text: '' });
    }
  });
}

export async function httpRawBuffer(method, fullUrl, buffer, extraHeaders = {}, authOrPin = '', timeoutMs = 1500, tokenOpt = '') {
  const authObj = typeof authOrPin === 'object' && authOrPin !== null
    ? authOrPin
    : { pin: authOrPin, token: tokenOpt, deviceId: loadConfiguredTarget().deviceId };
  if (!authObj.deviceId && authObj.token) authObj.deviceId = loadConfiguredTarget().deviceId;
  if (shouldUseE2e(fullUrl, authObj)) {
    return sendE2eRequest(method, fullUrl, buffer, extraHeaders, authObj, timeoutMs);
  }
  const headers = { ...extraHeaders };
  if (authObj.pin) headers['X-PhoneBox-Pin'] = authObj.pin;
  if (authObj.token) headers['X-PhoneBox-Token'] = authObj.token;
  return httpRawDirect(method, fullUrl, buffer, headers, timeoutMs);
}

export async function httpRaw(method, fullUrl, buffer, extraHeaders = {}, authOrPin = '', timeoutMs = 1500, tokenOpt = '') {
  const r = await httpRawBuffer(method, fullUrl, buffer, extraHeaders, authOrPin, timeoutMs, tokenOpt);
  return { ok: r.ok, status: r.status, timeout: r.timeout, text: r.text };
}

export async function httpJson(method, fullUrl, body, authOrPin = '', timeoutMs = 900, tokenOpt = '') {
  const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const headers = payload != null ? { 'Content-Type': 'application/json' } : {};
  const r = await httpRaw(method, fullUrl, payload, headers, authOrPin, timeoutMs, tokenOpt);
  if (!r.text) return { ok: r.ok, status: r.status, timeout: r.timeout, data: null };
  try {
    return { ok: r.ok, status: r.status, data: JSON.parse(r.text) };
  } catch (_) {
    return { ok: false, status: r.status, data: null };
  }
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
    return { base: hit, pin: cfg.pin, token: cfg.token, deviceId: cfg.deviceId, online: true, isRelay: hit.includes('/r/') };
  }
  return { base: cfg.base, pin: cfg.pin, token: cfg.token, deviceId: cfg.deviceId, online: false, isRelay: Boolean(cfg.base && cfg.base.includes('/r/')) };
}
