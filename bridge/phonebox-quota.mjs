import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STATE_DIR, ensureStateDir, httpJson, resolveLiveTarget } from './phonebox-client.mjs';

const CACHE_PATH = path.join(STATE_DIR, 'quota-cache.json');
const LOCK_PATH = path.join(STATE_DIR, 'quota-refresh.lock');
const SELF_PATH = fileURLToPath(import.meta.url);
ensureStateDir();

function findAgyBinary() {
  const candidates = [
    path.join(os.homedir(), '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'),
    process.platform === 'win32' ? 'agy.exe' : 'agy'
  ];
  for (const c of candidates) {
    if (!path.isAbsolute(c) || fs.existsSync(c)) return c;
  }
  return '';
}

export function parseUsageOutput(rawStdout) {
  const txt = String(rawStdout || '').trim();
  const idx = txt.indexOf('{');
  if (idx < 0) return null;
  const parsed = JSON.parse(txt.slice(idx));
  const groupsRaw = parsed?.command?.data?.groups;
  if (!Array.isArray(groupsRaw) || !groupsRaw.length) return null;

  const quota = {};
  const quotaGroups = groupsRaw.map(g => {
    const buckets = (g.buckets || []).map(b => {
      const item = {
        id: String(b.id || ''),
        name: String(b.name || ''),
        group: String(g.name || ''),
        window: String(b.window || ''),
        remaining_fraction: typeof b.remaining_fraction === 'number' ? b.remaining_fraction : null,
        reset_time: b.reset_time || '',
        description: String(b.description || '')
      };
      if (item.id) quota[item.id] = item;
      return item;
    });
    return {
      name: String(g.name || ''),
      description: String(g.description || ''),
      buckets
    };
  });

  return { quota, quotaGroups };
}

export function getCachedQuota() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const obj = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      if (obj && obj.quota && typeof obj.fetchedAt === 'number') return obj;
    }
  } catch (_) {}
  return null;
}

export function getDynamicQuota({ force = false, maxAgeMs = 45_000, timeoutMs = 12_000 } = {}) {
  const cached = getCachedQuota();
  if (!force && cached && Date.now() - cached.fetchedAt < maxAgeMs) {
    return Promise.resolve(cached);
  }
  const bin = findAgyBinary();
  if (!bin) return Promise.resolve(cached);

  return new Promise((resolve) => {
    try {
      execFile(bin, ['-p', '/usage', '--output-format', 'json'], {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 512 * 1024
      }, (err, stdout) => {
        if (!err && stdout) {
          try {
            const parsed = parseUsageOutput(stdout);
            if (parsed) {
              const record = {
                fetchedAt: Date.now(),
                quota: parsed.quota,
                quotaGroups: parsed.quotaGroups
              };
              try { fs.writeFileSync(CACHE_PATH, JSON.stringify(record)); } catch (_) {}
              resolve(record);
              return;
            }
          } catch (_) {}
        }
        resolve(cached);
      });
    } catch (_) {
      resolve(cached);
    }
  });
}

export function triggerBackgroundQuotaRefresh(maxAgeMs = 45_000) {
  const cached = getCachedQuota();
  if (cached && Date.now() - cached.fetchedAt < maxAgeMs) return;
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const lockTs = Number(fs.readFileSync(LOCK_PATH, 'utf8') || 0);
      if (Date.now() - lockTs < 20_000) return;
    }
    fs.writeFileSync(LOCK_PATH, String(Date.now()));
    const child = spawn(process.execPath, [SELF_PATH, '--refresh'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  } catch (_) {}
}

if (process.argv.includes('--refresh')) {
  (async () => {
    try {
      const record = await getDynamicQuota({ force: true, timeoutMs: 15_000 });
      if (record?.quota) {
        const target = await resolveLiveTarget(800);
        const { base, online } = target;
        if (online) {
          await httpJson('POST', `${base}/api/agy/status`, {
            quota: record.quota,
            quotaGroups: record.quotaGroups || [],
            quotaFetchedAt: record.fetchedAt
          }, target, 1000);
        }
      }
    } finally {
      try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
    }
  })();
}
