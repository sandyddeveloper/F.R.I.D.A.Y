import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { STATE_DIR, ensureStateDir } from './phonebox-client.mjs';

const PRE_EDIT_DIR = path.join(STATE_DIR, 'pre-edit');
const BASELINES_DIR = path.join(STATE_DIR, 'watch-baselines');
const CODE_STATE_PATH = path.join(STATE_DIR, 'code-state.json');
ensureStateDir();

const EDIT_TOOLS = new Set([
  'edit_file',
  'write_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content'
]);

export const CODE_EXTS = new Set([
  '.kt', '.java', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.css', '.html', '.xml', '.json', '.md', '.kts', '.gradle',
  '.py', '.go', '.rs', '.sql', '.sh', '.yaml', '.yml'
]);

export const IGNORE_DIRS = new Set(['.git', 'build', '.gradle', 'node_modules', '.idea', 'captures', '.cxx', 'dist', '.pre-edit', '.watch-baselines']);

function fileHash(p) {
  return crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 16);
}

function toRel(workspace, filePath) {
  if (!workspace) return String(filePath).replace(/\\/g, '/');
  try {
    const rel = path.relative(path.resolve(workspace), path.resolve(filePath));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
  } catch (_) {}
  return String(filePath).replace(/\\/g, '/');
}

export function isEditTool(name) {
  return EDIT_TOOLS.has(String(name || ''));
}

export function getToolTargetPath(toolCall) {
  const args = toolCall?.args || {};
  return args.TargetFile || args.AbsolutePath || args.Path || '';
}

export function readLiveCodePreview(absPath, maxLines = 180) {
  try {
    if (!fs.existsSync(absPath)) return { code: '', totalLines: 0 };
    const st = fs.statSync(absPath);
    if (st.size > 240_000) return { code: '', totalLines: 0 };
    const raw = fs.readFileSync(absPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const totalLines = lines.length;
    const clipped = lines.slice(0, maxLines);
    const body = clipped.join('\n') + (totalLines > maxLines ? `\n// ... (${totalLines - maxLines} more lines)` : '');
    return { code: body.slice(0, 10_000), totalLines };
  } catch (_) {
    return { code: '', totalLines: 0 };
  }
}

export function capturePreEditSnapshot(toolCall) {
  if (!isEditTool(toolCall?.name)) return;
  const target = getToolTargetPath(toolCall);
  if (!target) return;
  try {
    fs.mkdirSync(PRE_EDIT_DIR, { recursive: true });
    const abs = path.resolve(target);
    const snapFile = path.join(PRE_EDIT_DIR, `${fileHash(abs)}.snap`);
    if (fs.existsSync(abs)) {
      const st = fs.statSync(abs);
      if (st.size <= 180_000) {
        fs.writeFileSync(snapFile, fs.readFileSync(abs, 'utf8'), 'utf8');
      }
    } else {
      fs.writeFileSync(snapFile, '', 'utf8');
    }
  } catch (_) {}
}

export function seedWatchBaselines(workspace, limit = 180) {
  if (!workspace || !fs.existsSync(workspace)) return;
  try { fs.mkdirSync(BASELINES_DIR, { recursive: true }); } catch (_) { return; }
  let seeded = 0;
  const walk = (dir, depth = 0) => {
    if (depth > 7 || seeded >= limit) return;
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of list) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() && CODE_EXTS.has(path.extname(ent.name).toLowerCase())) {
        try {
          const st = fs.statSync(full);
          if (st.size <= 160_000) {
            const baseFile = path.join(BASELINES_DIR, `${fileHash(full)}.base`);
            if (!fs.existsSync(baseFile)) {
              fs.writeFileSync(baseFile, fs.readFileSync(full, 'utf8'), 'utf8');
            }
            seeded++;
          }
        } catch (_) {}
      }
    }
  };
  walk(workspace, 0);
}

export function computeLineDiff(oldText, newText, relPath, maxOutputLines = 160) {
  const a = String(oldText || '').split(/\r?\n/);
  const b = String(newText || '').split(/\r?\n/);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);

  const ops = [];
  if (midA.length * midB.length <= 160_000) {
    const n = midA.length, m = midB.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j]
          ? 1 + dp[i + 1][j + 1]
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ t: ' ', l: midA[i] });
        i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ t: '-', l: midA[i++] });
      } else {
        ops.push({ t: '+', l: midB[j++] });
      }
    }
    while (i < n) ops.push({ t: '-', l: midA[i++] });
    while (j < m) ops.push({ t: '+', l: midB[j++] });
  } else {
    for (const l of midA.slice(0, 70)) ops.push({ t: '-', l });
    for (const l of midB.slice(0, 70)) ops.push({ t: '+', l });
  }

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.t === '+') added++;
    else if (op.t === '-') removed++;
  }

  const ctxBefore = a.slice(Math.max(0, start - 3), start).map(l => ` ${l}`);
  const ctxAfter = a.slice(endA + 1, Math.min(a.length, endA + 4)).map(l => ` ${l}`);
  const hunkStartA = Math.max(1, start - ctxBefore.length + 1);
  const hunkStartB = Math.max(1, start - ctxBefore.length + 1);
  const hunkLenA = ctxBefore.length + midA.length + ctxAfter.length;
  const hunkLenB = ctxBefore.length + midB.length + ctxAfter.length;

  const lines = [
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    `@@ -${hunkStartA},${hunkLenA} +${hunkStartB},${hunkLenB} @@`,
    ...ctxBefore,
    ...ops.map(o => `${o.t}${o.l}`),
    ...ctxAfter
  ];

  const clipped = lines.length > maxOutputLines
    ? [...lines.slice(0, maxOutputLines), `... (${lines.length - maxOutputLines} more lines truncated)`]
    : lines;

  return { added, removed, diff: clipped.join('\n') };
}

function collectGitCode(workspace) {
  try {
    const gitDir = path.join(workspace, '.git');
    if (!fs.existsSync(gitDir)) return null;
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: workspace, timeout: 500, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString('utf8').trim() || 'HEAD';
    const raw = execSync('git status --porcelain=v1', { cwd: workspace, timeout: 700, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString('utf8');
    const entries = raw.split(/\r?\n/).filter(Boolean).slice(0, 20);
    const files = [];
    let totalAdded = 0, totalRemoved = 0;

    for (const line of entries) {
      const code = line.slice(0, 2).trim() || 'M';
      const rel = line.slice(3).trim().replace(/^"|"$/g, '');
      if (!rel) continue;
      const abs = path.join(workspace, rel);
      let diff = '';
      let added = 0, removed = 0;
      if (code === '??') {
        try {
          const txt = fs.readFileSync(abs, 'utf8');
          const dLines = txt.split(/\r?\n/).slice(0, 110);
          added = dLines.length;
          diff = `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${added} @@\n` + dLines.map(l => `+${l}`).join('\n');
        } catch (_) {}
      } else {
        try {
          diff = execSync(`git diff HEAD -U3 -- "${rel.replace(/"/g, '')}"`, { cwd: workspace, timeout: 700, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString('utf8');
          for (const dl of diff.split(/\r?\n/)) {
            if (dl.startsWith('+') && !dl.startsWith('+++')) added++;
            else if (dl.startsWith('-') && !dl.startsWith('---')) removed++;
          }
          const clipped = diff.split(/\r?\n/);
          if (clipped.length > 150) diff = clipped.slice(0, 150).join('\n') + `\n... (${clipped.length - 150} more lines)`;
        } catch (_) {}
      }
      const { code: liveCode, totalLines } = readLiveCodePreview(abs, 160);
      totalAdded += added;
      totalRemoved += removed;
      files.push({ path: rel.replace(/\\/g, '/'), status: code, tool: 'git', added, removed, diff, code: liveCode, totalLines, updatedAt: Date.now() });
    }
    return {
      workspace,
      workspaceName: path.basename(workspace),
      mode: 'git',
      branch,
      totalFiles: files.length,
      totalAdded,
      totalRemoved,
      files
    };
  } catch (_) {
    return null;
  }
}

function loadLiveState() {
  try {
    if (fs.existsSync(CODE_STATE_PATH)) {
      const obj = JSON.parse(fs.readFileSync(CODE_STATE_PATH, 'utf8'));
      if (obj && Array.isArray(obj.files)) return obj;
    }
  } catch (_) {}
  return { workspace: '', files: [] };
}

function saveLiveState(st) {
  try {
    fs.writeFileSync(CODE_STATE_PATH, JSON.stringify({
      workspace: st.workspace || '',
      files: (st.files || []).slice(0, 18)
    }));
  } catch (_) {}
}

function scanRecentWorkspaceFiles(workspace, limit = 8, maxAgeMs = 4 * 3600 * 1000) {
  const out = [];
  const cutoff = Date.now() - maxAgeMs;
  const walk = (dir, depth = 0) => {
    if (depth > 7 || out.length > 60) return;
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of list) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        if (!CODE_EXTS.has(path.extname(ent.name).toLowerCase())) continue;
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= cutoff && st.size <= 200_000) out.push({ full, mtime: st.mtimeMs });
        } catch (_) {}
      }
    }
  };
  walk(workspace, 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit).map(x => {
    const rel = toRel(workspace, x.full);
    const { code: liveCode, totalLines } = readLiveCodePreview(x.full, 140);
    const slice = liveCode.split(/\r?\n/).slice(0, 100);
    const preview = `--- b/${rel} (recent edit · ${totalLines} lines)\n+++ b/${rel}\n@@ -1,${slice.length} +1,${slice.length} @@\n` + slice.map(l => ` ${l}`).join('\n');
    return { path: rel, status: 'M', tool: 'workspace', added: 0, removed: 0, diff: preview, code: liveCode, totalLines, updatedAt: Math.round(x.mtime) };
  });
}

function buildFallbackToolDiff(toolCall, rel) {
  const args = toolCall?.args || {};
  const chunks = [];
  if (args.Target !== undefined || args.Replacement !== undefined) {
    chunks.push({ old: args.Target || '', next: args.Replacement || '' });
  } else if (args.TargetContent !== undefined || args.ReplacementContent !== undefined) {
    chunks.push({ old: args.TargetContent || '', next: args.ReplacementContent || '' });
  } else if (Array.isArray(args.ReplacementChunks)) {
    for (const c of args.ReplacementChunks) chunks.push({ old: c.TargetContent || '', next: c.ReplacementContent || '' });
  } else if (args.CodeContent || args.Content) {
    return computeLineDiff('', args.CodeContent || args.Content || '', rel);
  }
  if (!chunks.length) return { added: 0, removed: 0, diff: '' };
  let added = 0, removed = 0;
  const out = [`--- a/${rel}`, `+++ b/${rel}`];
  for (const ch of chunks) {
    const oLines = String(ch.old).split(/\r?\n/);
    const nLines = String(ch.next).split(/\r?\n/);
    out.push(`@@ -1,${oLines.length} +1,${nLines.length} @@`);
    for (const l of oLines) { if (l !== '' || oLines.length === 1) { out.push(`-${l}`); removed++; } }
    for (const l of nLines) { if (l !== '' || nLines.length === 1) { out.push(`+${l}`); added++; } }
  }
  return { added, removed, diff: out.slice(0, 160).join('\n') };
}

export function syncWatchedFile(workspace, absPath, toolLabel = 'live-save') {
  const ws = workspace ? path.resolve(workspace) : '';
  if (ws) {
    const gitResult = collectGitCode(ws);
    if (gitResult) return gitResult;
  }
  const st = loadLiveState();
  if (ws) st.workspace = ws;

  const abs = path.resolve(absPath);
  const rel = toRel(ws || st.workspace, abs);
  const baseFile = path.join(BASELINES_DIR, `${fileHash(abs)}.base`);
  const { code: liveCode, totalLines } = readLiveCodePreview(abs, 160);

  if (fs.existsSync(abs)) {
    const newText = fs.readFileSync(abs, 'utf8');
    let diffInfo = null;
    let status = 'M';
    if (fs.existsSync(baseFile)) {
      const oldText = fs.readFileSync(baseFile, 'utf8');
      if (oldText === newText) return recordEditAndCollectCode(ws, null, false);
      diffInfo = computeLineDiff(oldText, newText, rel);
    } else {
      status = 'A';
      diffInfo = computeLineDiff('', newText, rel);
      try { fs.mkdirSync(BASELINES_DIR, { recursive: true }); fs.writeFileSync(baseFile, newText, 'utf8'); } catch (_) {}
    }
    if (diffInfo?.diff) {
      const entry = {
        path: rel,
        status,
        tool: toolLabel,
        added: diffInfo.added,
        removed: diffInfo.removed,
        diff: diffInfo.diff,
        code: liveCode,
        totalLines,
        updatedAt: Date.now()
      };
      st.files = [entry, ...(st.files || []).filter(f => f.path.toLowerCase() !== rel.toLowerCase())].slice(0, 18);
      saveLiveState(st);
    }
  }
  return recordEditAndCollectCode(ws, null, false);
}

export function recordEditAndCollectCode(workspace, toolCall = null, isPost = false) {
  const ws = workspace ? path.resolve(workspace) : '';
  if (ws) {
    const gitResult = collectGitCode(ws);
    if (gitResult) return gitResult;
  }

  const st = loadLiveState();
  if (ws && st.workspace && st.workspace.toLowerCase() !== ws.toLowerCase()) st.files = [];
  if (ws) st.workspace = ws;

  if (isPost && toolCall && isEditTool(toolCall.name)) {
    const target = getToolTargetPath(toolCall);
    if (target) {
      const abs = path.resolve(target);
      const rel = toRel(ws || st.workspace, abs);
      const snapFile = path.join(PRE_EDIT_DIR, `${fileHash(abs)}.snap`);
      const { code: liveCode, totalLines } = readLiveCodePreview(abs, 160);
      let diffInfo = null;
      let status = 'M';
      try {
        if (fs.existsSync(snapFile) && fs.existsSync(abs)) {
          const oldText = fs.readFileSync(snapFile, 'utf8');
          const newText = fs.readFileSync(abs, 'utf8');
          if (!oldText && newText) status = 'A';
          diffInfo = computeLineDiff(oldText, newText, rel);
          fs.unlinkSync(snapFile);
        }
      } catch (_) {}
      if (!diffInfo || (!diffInfo.diff && (diffInfo.added + diffInfo.removed === 0))) {
        diffInfo = buildFallbackToolDiff(toolCall, rel);
      }
      if (diffInfo && diffInfo.diff) {
        const entry = {
          path: rel,
          status,
          tool: toolCall.name,
          added: diffInfo.added,
          removed: diffInfo.removed,
          diff: diffInfo.diff,
          code: liveCode,
          totalLines,
          updatedAt: Date.now()
        };
        st.files = [entry, ...(st.files || []).filter(f => f.path.toLowerCase() !== rel.toLowerCase())].slice(0, 18);
        saveLiveState(st);
      }
    }
  }

  // Hydrate missing live code snippets on any existing tracked entries
  let files = (st.files || []).map(f => {
    if (f.code) return f;
    const candidateAbs = path.isAbsolute(f.path) ? f.path : (ws ? path.join(ws, f.path) : '');
    const { code: liveCode, totalLines } = candidateAbs ? readLiveCodePreview(candidateAbs, 160) : { code: '', totalLines: 0 };
    return liveCode ? { ...f, code: liveCode, totalLines } : f;
  });

  if (ws && files.length < 6) {
    const seen = new Set(files.map(f => f.path.toLowerCase()));
    for (const rf of scanRecentWorkspaceFiles(ws, 8 - files.length)) {
      if (!seen.has(rf.path.toLowerCase())) {
        seen.add(rf.path.toLowerCase());
        files.push(rf);
      }
    }
  }

  let totalAdded = 0, totalRemoved = 0;
  for (const f of files) {
    totalAdded += Number(f.added || 0);
    totalRemoved += Number(f.removed || 0);
  }
  return {
    workspace: ws || st.workspace || '',
    workspaceName: path.basename(ws || st.workspace || 'workspace'),
    mode: 'live',
    branch: 'live-watch',
    totalFiles: files.length,
    totalAdded,
    totalRemoved,
    files: files.slice(0, 14)
  };
}
