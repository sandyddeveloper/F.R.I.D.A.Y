import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STATE_DIR, ensureStateDir, httpJson, resolveLiveTarget } from './phonebox-client.mjs';
import { CODE_EXTS, IGNORE_DIRS, recordEditAndCollectCode, seedWatchBaselines, syncWatchedFile } from './phonebox-code.mjs';

const LOCK_PATH = path.join(STATE_DIR, 'watch.lock');
const SELF_PATH = fileURLToPath(import.meta.url);
ensureStateDir();

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

export function triggerCodeWatcher(workspace) {
  if (!workspace || !fs.existsSync(workspace)) return;
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      const sameWs = lock.workspace && path.resolve(lock.workspace).toLowerCase() === path.resolve(workspace).toLowerCase();
      if (sameWs && isPidAlive(Number(lock.pid)) && Date.now() - Number(lock.heartbeat || lock.startedAt || 0) < 120_000) {
        return;
      }
    }
    const child = spawn(process.execPath, [SELF_PATH, '--watch', path.resolve(workspace)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  } catch (_) {}
}

function shouldWatchPath(relOrName) {
  const norm = String(relOrName || '').replace(/\\/g, '/');
  if (!norm) return false;
  const parts = norm.split('/');
  if (parts.some(p => IGNORE_DIRS.has(p))) return false;
  if (parts.some(p => p.startsWith('.') && p !== '.agents')) return false;
  const ext = path.extname(norm).toLowerCase();
  return CODE_EXTS.has(ext);
}

async function runWatchDaemon(workspace) {
  const ws = path.resolve(workspace);
  const writeLock = () => {
    try { fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, workspace: ws, heartbeat: Date.now() })); } catch (_) {}
  };
  writeLock();
  seedWatchBaselines(ws, 180);

  let lastActivity = Date.now();
  let lastSyncHandled = 0;
  let lastPushFile = '';
  const timers = new Map();

  const pushSummary = async (summary) => {
    const target = await resolveLiveTarget(600);
    if (target.online && summary) {
      await httpJson('POST', `${target.base}/api/agy/code`, summary, target, 900);
    }
  };

  await pushSummary(recordEditAndCollectCode(ws, null, false));

  let watcher = null;
  try {
    watcher = fs.watch(ws, { recursive: true }, (_eventType, filename) => {
      if (!filename || !shouldWatchPath(filename)) return;
      const abs = path.join(ws, String(filename));
      clearTimeout(timers.get(abs));
      timers.set(abs, setTimeout(async () => {
        timers.delete(abs);
        if (!fs.existsSync(abs)) return;
        lastActivity = Date.now();
        lastPushFile = abs;
        const summary = syncWatchedFile(ws, abs, 'live-save');
        await pushSummary(summary);
      }, 280));
    });
  } catch (_) {
    process.exit(0);
  }

  const pollTimer = setInterval(async () => {
    writeLock();
    if (Date.now() - lastActivity > 45 * 60 * 1000) {
      clearInterval(pollTimer);
      try { watcher?.close(); } catch (_) {}
      try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
      process.exit(0);
    }
    try {
      const target = await resolveLiveTarget(450);
      if (!target.online) return;
      const res = await httpJson('GET', `${target.base}/api/agy/code`, null, target, 500);
      const reqAt = Number(res.data?.syncRequestedAt || 0);
      if (reqAt > lastSyncHandled) {
        lastSyncHandled = reqAt;
        lastActivity = Date.now();
        const summary = lastPushFile && fs.existsSync(lastPushFile)
          ? syncWatchedFile(ws, lastPushFile, 'sync')
          : recordEditAndCollectCode(ws, null, false);
        await pushSummary(summary);
      }
    } catch (_) {}
  }, 1500);
}

const wIdx = process.argv.indexOf('--watch');
if (wIdx >= 0 && process.argv[wIdx + 1]) {
  runWatchDaemon(process.argv[wIdx + 1]).catch(() => process.exit(1));
}
