import { ico } from '/shared/icons.js';
import { store, haptic, esc, showToast, emptyMsg, fmtTok, fmtRelAgo, fmtResetTime } from '../lib/core.js';

let selectedAgyQuotaGroup = 'auto';
let dismissedPermId = 0;
let selectedAgyCodePath = '';
let selectedAgyCodeTab = 'diff';
const agyChoiceDrafts = new Map();

function makeAgyRing(pct, valLabel, valSub, title, subLine, color = '#e98a63', color2 = '#f6b18f', subCls = '') {
  const r = 40, circ = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, Number(pct || 0)));
  const offset = circ - (clamped / 100) * circ;
  const gradId = 'g_' + Math.random().toString(36).slice(2, 8);
  const angleDeg = -90 + (clamped / 100) * 360;
  return `<div class="agy-ring-item">
    <div class="agy-ring-box" style="--rc:${color}">
      <svg viewBox="0 0 100 100">
        <defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${color}"/><stop offset="100%" stop-color="${color2}"/></linearGradient></defs>
        <circle class="agy-orbit" cx="50" cy="50" r="46" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="3 6"/>
        <circle cx="50" cy="50" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="7.5"/>
        <circle class="agy-arc" cx="50" cy="50" r="${r}" fill="none" stroke="url(#${gradId})" stroke-width="7.5" stroke-linecap="round" style="filter:drop-shadow(0 0 7px ${color}99);transform:rotate(-90deg);transform-origin:50px 50px" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/>
        ${clamped > 2 ? `<line x1="85" y1="50" x2="95" y2="50" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" style="transform:rotate(${angleDeg.toFixed(1)}deg);transform-origin:50px 50px;filter:drop-shadow(0 0 4px #ffffff)"/>` : ''}
      </svg>
      <div class="agy-ring-val"><span>${esc(valLabel)}</span>${valSub ? `<small>${esc(valSub)}</small>` : ''}</div>
    </div>
    <div class="agy-ring-lbl">${esc(title)}</div>
    <div class="agy-ring-sub ${subCls}">${esc(subLine)}</div>
  </div>`;
}

function resolveAgyQuotaBuckets(agy) {
  const quota = agy.quota || {}, groups = Array.isArray(agy.quotaGroups) ? agy.quotaGroups : [];
  const modelIs3p = /claude|gpt|sonnet|opus|o1|o3|oss/i.test(String(agy.model || ''));
  const targetPrefix = selectedAgyQuotaGroup === '3p' ? '3p' : (selectedAgyQuotaGroup === 'gemini' ? 'gemini' : (modelIs3p ? '3p' : 'gemini'));
  const group = groups.find(g => { const n = String(g.name || '').toLowerCase(); return targetPrefix === '3p' ? (n.includes('claude') || n.includes('gpt')) : n.includes('gemini'); }) || groups[0];
  if (group && Array.isArray(group.buckets)) {
    return {
      five: group.buckets.find(b => b.window === '5h' || /5h|hour/i.test(b.id)) || null,
      week: group.buckets.find(b => b.window === 'weekly' || /week/i.test(b.id)) || null,
      groups
    };
  }
  const entries = Object.entries(quota);
  const pick = (re) => (entries.find(([k]) => k.toLowerCase().includes(targetPrefix) && re.test(k)) || entries.find(([k]) => re.test(k)))?.[1] || null;
  return { five: pick(/5h|hour|session/i), week: pick(/week/i), groups };
}

function normalizeAgyQuestions(perm) {
  const qs = perm?.payload?.questions || perm?.payload?.Questions;
  if (!Array.isArray(qs)) return [];
  return qs.map(q => ({
    question: String(q?.question || q?.prompt || 'Select option'),
    isMulti: Boolean(q?.is_multi_select ?? q?.isMultiSelect),
    options: Array.isArray(q?.options || q?.choices) ? (q.options || q.choices).map(o => typeof o === 'string' ? o : String(o?.label || o?.value || o?.text || '')).filter(Boolean) : []
  }));
}

function getChoiceDraft(permId, qList) {
  const key = String(permId);
  let draft = agyChoiceDrafts.get(key);
  if (!draft || draft.length !== qList.length) {
    draft = qList.map(() => ({ sel: [], custom: '' }));
    agyChoiceDrafts.set(key, draft);
  }
  return draft;
}

function buildChoiceHtml(perm) {
  const qList = normalizeAgyQuestions(perm);
  if (!qList.length) return '';
  const draft = getChoiceDraft(perm.id, qList);
  return `<div class="agy-choice-wrap" data-choice-pid="${perm.id}">
    ${qList.map((q, qi) => {
      const cur = draft[qi] || { sel: [], custom: '' };
      return `<div class="agy-choice-qbox" data-qi="${qi}">
        <div class="agy-choice-qhead"><b>${qList.length > 1 ? `Q${qi + 1}. ` : ''}${esc(q.question)}</b><span class="agy-choice-mode">${q.isMulti ? 'Multi' : 'Single'}</span></div>
        <div class="agy-choice-opts">
          ${q.options.map((opt, oi) => {
            const on = cur.sel.includes(opt);
            return `<button type="button" class="agy-choice-opt ${on ? 'selected' : ''}" data-qi="${qi}" data-oi="${oi}" data-opt-val="${esc(opt)}">
              <span class="agy-opt-mark">${ico(on ? (q.isMulti ? 'check-square' : 'check') : (q.isMulti ? 'square' : 'circle'), 13)}</span><span>${esc(opt)}</span>
            </button>`;
          }).join('')}
        </div>
        <input type="text" class="agy-choice-custom" data-q-custom="${qi}" value="${esc(cur.custom)}" placeholder="Or type custom choice / note...">
      </div>`;
    }).join('')}
  </div>`;
}

function buildPermButtonsHtml(perm) {
  if (perm.kind === 'choice' && normalizeAgyQuestions(perm).length) {
    return `<button class="btn sm primary" data-submit-choice="${perm.id}">${ico('send', 12)} Submit Choice</button><button class="btn sm" data-dec-id="${perm.id}" data-dec="ask">Laptop</button><button class="btn sm danger" data-dec-id="${perm.id}" data-dec="deny">${ico('x', 12)} Deny</button>`;
  }
  if (perm.kind === 'plan_review') {
    return `<button class="btn sm primary" data-dec-id="${perm.id}" data-dec="auto_proceed">${ico('check', 12)} Approve &amp; Proceed</button><button class="btn sm" data-dec-id="${perm.id}" data-dec="auto_approve">File Only</button><button class="btn sm" data-dec-id="${perm.id}" data-dec="ask">Laptop</button><button class="btn sm danger" data-dec-id="${perm.id}" data-dec="deny">${ico('x', 12)} Deny</button>`;
  }
  const primaryLabel = perm.kind === 'query' ? 'Approve &amp; Execute' : (perm.kind === 'trigger' ? 'Approve &amp; Trigger' : 'Approve');
  return `<button class="btn sm primary" data-dec-id="${perm.id}" data-dec="auto_approve">${ico('check', 12)} ${primaryLabel}</button><button class="btn sm" data-dec-id="${perm.id}" data-dec="always_allow">${ico('zap', 12)} Always</button><button class="btn sm" data-dec-id="${perm.id}" data-dec="ask">Laptop</button><button class="btn sm danger" data-dec-id="${perm.id}" data-dec="deny">${ico('x', 12)} Deny</button>`;
}

async function decideAgyPerm(id, decision, responseObj) {
  await fetch(`/api/agy/permission/${id}/decide`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, ...(responseObj ? { response: responseObj } : {}) })
  });
  haptic(25);
  agyChoiceDrafts.delete(String(id));
  document.getElementById('agyPermModal').hidden = true;
}

function bindAgyPermHandlers(container, perm) {
  if (!container || !perm) return;
  const qList = normalizeAgyQuestions(perm);
  if (perm.kind === 'choice' && qList.length) {
    const draft = getChoiceDraft(perm.id, qList);
    container.querySelectorAll('.agy-choice-opt').forEach(btn => {
      btn.onclick = () => {
        haptic(14);
        const qi = Number(btn.dataset.qi), val = btn.dataset.optVal || '', q = qList[qi];
        if (!q || !draft[qi]) return;
        if (q.isMulti) { const i = draft[qi].sel.indexOf(val); if (i >= 0) draft[qi].sel.splice(i, 1); else draft[qi].sel.push(val); }
        else draft[qi].sel = [val];
        const qBox = btn.closest('.agy-choice-qbox');
        qBox?.querySelectorAll('.agy-choice-opt').forEach(ob => {
          const active = draft[qi].sel.includes(ob.dataset.optVal || '');
          ob.classList.toggle('selected', active);
          const mark = ob.querySelector('.agy-opt-mark');
          if (mark) mark.innerHTML = ico(active ? (q.isMulti ? 'check-square' : 'check') : (q.isMulti ? 'square' : 'circle'), 13);
        });
      };
    });
    container.querySelectorAll('.agy-choice-custom').forEach(inp => { inp.oninput = () => { const qi = Number(inp.dataset.qCustom); if (draft[qi]) draft[qi].custom = inp.value; }; });
    const subBtn = container.querySelector(`[data-submit-choice="${perm.id}"]`);
    if (subBtn) {
      subBtn.onclick = () => {
        const answers = qList.map((q, qi) => ({ question: q.question, selected: [...(draft[qi]?.sel || [])], customText: String(draft[qi]?.custom || '').trim() }));
        if (!answers.every(a => a.selected.length > 0 || a.customText.length > 0)) { showToast('Select Choice', 'Pick at least one option or enter custom text'); haptic(30); return; }
        subBtn.disabled = true; decideAgyPerm(perm.id, 'submit_choice', { answers });
      };
    }
  }
  container.querySelectorAll(`[data-dec-id="${perm.id}"]`).forEach(btn => { btn.onclick = () => { btn.disabled = true; decideAgyPerm(perm.id, btn.dataset.dec); }; });
}

export function checkPendingAgyModal(forceOpen = false) {
  const modal = document.getElementById('agyPermModal');
  const pending = (store.state?.agyPermissions || []).find(p => p.status === 'pending');
  if (!pending) { modal.hidden = true; modal.dataset.permId = ''; dismissedPermId = 0; return; }
  if (!forceOpen && pending.id === dismissedPermId) return;
  if (!modal.hidden && modal.dataset.permId === String(pending.id)) return;
  modal.dataset.permId = String(pending.id);
  document.getElementById('agyPermTool').textContent = pending.toolName || 'tool';
  const kindEl = document.getElementById('agyPermKind');
  kindEl.hidden = pending.kind !== 'choice';
  document.getElementById('agyPermModel').textContent = pending.modelName || '';
  const detailEl = document.getElementById('agyPermDetail'), interEl = document.getElementById('agyPermInteractive'), actEl = document.getElementById('agyPermActions');
  if (pending.kind === 'choice' && normalizeAgyQuestions(pending).length) {
    detailEl.hidden = true; interEl.innerHTML = buildChoiceHtml(pending);
  } else {
    detailEl.hidden = false; detailEl.textContent = pending.detail || pending.target || ''; interEl.innerHTML = '';
  }
  actEl.innerHTML = buildPermButtonsHtml(pending);
  modal.hidden = false;
  document.getElementById('agyPermClose').onclick = () => { dismissedPermId = pending.id; modal.hidden = true; modal.dataset.permId = ''; };
  bindAgyPermHandlers(modal, pending);
}

export function renderAntigravityWidget(body, tag) {
  const agy = store.state?.agy || {};
  const gateOn = store.state?.settings?.agy_gate_enabled === '1';
  const pendingCount = (store.state?.agyPermissions || []).filter(p => p.status === 'pending').length;
  tag.innerHTML = `<button class="btn sm ${gateOn ? 'primary' : ''}" data-agy-gate="1">${ico('shield', 12)} Gate: ${gateOn ? 'ON' : 'OFF'}</button>`;
  tag.querySelector('[data-agy-gate]').onclick = () => { haptic(20); fetch('/api/agy/gate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !gateOn }) }); };
  if (!agy.updatedAt) { body.innerHTML = emptyMsg('No data found — Connect laptop Antigravity hooks'); return; }

  const { five: fiveBucket, week: weekBucket, groups } = resolveAgyQuotaBuckets(agy);
  const ctxTotal = Number(agy.contextLimit || 1048576), ctxUsed = Number(agy.contextTokens || 0);
  const ctxPct = ctxTotal > 0 ? Math.min(100, Math.round((ctxUsed / ctxTotal) * 100)) : 0, ctxLeftPct = Math.max(0, 100 - ctxPct);

  const ring5h = fiveBucket && typeof fiveBucket.remaining_fraction === 'number'
    ? makeAgyRing(Math.round(fiveBucket.remaining_fraction * 100), `${Math.round(fiveBucket.remaining_fraction * 100)}%`, `${100 - Math.round(fiveBucket.remaining_fraction * 100)}% used`, '5-hour limit', fmtResetTime(fiveBucket.reset_in_seconds, fiveBucket.reset_time) || '5-hour limit', '#e98a63', '#f7b290', Math.round(fiveBucket.remaining_fraction * 100) > 25 ? 'ok' : 'warn')
    : makeAgyRing(agy.window5hTokens > 0 ? Math.min(92, Math.max(14, Math.round((agy.window5hTokens / (agy.window5hTokens + 55000000)) * 100))) : 0, fmtTok(agy.window5hTokens || 0), '5h tokens', '5-hour window', `${agy.window5hSessions || 0} sessions`, '#e98a63', '#f7b290', '');
  const ringWeek = weekBucket && typeof weekBucket.remaining_fraction === 'number'
    ? makeAgyRing(Math.round(weekBucket.remaining_fraction * 100), `${Math.round(weekBucket.remaining_fraction * 100)}%`, `${100 - Math.round(weekBucket.remaining_fraction * 100)}% used`, 'Weekly limit', fmtResetTime(weekBucket.reset_in_seconds, weekBucket.reset_time) || 'Weekly limit', '#38bdf8', '#7dd3fc', Math.round(weekBucket.remaining_fraction * 100) > 20 ? 'ok' : 'warn')
    : makeAgyRing(agy.weeklyTokens > 0 ? Math.min(92, Math.max(18, Math.round((agy.weeklyTokens / (agy.weeklyTokens + 450000000)) * 100))) : 0, fmtTok(agy.weeklyTokens || 0), '7d tokens', 'Weekly total', `${agy.weeklyTurns || 0} turns`, '#38bdf8', '#7dd3fc', '');
  const ringCtx = makeAgyRing(ctxPct, `${ctxPct}%`, `${ctxLeftPct}% left`, 'Context window', `${fmtTok(ctxUsed)} / ${fmtTok(ctxTotal)}`, '#2dd4bf', '#5eead4', ctxLeftPct > 25 ? 'ok' : 'warn');

  const sesIn = Number(agy.sessionIn || 0), sesOut = Number(agy.sessionOut || 0), sesCached = Number(agy.sessionCached || 0), sesTotal = Math.max(1, sesIn + sesOut + sesCached);
  const pIn = Math.max(2, Math.round((sesIn / sesTotal) * 100)), pOut = Math.max(2, Math.round((sesOut / sesTotal) * 100)), pCache = Math.max(0, 100 - pIn - pOut);
  const tier = agy.planTier || (agy.source === 'cli' ? 'CLI' : 'App'), stBadge = agy.agentState || 'active';
  const gem5 = agy.quota?.['gemini-5h']?.remaining_fraction ?? null, cl5 = agy.quota?.['3p-5h']?.remaining_fraction ?? null;
  const activeKey = selectedAgyQuotaGroup === '3p' ? '3p' : (selectedAgyQuotaGroup === 'gemini' ? 'gemini' : (/claude|gpt|sonnet|opus/i.test(String(agy.model || '')) ? '3p' : 'gemini'));

  body.innerHTML = `<div class="agy-wrap">
    <div class="agy-top-row">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span class="agy-tier">${esc(tier)}</span><span class="agy-live-pill ${stBadge === 'idle' ? 'idle' : ''}"><i class="agy-beacon"></i>${esc(stBadge)}</span>
        ${(groups.length > 0 || gem5 != null || cl5 != null) ? `<button type="button" class="agy-qtab ${activeKey === 'gemini' ? 'active' : ''}" data-qgrp="gemini">Gemini ${gem5 != null ? Math.round(gem5 * 100) + '%' : ''}</button>` : ''}
        ${cl5 != null ? `<button type="button" class="agy-qtab ${activeKey === '3p' ? 'active' : ''}" data-qgrp="3p">Claude/GPT ${Math.round(cl5 * 100)}%</button>` : ''}
      </div>
      <small style="color:var(--muted)">${esc(fmtRelAgo(agy.updatedAt))}</small>
    </div>
    <div class="agy-rings">${ring5h}${ringWeek}${ringCtx}</div>
    <div class="agy-seg-bar"><span style="width:${pIn}%;background:#e98a63"></span><span style="width:${pOut}%;background:#38bdf8"></span><span style="width:${pCache}%;background:#2dd4bf"></span></div>
    <div class="agy-tiles">
      <div class="agy-tile"><small>Active Model</small><b>${esc(agy.model || 'Unknown')}</b></div>
      <div class="agy-tile"><small>Session Tokens</small><b>${fmtTok(sesIn + sesOut)} fresh · ${fmtTok(sesIn + sesOut + sesCached)} tot</b></div>
      <div class="agy-tile"><small>5h / 7d Tokens</small><b>${fmtTok(agy.window5hTokens || 0)} / ${fmtTok(agy.weeklyTokens || 0)}</b></div>
      <div class="agy-tile"><small>In / Out / Cache</small><b>${fmtTok(sesIn)} / ${fmtTok(sesOut)} / ${fmtTok(sesCached)}</b></div>
    </div>
    ${pendingCount > 0 ? `<button class="btn sm primary" data-open-perm="1">${ico('shield', 12)} ${pendingCount} Permission Pending — Review</button>` : ''}
  </div>`;
  body.querySelectorAll('[data-qgrp]').forEach(btn => { btn.onclick = () => { haptic(12); selectedAgyQuotaGroup = btn.dataset.qgrp || 'auto'; renderAntigravityWidget(body, tag); }; });
  const op = body.querySelector('[data-open-perm]');
  if (op) op.onclick = () => checkPendingAgyModal(true);
}

export function renderAgyPermissionsWidget(body, tag) {
  const perms = store.state?.agyPermissions || [], gateOn = store.state?.settings?.agy_gate_enabled === '1';
  tag.innerHTML = perms.length ? `<button class="btn sm" data-agyp-clr="1">Clear</button>` : `<span class="badge ${gateOn ? 'ok' : 'info'}">${gateOn ? 'ARMED' : 'MONITOR'}</span>`;
  const clr = tag.querySelector('[data-agyp-clr]');
  if (clr) clr.onclick = () => { haptic(15); fetch('/api/agy/permissions', { method: 'DELETE' }); };
  if (document.activeElement && body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const html = perms.length ? perms.map(p => {
    const isPend = p.status === 'pending', isChoice = p.kind === 'choice' && normalizeAgyQuestions(p).length > 0;
    const cls = isPend ? 'warn' : (p.status === 'deny' ? 'error' : 'ok');
    return `<div class="agy-perm-card ${isPend ? 'pending' : ''}" data-perm-card="${p.id}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px"><span class="badge info">${esc(isChoice ? 'Choice' : p.toolName)}</span><span class="badge ${cls}">${esc(String(p.status || 'PENDING').toUpperCase())}</span></div>
      ${isPend && isChoice ? buildChoiceHtml(p) : `<div class="agy-perm-preview">${esc(p.detail || p.target || p.toolName)}</div>`}
      ${isPend ? `<div class="agy-perm-btns">${buildPermButtonsHtml(p)}</div>` : ''}
    </div>`;
  }).join('') : `<div class="agy-perm-empty"><b>No pending permission requests</b><span>Turn Gate ON to approve laptop tools on phone.</span></div>`;
  body.innerHTML = `<div class="agy-perm-list">${html}</div>`;
  perms.filter(p => p.status === 'pending').forEach(p => { const c = body.querySelector(`[data-perm-card="${p.id}"]`); if (c) bindAgyPermHandlers(c, p); });
}

function renderDiffLinesHtml(diffText) {
  const lines = String(diffText || '').split(/\r?\n/);
  if (!lines.length || (lines.length === 1 && !lines[0])) return '<div class="dl meta">No diff lines recorded yet</div>';
  return lines.map(line => `<div class="${line.startsWith('+++') || line.startsWith('---') ? 'dl meta' : (line.startsWith('@@') ? 'dl hunk' : (line.startsWith('+') ? 'dl add' : (line.startsWith('-') ? 'dl del' : 'dl')))}">${esc(line || ' ')}</div>`).join('');
}
function renderCodeLinesHtml(codeText) {
  const lines = String(codeText || '').split(/\r?\n/);
  if (!lines.length || (lines.length === 1 && !lines[0])) return '<div class="dl meta">Live file snippet not synced yet — tap Sync</div>';
  return lines.map((line, i) => `<div class="cl"><span class="cl-n">${i + 1}</span><span class="cl-s">${esc(line || ' ')}</span></div>`).join('');
}

function updateAgyDiffModalView(fileObj) {
  const modal = document.getElementById('agyDiffModal'), bodyEl = document.getElementById('agyDiffBody');
  const prevTop = bodyEl.scrollTop, prevLeft = bodyEl.scrollLeft;
  modal.dataset.path = fileObj.path || '';
  document.getElementById('agyDiffFileTitle').textContent = fileObj.path || 'File Preview';
  document.getElementById('agyDiffStat').textContent = `+${fileObj.added || 0} / -${fileObj.removed || 0}`;
  document.getElementById('agyDiffTool').textContent = `${fileObj.tool || 'edit'} · ${fmtRelAgo(fileObj.updatedAt) || 'recent'}${fileObj.totalLines ? ` · ${fileObj.totalLines}L` : ''}`;
  const swEl = document.getElementById('agyDiffModeSwitch');
  if (swEl) {
    swEl.innerHTML = `<button type="button" class="${selectedAgyCodeTab === 'diff' ? 'active' : ''}" data-md="diff">Diff</button><button type="button" class="${selectedAgyCodeTab === 'code' ? 'active' : ''}" data-md="code">Live Code</button>`;
    swEl.querySelectorAll('[data-md]').forEach(b => { b.onclick = () => { haptic(12); selectedAgyCodeTab = b.dataset.md; updateAgyDiffModalView(fileObj); store.onRerender?.(); }; });
  }
  bodyEl.innerHTML = selectedAgyCodeTab === 'code' ? renderCodeLinesHtml(fileObj?.code || '') : renderDiffLinesHtml(fileObj?.diff || '');
  bodyEl.scrollTop = prevTop; bodyEl.scrollLeft = prevLeft;
}

export function renderAgyCodeWidget(body, tag) {
  const code = store.state?.agyCode || {}, files = Array.isArray(code.files) ? code.files : [];
  if (!files.some(f => f.path === selectedAgyCodePath)) selectedAgyCodePath = files[0]?.path || '';
  const activeFile = files.find(f => f.path === selectedAgyCodePath) || files[0] || null;
  const modal = document.getElementById('agyDiffModal');
  if (modal && !modal.hidden && modal.dataset.path) {
    const upd = files.find(f => f.path === modal.dataset.path);
    if (upd) updateAgyDiffModalView(upd);
  }
  tag.innerHTML = `<div style="display:flex;align-items:center;gap:5px"><button class="btn sm" data-sync-code="1">${ico('refresh', 12)} Sync</button>${activeFile ? `<button class="btn sm" data-expand-diff="1">${ico('maximize-2', 12)} Fullscreen</button>` : ''}</div>`;
  tag.querySelector('[data-sync-code]')?.addEventListener('click', () => { haptic(15); fetch('/api/agy/code/request-sync', { method: 'POST' }); showToast('Code Sync Requested', 'Pulling edits...'); });
  tag.querySelector('[data-expand-diff]')?.addEventListener('click', () => {
    haptic(15);
    updateAgyDiffModalView(activeFile);
    document.getElementById('agyDiffClose').onclick = () => { modal.hidden = true; modal.dataset.path = ''; };
    document.getElementById('agyDiffCopyBtn').onclick = () => { haptic(15); fetch('/api/clipboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: modal.dataset.path || '', source: 'phone', copyToDevice: true }) }); showToast('Copied Path', modal.dataset.path); };
    document.getElementById('agyDiffAskBtn').onclick = () => { haptic(20); const p = modal.dataset.path; modal.hidden = true; fetch('/api/agy/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: `Review changes in ${p}`, kind: 'prompt' }) }); };
    modal.hidden = false;
  });
  if (!files.length) { body.innerHTML = `<div class="agy-perm-empty"><b>No code changes synced yet</b><span>Watcher streams diffs when editing on laptop.</span></div>`; return; }

  body.innerHTML = `<div class="agy-code-wrap">
    <div class="agy-code-head">
      <div style="display:flex;align-items:center;gap:5px"><span class="agy-live-pill"><i class="agy-beacon"></i>${esc(fmtRelAgo(code.updatedAt) || 'live')}</span><span class="agy-code-branch">${ico('git-branch', 11)} ${esc(code.workspaceName || 'workspace')}</span></div>
      <div style="display:flex;align-items:center;gap:6px">
        <div class="agy-mode-mini"><button type="button" class="${selectedAgyCodeTab === 'diff' ? 'active' : ''}" data-ctab="diff">Diff</button><button type="button" class="${selectedAgyCodeTab === 'code' ? 'active' : ''}" data-ctab="code">Code</button></div>
        <span style="font-size:10.5px"><span class="agy-stat-add">+${code.totalAdded || 0}</span> <span class="agy-stat-del">-${code.totalRemoved || 0}</span></span>
      </div>
    </div>
    <div class="agy-file-tabs">${files.map(f => `<button type="button" class="agy-file-pill ${activeFile && f.path === activeFile.path ? 'active' : ''}" data-cpath="${esc(f.path)}"><span class="agy-file-st ${esc(f.status || 'M')}">${esc(f.status || 'M')}</span><span>${esc(String(f.path || '').split('/').pop())}</span></button>`).join('')}</div>
    <div class="agy-diff-view">${selectedAgyCodeTab === 'code' ? renderCodeLinesHtml(activeFile?.code || '') : renderDiffLinesHtml(activeFile?.diff || '')}</div>
  </div>`;
  body.querySelectorAll('[data-cpath]').forEach(btn => { btn.onclick = () => { haptic(12); selectedAgyCodePath = btn.dataset.cpath || ''; renderAgyCodeWidget(body, tag); }; });
  body.querySelectorAll('[data-ctab]').forEach(btn => { btn.onclick = () => { haptic(12); selectedAgyCodeTab = btn.dataset.ctab || 'diff'; renderAgyCodeWidget(body, tag); }; });
}

export function renderAgyControlWidget(body, tag) {
  const s = store.state?.settings || {}, cmds = store.state?.agyCommands || [];
  const paused = s.agy_paused === '1', gateOn = s.agy_gate_enabled === '1', scope = s.agy_gate_scope || 'all';
  const autoEdits = s.agy_auto_ws_edits === '1', buzz = s.agy_alert_buzz !== '0';
  tag.innerHTML = `<span class="badge ${paused ? 'warn' : 'ok'}">${paused ? 'PAUSED' : 'READY'}</span>`;
  if (document.activeElement && body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const scopeMode = !gateOn ? 'off' : (scope === 'cmd_query' ? 'cmd_query' : 'all');
  const patchCtrl = (payload) => { haptic(18); fetch('/api/agy/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); };
  const sendCmd = (command, kind = 'prompt') => fetch('/api/agy/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, kind }) }).then(() => showToast('Queued for Laptop', command.slice(0, 60)));

  body.innerHTML = `<div class="agy-ctrl-wrap">
    <div class="agy-ctrl-banner ${paused ? 'paused' : ''}">
      <div class="agy-gate-info"><div class="agy-gate-ico">${ico(paused ? 'pause' : 'cpu', 15)}</div><div><b>${paused ? 'Agent Paused' : 'Laptop Agent Linked'}</b><small>${paused ? 'Tools wait until Resume' : 'Hooks active on laptop'}</small></div></div>
      <button class="btn sm ${paused ? 'primary' : 'danger'}" data-ctrl-pause="1">${ico(paused ? 'play' : 'pause', 12)} ${paused ? 'Resume' : 'Pause'}</button>
    </div>
    <div class="agy-seg-row">
      <button type="button" class="agy-seg-btn ${scopeMode === 'all' ? 'active' : ''}" data-scope="all">Gate: All</button>
      <button type="button" class="agy-seg-btn ${scopeMode === 'cmd_query' ? 'active' : ''}" data-scope="cmd_query">Cmd + Query</button>
      <button type="button" class="agy-seg-btn ${scopeMode === 'off' ? 'active' : ''}" data-scope="off">Gate: OFF</button>
    </div>
    <div class="agy-ctrl-toggles">
      <button type="button" class="agy-toggle-chip ${autoEdits ? 'on' : ''}" data-tog-edits="1"><span>Auto Edits</span><b>${autoEdits ? 'ON' : 'OFF'}</b></button>
      <button type="button" class="agy-toggle-chip ${buzz ? 'on' : ''}" data-tog-buzz="1"><span>Phone Buzz</span><b>${buzz ? 'ON' : 'OFF'}</b></button>
    </div>
    <div class="agy-cmd-form"><input type="text" class="agy-cmd-inp" id="agyCmdInput" placeholder="Send instruction to laptop..."><button type="button" class="btn sm primary" id="agyCmdSend">${ico('send', 12)}</button></div>
    <div class="agy-quick-chips">
      <button type="button" class="btn sm" data-qcmd="Continue" data-qkind="continue">Continue</button>
      <button type="button" class="btn sm" data-qcmd="Run project tests and verify build" data-qkind="prompt">Run Tests</button>
      <button type="button" class="btn sm danger" data-qcmd="Stop current task" data-qkind="stop">Stop Turn</button>
    </div>
    <div class="agy-cmd-list">${cmds.length ? cmds.map(c => `<div class="agy-cmd-row"><span>${esc(c.command)}</span><span class="badge ${c.status === 'pending' ? 'warn' : 'ok'}">${esc(String(c.status || '').toUpperCase())}</span></div>`).join('') : '<div class="empty-state" style="padding:8px">No instructions queued</div>'}</div>
  </div>`;
  body.querySelector('[data-ctrl-pause]').onclick = () => patchCtrl({ paused: !paused });
  body.querySelectorAll('[data-scope]').forEach(b => { b.onclick = () => { const m = b.dataset.scope; patchCtrl(m === 'off' ? { gateEnabled: false } : { gateEnabled: true, gateScope: m }); }; });
  body.querySelector('[data-tog-edits]').onclick = () => patchCtrl({ autoWsEdits: !autoEdits });
  body.querySelector('[data-tog-buzz]').onclick = () => patchCtrl({ alertBuzz: !buzz });
  const inp = body.querySelector('#agyCmdInput'), submitInp = () => { const v = inp.value.trim(); if (!v) return; inp.value = ''; haptic(20); sendCmd(v, 'prompt'); };
  body.querySelector('#agyCmdSend').onclick = submitInp;
  inp.onkeydown = (e) => { if (e.key === 'Enter') submitInp(); };
  body.querySelectorAll('[data-qcmd]').forEach(b => { b.onclick = () => { haptic(20); sendCmd(b.dataset.qcmd, b.dataset.qkind || 'prompt'); }; });
}
