import { ico } from '/shared/icons.js';

export const store = {
  state: null,
  currentPageIdx: 0,
  volDragLockUntil: 0,
  brightDragLockUntil: 0,
  musicSeekDragUntil: 0,
  appVolDragLocks: new Map(),
  onNavigatePage: null,
  onOpenAgyModal: null,
  onRerender: null
};

export function haptic(ms = 20) {
  try { window.PhoneBoxNative?.vibrate(ms); } catch (_) {}
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

export function showToast(title, body, ms = 3500) {
  const el = document.getElementById('toast');
  if (!el) return;
  document.getElementById('toastTitle').textContent = title || 'Notification';
  document.getElementById('toastBody').textContent = body || '';
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.hidden = true; }, ms);
}

export function emptyMsg(detail) {
  return `<div class="empty-state">No data found${detail ? `<br><small>${esc(detail)}</small>` : ''}</div>`;
}

export function fmtBytes(b) {
  return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
}

export function fmtSec(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export function fmtTrackTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec || 0)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}` : `${m}:${String(rem).padStart(2, '0')}`;
}

export function fmtUptime(sec) {
  const s = Math.max(0, Math.floor(Number(sec || 0)));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export function fmtNetRate(kbps) {
  const k = Number(kbps);
  if (!Number.isFinite(k) || k < 0) return 'N/A';
  if (k >= 1024) return `${(k / 1024).toFixed(2)} MB/s`;
  return `${k.toFixed(1)} KB/s`;
}

export function fmtProcMem(bytes) {
  const b = Math.max(0, Number(bytes || 0));
  const gb = b / (1024 ** 3);
  if (gb >= 0.95) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(b / (1024 ** 2)))} MB`;
}

export function fmtTok(n) {
  const num = Number(n || 0);
  if (!Number.isFinite(num) || num <= 0) return '0';
  if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return String(Math.round(num));
}

export function fmtRelAgo(ts) {
  if (!ts) return '';
  const sec = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
  if (sec < 60) return 'just now';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return Math.floor(sec / 86400) + 'd ago';
}

export function fmtResetTime(resetSec, resetIso) {
  if (!resetSec && !resetIso) return '';
  const targetMs = resetIso ? Date.parse(resetIso) : (Date.now() + Number(resetSec) * 1000);
  if (!Number.isFinite(targetMs)) return '';
  const d = new Date(targetMs);
  const diffMin = Math.max(0, Math.round((targetMs - Date.now()) / 60000));
  const days = Math.floor(diffMin / 1440);
  const hrs = Math.floor((diffMin % 1440) / 60);
  const mins = diffMin % 60;
  const whenStr = days > 0
    ? d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const inStr = days > 0 ? `${days}d ${hrs}h` : (hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`);
  return `${whenStr} · in ${inStr}`;
}

export function appBadgeColor(name) {
  const palette = ['#84cc16', '#818cf8', '#f87171', '#f472b6', '#e879f9', '#38bdf8', '#2dd4bf', '#fb923c', '#facc15', '#4ade80'];
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

export function classifyPageGroup(page) {
  const id = String(page?.id || '').toLowerCase();
  const types = (page?.widgets || []).map(w => String(w.type || ''));
  const hasLap = types.some(t => t.startsWith('laptop_') || t.startsWith('pc_') || t.startsWith('agy') || t === 'antigravity');
  if (hasLap || ['laptop', 'processes', 'pc_music', 'pc_deck', 'pc_remote', 'pc_workspace', 'agy', 'code'].includes(id)) {
    return 'laptop';
  }
  return 'mobile';
}

export function openDetailModal({ title, bodyHtml, actionsHtml, onBind }) {
  const modal = document.getElementById('detailModal');
  document.getElementById('detailModalTitle').textContent = title || 'Details';
  document.getElementById('detailModalBody').innerHTML = bodyHtml || '';
  document.getElementById('detailModalActions').innerHTML = actionsHtml || '';
  modal.hidden = false;
  document.getElementById('detailModalClose').onclick = () => { modal.hidden = true; };
  if (typeof onBind === 'function') onBind(modal);
}

export function sendPcInput(payload) {
  return fetch('/api/laptop/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

let pcPadPendingDx = 0;
let pcPadPendingDy = 0;
let pcPadFlushTimer = null;

export function queuePcCursorMove(dx, dy) {
  pcPadPendingDx += dx;
  pcPadPendingDy += dy;
  if (pcPadFlushTimer) return;
  pcPadFlushTimer = setTimeout(() => {
    pcPadFlushTimer = null;
    const rx = Math.round(pcPadPendingDx);
    const ry = Math.round(pcPadPendingDy);
    pcPadPendingDx = 0;
    pcPadPendingDy = 0;
    if (rx !== 0 || ry !== 0) sendPcInput({ op: 'move', dx: rx, dy: ry });
  }, 36);
}

export function shortOutputName(fullName) {
  const m = String(fullName || '').match(/^[^(]+\((.+)\)$/);
  return m ? m[1] : String(fullName || 'Output');
}

export function buildAudioOutputsHtml(outputs) {
  if (!outputs.length) return '';
  return `<div class="pcm-out-strip">
    ${outputs.map(o => `<button type="button" class="pcm-out-chip ${o.isDefault ? 'active' : ''}" data-pc-out="${esc(o.id)}" title="${esc(o.name)}">${esc(shortOutputName(o.name))}</button>`).join('')}
  </div>`;
}

export function buildAudioSessionsHtml(sessions) {
  if (!sessions.length) return '<div class="hw-empty">No active app audio streams</div>';
  return `<div class="pcm-mixer-list">
    ${sessions.map(s => `<div class="pcm-mix-row" data-mix-key="${esc(s.key)}">
      <span class="pcm-mix-name">${esc(s.name)}</span>
      <button type="button" class="pcm-mix-mute ${s.muted ? 'muted' : ''}" data-mix-mute="${esc(s.key)}" data-cur-muted="${s.muted ? 1 : 0}">${ico(s.muted ? 'volume-x' : 'volume-2', 11)}</button>
      <input type="range" min="0" max="100" value="${s.vol}" class="pcm-range" data-mix-vol="${esc(s.key)}">
      <span class="pcm-val" data-mix-lbl="${esc(s.key)}">${s.vol}%</span>
    </div>`).join('')}
  </div>`;
}

export function bindAudioSwitcherAndMixer(body) {
  body.querySelectorAll('[data-pc-out]').forEach(b => {
    b.onclick = () => { haptic(18); sendPcInput({ op: 'set_audio_output', deviceId: b.dataset.pcOut }); };
  });
  body.querySelectorAll('[data-mix-mute]').forEach(b => {
    b.onclick = () => {
      haptic(14);
      const nextMute = b.dataset.curMuted !== '1';
      sendPcInput({ op: 'set_app_audio', key: b.dataset.mixMute, mute: nextMute });
    };
  });
  body.querySelectorAll('[data-mix-vol]').forEach(rng => {
    const k = rng.dataset.mixVol;
    const lbl = body.querySelector(`[data-mix-lbl="${CSS.escape(k)}"]`);
    rng.oninput = (e) => {
      store.appVolDragLocks.set(k, Date.now() + 1800);
      if (lbl) lbl.textContent = `${e.target.value}%`;
    };
    rng.onchange = (e) => {
      store.appVolDragLocks.set(k, Date.now() + 1200);
      sendPcInput({ op: 'set_app_audio', key: k, vol: Number(e.target.value) });
    };
  });
}

export function buildSparkSvg(seriesList, fixedMax = null, gradPrefix = 'hw') {
  const valid = seriesList.filter(s => Array.isArray(s.points) && s.points.length >= 2);
  if (!valid.length) return '<div class="hw-empty">Waiting for live samples...</div>';

  const allVals = valid.flatMap(s => s.points.map(p => Number(p.v ?? 0))).filter(Number.isFinite);
  const minVal = fixedMax != null ? 0 : Math.min(...allVals);
  const maxVal = fixedMax != null ? fixedMax : Math.max(minVal + 5, ...allVals);
  const span = Math.max(1, maxVal - minVal);
  const W = 320, H = 96;

  const gridLines = [0.25, 0.5, 0.75].map(r => {
    const y = (H * r).toFixed(1);
    return `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="rgba(255,255,255,0.065)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  }).join('');

  const defs = [];
  const shapes = [];
  valid.forEach((s, idx) => {
    const pts = s.points;
    const gid = `${gradPrefix}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
    defs.push(`<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${s.color}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${s.color}" stop-opacity="0.01"/>
    </linearGradient>`);

    const coords = pts.map((p, i) => {
      const x = ((i / (pts.length - 1)) * W).toFixed(1);
      const norm = Math.max(0, Math.min(1, (Number(p.v ?? 0) - minVal) / span));
      const y = (H - 4 - norm * (H - 10)).toFixed(1);
      return `${x},${y}`;
    });
    const areaPts = `0,${H} ${coords.join(' ')} ${W},${H}`;
    shapes.push(`<polygon fill="url(#${gid})" points="${areaPts}"/>`);
    shapes.push(`<polyline fill="none" stroke="${s.color}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="${coords.join(' ')}"/>`);
  });

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs>${defs.join('')}</defs>${gridLines}${shapes.join('')}</svg>`;
}
