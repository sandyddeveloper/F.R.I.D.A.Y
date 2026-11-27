import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { httpJson, resolveLiveTarget } from './phonebox-client.mjs';
import { capturePreEditSnapshot, isEditTool, recordEditAndCollectCode } from './phonebox-code.mjs';
import { getCachedQuota, getDynamicQuota, triggerBackgroundQuotaRefresh } from './phonebox-quota.mjs';
import { triggerCodeWatcher } from './phonebox-watch.mjs';
import { triggerTelemetryStream } from './phonebox-telemetry.mjs';

const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

function inferContextLimit(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('claude')) return 200000;
  if (m.includes('gpt')) return 256000;
  return 1048576;
}

function parseTranscriptStats(activeTranscriptPath, fallbackModel, convId = '') {
  const now = Date.now();
  const win5h = now - 5 * 3600 * 1000;
  const win7d = now - 7 * 86400 * 1000;

  let sessionIn = 0, sessionOut = 0, sessionCached = 0;
  let lastCtx = 0, lastModel = fallbackModel || '', lastPromptFound = '';
  let window5hTokens = 0, window5hSessions = 0, oldest5hTs = 0;
  let weeklyTokens = 0, weeklyTurns = 0;

  const files = [];
  let activeResolved = activeTranscriptPath ? path.resolve(activeTranscriptPath.replace(/^~/, os.homedir())).toLowerCase() : '';
  try {
    if (fs.existsSync(BRAIN_DIR)) {
      for (const dir of fs.readdirSync(BRAIN_DIR)) {
        const logFile = path.join(BRAIN_DIR, dir, '.system_generated', 'logs', 'transcript.jsonl');
        try {
          const st = fs.statSync(logFile);
          if (st.mtimeMs >= win7d) files.push({ path: logFile, mtime: st.mtimeMs });
        } catch (_) {}
      }
    }
  } catch (_) {}

  files.sort((a, b) => b.mtime - a.mtime);
  const inList = activeResolved && files.some(f => path.resolve(f.path).toLowerCase() === activeResolved);
  if (activeResolved && !inList) {
    try {
      if (fs.existsSync(activeResolved) && fs.statSync(activeResolved).size > 0) {
        files.unshift({ path: activeResolved, mtime: Date.now() });
      } else {
        activeResolved = '';
      }
    } catch (_) {
      activeResolved = '';
    }
  }
  if (!activeResolved && convId) {
    const m = files.find(f => f.path.toLowerCase().includes(convId.toLowerCase()));
    if (m) activeResolved = path.resolve(m.path).toLowerCase();
  }
  if (!activeResolved && files.length) activeResolved = path.resolve(files[0].path).toLowerCase();

  let latestPlannerTs = 0;
  for (const f of files.slice(0, 60)) {
    let raw = '';
    try { raw = fs.readFileSync(f.path, 'utf8'); } catch (_) { continue; }
    const isActive = path.resolve(f.path).toLowerCase() === activeResolved;
    let had5hInFile = false;
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      if (isActive && line.includes('"USER_INPUT"')) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'USER_INPUT' && ev.content) lastPromptFound = String(ev.content).replace(/\s+/g, ' ').slice(0, 120);
        } catch (_) {}
      }
      if (!line.includes('"PLANNER_RESPONSE"')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (obj.type !== 'PLANNER_RESPONSE') continue;
      const ts = Date.parse(obj.created_at || '') || f.mtime;
      const iTok = Number(obj.input_tokens || 0);
      const oTok = Number(obj.output_tokens || 0);
      const cTok = Number(obj.cache_read_tokens || 0);
      const turnTotal = iTok + oTok + cTok;
      if (ts >= win7d) {
        weeklyTokens += turnTotal;
        weeklyTurns++;
      }
      if (ts >= win5h) {
        window5hTokens += turnTotal;
        had5hInFile = true;
        if (!oldest5hTs || ts < oldest5hTs) oldest5hTs = ts;
      }
      if (isActive) {
        sessionIn += iTok;
        sessionOut += oTok;
        sessionCached += cTok;
        lastCtx = iTok + cTok;
        if (obj.model) lastModel = obj.model;
      } else if (!activeTranscriptPath && ts > latestPlannerTs && obj.model) {
        latestPlannerTs = ts;
        lastModel = obj.model;
      }
    }
    if (had5hInFile) window5hSessions++;
  }

  return {
    model: lastModel || 'Antigravity',
    contextTokens: lastCtx,
    contextLimit: inferContextLimit(lastModel),
    sessionIn,
    sessionOut,
    sessionCached,
    window5hTokens,
    window5hSessions,
    window5hResetInSec: oldest5hTs > 0 ? Math.max(0, Math.floor((oldest5hTs + 5 * 3600 * 1000 - now) / 1000)) : 0,
    weeklyTokens,
    weeklyTurns,
    lastPromptFound
  };
}

function summarizeTool(toolCall) {
  const name = toolCall?.name || 'tool';
  const args = toolCall?.args || {};

  const rawQs = Array.isArray(args.questions)
    ? args.questions
    : (Array.isArray(args.Questions)
        ? args.Questions
        : (Array.isArray(args.options || args.choices)
            ? [{ question: args.question || args.prompt || `Select option for ${name}`, options: args.options || args.choices, is_multi_select: Boolean(args.is_multi_select ?? args.isMultiSelect) }]
            : null));
  if (name === 'ask_question' || (rawQs && rawQs.length > 0)) {
    const qs = rawQs || [];
    const target = qs.map((q, i) => `Q${i + 1}: ${String(q?.question || '')}`).join(' | ').slice(0, 220) || 'Select choice';
    const detail = qs.map((q, i) => {
      const opts = Array.isArray(q?.options) ? q.options.map(o => typeof o === 'string' ? o : (o?.label || o?.value || '')) : [];
      return `${i + 1}. ${q?.question || 'Question'}\n${opts.map(o => `  - ${o}`).join('\n')}`;
    }).join('\n\n').slice(0, 2200);
    return { kind: 'choice', target, detail, payload: { questions: qs } };
  }

  if ((name === 'write_to_file' || name === 'write_file') && args?.ArtifactMetadata?.RequestFeedback) {
    const target = String(args.TargetFile || args.Path || 'artifact');
    const summary = String(args.ArtifactMetadata?.Summary || args.Description || '');
    return {
      kind: 'plan_review',
      target: target.slice(0, 220),
      detail: `[Plan / Artifact Review]\n${target}\n\n${summary}`.slice(0, 2200),
      payload: { targetFile: target, requestFeedback: true }
    };
  }

  const queryText = args.query || args.Query || args.sql || args.Sql || args.kql || args.Kql || '';
  if (queryText || /query|sql|kusto|graphql|select/i.test(name)) {
    const qBody = queryText ? String(queryText) : JSON.stringify(args, null, 2);
    return {
      kind: 'query',
      target: `Execute Query (${name})`.slice(0, 220),
      detail: `${name}\n${qBody}`.slice(0, 2200),
      payload: {}
    };
  }

  if (/^(schedule|manage_task|invoke_subagent|send_message|run_workflow|browser_subagent)$/.test(name) || /trigger|webhook|deploy|publish|submit|workflow/i.test(name)) {
    const summary = args.Prompt || args.Description || args.Action || args.CronExpression || args.DurationSeconds || args.Recipient || JSON.stringify(args);
    return {
      kind: 'trigger',
      target: `Trigger: ${name}`.slice(0, 220),
      detail: `${name}: ${typeof summary === 'string' ? summary : JSON.stringify(summary)}`.slice(0, 2200),
      payload: {}
    };
  }

  if (args.CommandLine) {
    const cmd = String(args.CommandLine);
    const cwd = args.Cwd ? ` (in ${args.Cwd})` : '';
    const isQueryCmd = /\b(psql|mysql|sqlite3|sqlcmd|mongosh|bq)\b/i.test(cmd);
    const isTrigCmd = /\b(curl|invoke-restmethod|invoke-webrequest|gh\s+workflow|az\s+|firebase\s+deploy|npm\s+publish)\b/i.test(cmd);
    const kind = isQueryCmd ? 'query' : (isTrigCmd ? 'trigger' : 'approval');
    return { kind, target: kind === 'approval' ? 'command' : `${kind}: command`, detail: `${cmd}${cwd}`.slice(0, 2200), payload: {} };
  }
  const filePath = args.TargetFile || args.AbsolutePath || args.Path || '';
  if (filePath) {
    const desc = args.Description || args.Instruction || '';
    const detail = desc ? `${name}: ${filePath}\n${desc}` : `${name}: ${filePath}`;
    return { kind: 'approval', target: String(filePath).slice(0, 220), detail: detail.slice(0, 2200), payload: {} };
  }
  if (args.Url) {
    return { kind: 'approval', target: String(args.Url).slice(0, 220), detail: `${name}: ${args.Url}`, payload: {} };
  }
  return { kind: 'approval', target: name, detail: JSON.stringify(args).slice(0, 1200), payload: {} };
}

function buildPermissionOverrides(toolCall) {
  const name = toolCall?.name || '';
  const args = toolCall?.args || {};
  if (name === 'run_command' && args.CommandLine) {
    const first = String(args.CommandLine).trim().split(/\s+/)[0] || '';
    if (first && /^[a-zA-Z0-9._:/\\-]+$/.test(first)) return [`command(${first})`];
  }
  if (name.startsWith('mcp__')) {
    const parts = name.slice(5).split('__');
    if (parts.length >= 2) return [`mcp(${parts[0]}/${parts.slice(1).join('__')})`];
  }
  const fp = args.TargetFile || args.AbsolutePath || args.Path || '';
  if (fp) {
    const act = /view|read/.test(name) ? 'read_file' : (/write|replace|edit/.test(name) ? 'write_file' : '');
    if (act) return [`${act}(${String(fp).replace(/\\/g, '/')})`];
  }
  if (args.Url) {
    try {
      const host = new URL(String(args.Url)).hostname;
      if (host) return [`${name.includes('read') ? 'read_url' : 'execute_url'}(${host})`];
    } catch (_) {}
  }
  return [];
}

function formatMobileChoiceReason(answers = []) {
  const lines = answers.map((a, idx) => {
    const sel = Array.isArray(a?.selected) ? a.selected.filter(Boolean) : [];
    const custom = a?.customText ? String(a.customText).trim() : '';
    const combined = [...sel, ...(custom ? [`Custom: ${custom}`] : [])].join(', ') || '(no option selected)';
    return `${idx + 1}. Question: ${a?.question || 'Question'}\n   Submitted Choice: ${combined}`;
  }).join('\n');
  return `[PHONEBOX_MOBILE_CHOICE_SUBMITTED]\nUser already selected and submitted the choice(s) via PhoneBox Mobile. Do NOT re-ask on laptop; proceed immediately using these answers:\n${lines}`;
}

async function main() {
  const idx = process.argv.indexOf('--event');
  const event = idx >= 0 ? process.argv[idx + 1] : (process.argv.includes('--sync-only') ? 'SyncOnly' : 'PostInvocation');

  let stdinRaw = '';
  if (event !== 'SyncOnly' && !process.stdin.isTTY) {
    stdinRaw = await new Promise((resolve) => {
      const chunks = [];
      process.stdin.on('data', c => chunks.push(c));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 300);
    });
  }

  let payload = {};
  try { if (stdinRaw.trim()) payload = JSON.parse(stdinRaw); } catch (_) {}

  const target = await resolveLiveTarget(450);
  const { base, online } = target;
  const pin = target;
  const stats = parseTranscriptStats(payload.transcriptPath || '', payload.modelName || '', payload.conversationId || '');
  let quotaData = getCachedQuota();
  if (event === 'SyncOnly') {
    quotaData = await getDynamicQuota({ force: true, timeoutMs: 12_000 });
  } else if (online) {
    triggerBackgroundQuotaRefresh(45_000);
  }
  const agentState = event === 'Stop' ? 'idle' : (event === 'PreToolUse' ? 'tool_use' : 'working');
  const toolInfo = payload.toolCall ? summarizeTool(payload.toolCall) : null;

  const statusBody = {
    source: 'app',
    planTier: 'App',
    agentState,
    conversationId: payload.conversationId || '',
    stepIdx: Number(payload.stepIdx || payload.initialNumSteps || 0),
    ...stats,
    ...(quotaData?.quota ? { quota: quotaData.quota, quotaGroups: quotaData.quotaGroups || [], quotaFetchedAt: quotaData.fetchedAt } : {})
  };
  const ws = Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]
    ? String(payload.workspacePaths[0])
    : (payload.cwd || (event === 'SyncOnly' ? process.cwd() : ''));
  const lp = String(payload.lastUserInput || stats.lastPromptFound || '').slice(0, 140);
  if (ws) statusBody.workspace = ws;
  if (lp) statusBody.lastPrompt = lp;
  if (payload.toolCall?.name) statusBody.lastToolName = payload.toolCall.name;
  if (toolInfo) statusBody.lastToolDetail = String(toolInfo.detail).slice(0, 140);

  if (event === 'PreToolUse') {
    capturePreEditSnapshot(payload.toolCall);
    if (!online) {
      process.stdout.write(JSON.stringify({ decision: 'allow' }));
      return;
    }
    if (ws) triggerCodeWatcher(ws);
    triggerTelemetryStream();

    const toolName = payload.toolCall?.name || 'tool';
    const info = toolInfo || { kind: 'approval', target: toolName, detail: '', payload: {} };
    const statusRes = await httpJson('POST', `${base}/api/agy/status`, statusBody, pin, 450);
    const ctrl = statusRes.data || {};
    const isPaused = Boolean(ctrl.paused);
    const gateScope = ctrl.gateScope || 'all';
    const autoWsEdits = Boolean(ctrl.autoWsEdits);

    if (!isPaused && autoWsEdits && isEditTool(toolName)) {
      process.stdout.write(JSON.stringify({ decision: 'auto_approve', reason: 'Auto-approved edit via PhoneBox Control' }));
      return;
    }
    if (!isPaused && gateScope === 'cmd_query' && info.kind === 'approval' && /^(view_file|read_file|list_dir|find_by_name|grep_search)$/.test(toolName)) {
      process.stdout.write(JSON.stringify({ decision: 'allow' }));
      return;
    }

    const reqKind = isPaused ? 'paused' : info.kind;
    const reqTarget = isPaused ? `Paused: ${info.target}` : info.target;
    const created = await httpJson('POST', `${base}/api/agy/permission`, {
      toolName,
      kind: reqKind,
      target: reqTarget,
      detail: info.detail,
      payload: info.payload,
      modelName: stats.model,
      conversationId: payload.conversationId || ''
    }, pin, 600);

    if ((!created.ok || !created.data?.gateEnabled || !created.data?.permission?.id) && !isPaused) {
      process.stdout.write(JSON.stringify({ decision: 'allow' }));
      return;
    }
    if (!created.ok || !created.data?.permission?.id) {
      process.stdout.write(JSON.stringify({ decision: 'allow' }));
      return;
    }

    const permId = created.data.permission.id;
    const deadline = Date.now() + 220_000;
    let dec = 'pending';
    let respData = {};
    let netErrors = 0;

    while (Date.now() < deadline) {
      const rem = Math.min(25_000, Math.max(1000, deadline - Date.now()));
      const waited = await httpJson('GET', `${base}/api/agy/permission/${permId}/wait?timeout=${rem}&keepPending=1`, null, pin, rem + 3500);
      if (waited.ok && waited.data) {
        netErrors = 0;
        const cur = waited.data.decision;
        if (cur && cur !== 'pending') {
          dec = cur;
          respData = waited.data.response || {};
          break;
        }
      } else {
        netErrors++;
        if (netErrors >= 5) break;
        await new Promise(r => setTimeout(r, 600));
      }
    }

    if (dec === 'pending') {
      await httpJson('POST', `${base}/api/agy/permission/${permId}/decide`, { decision: 'ask' }, pin, 500);
      dec = 'ask';
    }

    if (dec === 'submit_choice') {
      const reason = formatMobileChoiceReason(respData.answers || []);
      process.stdout.write(JSON.stringify({ decision: 'deny', reason }));
    } else if (dec === 'auto_proceed') {
      const args = payload.toolCall?.args || {};
      const out = { decision: 'auto_approve', reason: 'Approved & proceeded via PhoneBox Mobile' };
      if (args.ArtifactMetadata) {
        out.overwrite = { ArtifactMetadata: { ...args.ArtifactMetadata, RequestFeedback: false } };
      }
      process.stdout.write(JSON.stringify(out));
    } else if (dec === 'always_allow') {
      const overrides = buildPermissionOverrides(payload.toolCall);
      const out = { decision: 'auto_approve', reason: 'Always allowed via PhoneBox Mobile' };
      if (overrides.length) out.permissionOverrides = overrides;
      process.stdout.write(JSON.stringify(out));
    } else if (dec === 'allow' || dec === 'auto_approve') {
      process.stdout.write(JSON.stringify({ decision: 'auto_approve', reason: 'Approved via PhoneBox Mobile' }));
    } else if (dec === 'deny') {
      process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'Denied on PhoneBox Mobile' }));
    } else {
      process.stdout.write(JSON.stringify({ decision: 'ask', reason: 'Deferred to laptop prompt' }));
    }
    return;
  }

  if (online) {
    if (ws) triggerCodeWatcher(ws);
    triggerTelemetryStream();
    await httpJson('POST', `${base}/api/agy/status`, statusBody, pin, 600);
    if (event === 'PostToolUse' || event === 'SyncOnly' || event === 'Stop') {
      const codeSummary = recordEditAndCollectCode(ws, payload.toolCall, event === 'PostToolUse');
      if (codeSummary && (event === 'SyncOnly' || isEditTool(payload.toolCall?.name) || codeSummary.mode === 'git' || event === 'Stop')) {
        await httpJson('POST', `${base}/api/agy/code`, codeSummary, pin, 700);
      }
    }

    if (event === 'PreInvocation' || event === 'PostInvocation' || event === 'Stop') {
      const claimed = await httpJson('POST', `${base}/api/agy/commands/claim`, {}, pin, 500);
      const cmds = Array.isArray(claimed.data?.commands) ? claimed.data.commands : [];
      const hasStop = cmds.some(c => c.kind === 'stop');

      if (event === 'Stop') {
        const promptCmds = cmds.filter(c => c.kind !== 'stop' && c.command);
        if (promptCmds.length && !hasStop) {
          const reason = promptCmds.map(c => `[PHONEBOX_MOBILE_COMMAND] ${c.command}`).join('\n');
          process.stdout.write(JSON.stringify({ decision: 'continue', reason }));
          return;
        }
        process.stdout.write('{}');
        return;
      }

      if (hasStop) {
        process.stdout.write(JSON.stringify({
          terminationBehavior: 'terminate',
          injectSteps: [{ errorMessage: { userMessage: 'Stopped by user from PhoneBox Mobile.' } }]
        }));
        return;
      }
      const promptCmds = cmds.filter(c => c.command && c.kind !== 'pause');
      if (promptCmds.length) {
        process.stdout.write(JSON.stringify({
          injectSteps: promptCmds.map(c => ({ userMessage: `[PHONEBOX_MOBILE_COMMAND] ${c.command}` }))
        }));
        return;
      }
    }
  }
  if (event !== 'SyncOnly') process.stdout.write('{}');
}

main().catch(() => {
  const isPre = process.argv.includes('PreToolUse');
  process.stdout.write(isPre ? '{"decision":"allow"}' : '{}');
});
