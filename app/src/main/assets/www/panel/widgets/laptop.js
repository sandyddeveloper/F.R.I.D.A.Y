import { ico } from '/shared/icons.js';
import {
  store, haptic, esc, showToast, fmtProcMem, fmtRelAgo,
  appBadgeColor, openDetailModal, sendPcInput, queuePcCursorMove
} from '../lib/core.js';

let procViewMode = 'ram';
let pcScreenLive = false;
let pcScreenTimer = null;
let selectedDeckFolderIdx = 0;
let lockArmUntil = 0;
let cachedLaptopApps = [];

const DECK_TONES = {
  slate:   { bg: 'radial-gradient(circle at 85% 15%, rgba(148,163,184,0.16), rgba(16,20,29,0.95) 68%)', bd: 'rgba(148,163,184,0.22)', ic: '#cbd5e1' },
  blue:    { bg: 'radial-gradient(circle at 85% 15%, rgba(59,130,246,0.24), rgba(13,20,34,0.95) 68%)',  bd: 'rgba(59,130,246,0.34)',  ic: '#93c5fd' },
  cyan:    { bg: 'radial-gradient(circle at 85% 15%, rgba(56,189,248,0.22), rgba(12,22,33,0.95) 68%)',  bd: 'rgba(56,189,248,0.34)',  ic: '#7dd3fc' },
  amber:   { bg: 'radial-gradient(circle at 85% 15%, rgba(245,158,11,0.25), rgba(26,19,12,0.95) 68%)',  bd: 'rgba(245,158,11,0.36)',  ic: '#fcd34d' },
  emerald: { bg: 'radial-gradient(circle at 85% 15%, rgba(34,197,94,0.23), rgba(10,24,18,0.95) 68%)',   bd: 'rgba(34,197,94,0.34)',   ic: '#86efac' },
  violet:  { bg: 'radial-gradient(circle at 85% 15%, rgba(139,92,246,0.24), rgba(18,15,32,0.95) 68%)',  bd: 'rgba(139,92,246,0.34)',  ic: '#c4b5fd' },
  teal:    { bg: 'radial-gradient(circle at 85% 15%, rgba(45,212,191,0.22), rgba(11,24,25,0.95) 68%)',  bd: 'rgba(45,212,191,0.32)',  ic: '#5eead4' },
  purple:  { bg: 'radial-gradient(circle at 85% 15%, rgba(168,85,247,0.23), rgba(21,14,32,0.95) 68%)',  bd: 'rgba(168,85,247,0.34)',  ic: '#d8b4fe' },
  red:     { bg: 'radial-gradient(circle at 85% 15%, rgba(239,68,68,0.24), rgba(28,13,16,0.95) 68%)',   bd: 'rgba(239,68,68,0.36)',   ic: '#fca5a5' }
};

function getActiveLaptopWatches() {
  try {
    const arr = JSON.parse(store.state?.settings?.laptop_watches || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function openWatchlistManagerModal() {
  const watches = getActiveLaptopWatches();
  openDetailModal({
    title: `Active Job Watches (${watches.length})`,
    bodyHtml: watches.length ? `<div class="detail-kv">${watches.map(w => `<div class="detail-row" style="align-items:center">
      <div><b>${esc(w.name)}</b><br><small style="color:var(--muted)">Alert on ${w.mode === 'idle' ? 'Idle (<1% CPU)' : 'Exit'} · ${fmtRelAgo(w.startedAt)}</small></div>
      <button type="button" class="btn sm danger" data-wdel="${esc(w.id)}">Stop</button>
    </div>`).join('')}</div>` : '<p class="sub-muted">Tap any app in Laptop Processes and choose Alert on Exit or Alert if Idle.</p>',
    actionsHtml: `<button type="button" class="btn sm" id="wMgrClose">Close</button>`,
    onBind: (m) => {
      m.querySelector('#wMgrClose').onclick = () => { m.hidden = true; };
      m.querySelectorAll('[data-wdel]').forEach(btn => {
        btn.onclick = async () => {
          haptic(15);
          await fetch('/api/laptop/watch/' + encodeURIComponent(btn.dataset.wdel), { method: 'DELETE' });
          m.hidden = true;
        };
      });
    }
  });
}

function openProcessDetailModal(proc) {
  let confirmKill = false;
  const pidStr = Array.isArray(proc.pids) && proc.pids.length ? proc.pids.join(', ') : 'N/A';
  const curWatches = getActiveLaptopWatches().filter(w =>
    String(w.processName || '').toLowerCase() === String(proc.processName || '').toLowerCase()
  );
  const bodyHtml = `<div class="detail-kv">
    <div class="detail-row"><span>Process</span><span>${esc(proc.processName || proc.name)} (x${proc.count || 1})</span></div>
    <div class="detail-row"><span>Memory</span><span>${fmtProcMem(proc.ramBytes)}</span></div>
    <div class="detail-row"><span>CPU Load</span><span>${Number(proc.cpuPct || 0).toFixed(1)}%</span></div>
    <div class="detail-row"><span>Top PIDs</span><span>${esc(pidStr)}</span></div>
    <div class="detail-row"><span>Executable</span><span>${esc(proc.path || (proc.protected ? 'Protected / System process' : 'Unavailable'))}</span></div>
    <div class="detail-row"><span>Completion Ping</span><span>${curWatches.length ? `Watching (${curWatches.map(w => w.mode).join(', ')})` : 'Not watching'}</span></div>
  </div>`;

  const renderActions = (modal) => {
    const act = modal.querySelector('#detailModalActions');
    const watchBtns = `<button type="button" class="btn sm primary" data-pm-watch="exit">Alert on Exit</button><button type="button" class="btn sm" data-pm-watch="idle">Alert if Idle</button>`;
    if (proc.protected) {
      act.innerHTML = `${watchBtns}<button type="button" class="btn sm" data-pm-close="1">Close</button>`;
    } else if (!confirmKill) {
      act.innerHTML = `${watchBtns}<button type="button" class="btn sm danger" data-pm-ask="1">End Task</button><button type="button" class="btn sm" data-pm-close="1">Close</button>`;
    } else {
      act.innerHTML = `<span class="sub-muted" style="margin:0;color:#fca5a5">Stop ${esc(proc.name)}?</span><button type="button" class="btn sm" data-pm-cancel="1">Cancel</button><button type="button" class="btn sm danger" data-pm-confirm="1">Confirm End Task</button>`;
    }
    const c = act.querySelector('[data-pm-close]'); if (c) c.onclick = () => { modal.hidden = true; };
    const a = act.querySelector('[data-pm-ask]'); if (a) a.onclick = () => { haptic(15); confirmKill = true; renderActions(modal); };
    const k = act.querySelector('[data-pm-cancel]'); if (k) k.onclick = () => { confirmKill = false; renderActions(modal); };
    act.querySelectorAll('[data-pm-watch]').forEach(wb => {
      wb.onclick = async () => {
        haptic(20);
        await fetch('/api/laptop/watch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: proc.name, processName: proc.processName, pids: proc.pids || [], mode: wb.dataset.pmWatch })
        });
        modal.hidden = true;
        showToast('Job Watch Armed', `Will vibrate when ${proc.name} ${wb.dataset.pmWatch === 'idle' ? 'becomes idle' : 'finishes'}`);
      };
    });
    const go = act.querySelector('[data-pm-confirm]');
    if (go) {
      go.onclick = async () => {
        haptic(30);
        await fetch('/api/laptop/process/kill', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: proc.name, processName: proc.processName, pids: proc.pids || [] })
        });
        modal.hidden = true;
        showToast('End Task Queued', `Stopping ${proc.name}...`);
      };
    }
  };
  openDetailModal({ title: proc.name, bodyHtml, onBind: renderActions });
}

export function renderLaptopProcessesWidget(body) {
  const lap = store.state?.laptop || {};
  const procs = lap.processes || {};
  const list = procViewMode === 'cpu' ? (procs.byCpu || []) : (procs.byRam || []);
  const watches = getActiveLaptopWatches();
  const watchedSet = new Set(watches.map(w => String(w.processName || '').toLowerCase()));

  if (!lap.sampledAt || !list.length) {
    body.innerHTML = `<div class="proc-shell">
      <div class="proc-head"><div class="proc-title-wrap"><span class="proc-title">PROCESSES</span><span class="proc-sub">Waiting for laptop process telemetry...</span></div></div>
      <div class="hw-empty" style="flex:1 1 auto">No process data yet — connect your paired laptop bridge</div>
    </div>`;
    return;
  }

  const subText = procViewMode === 'cpu'
    ? `Total CPU ${lap.cpuPct ?? 0}% · ${procs.totalProcs || 0} processes · ${procs.totalApps || 0} apps · tap one for details`
    : `Total RAM ${lap.ramPct ?? 0}% (${lap.ramUsedGb ?? 0}/${lap.ramTotalGb ?? 0} GB) · ${procs.totalProcs || 0} processes · ${procs.totalApps || 0} apps`;
  const topItems = list.slice(0, 14);
  const maxVal = Math.max(1, ...topItems.map(x => procViewMode === 'cpu' ? Number(x.cpuPct || 0) : Number(x.ramBytes || 0)));

  body.innerHTML = `<div class="proc-shell">
    <div class="proc-head">
      <div class="proc-title-wrap"><span class="proc-title">PROCESSES</span><span class="proc-sub">${esc(subText)}</span></div>
      <div style="display:flex;align-items:center;gap:6px;flex:0 0 auto">
        ${watches.length ? `<button type="button" class="proc-watch-btn" data-w-mgr="1">${ico('bell', 10)} Watching ${watches.length}</button>` : ''}
        <div class="proc-toggle">
          <button type="button" class="${procViewMode === 'cpu' ? 'active' : ''}" data-pmode="cpu">CPU</button>
          <button type="button" class="${procViewMode === 'ram' ? 'active' : ''}" data-pmode="ram">RAM</button>
        </div>
      </div>
    </div>
    <div class="proc-grid">
      ${topItems.map((p, i) => {
        const val = procViewMode === 'cpu' ? Number(p.cpuPct || 0) : Number(p.ramBytes || 0);
        const pctW = val <= 0 ? 3 : Math.max(4, Math.min(100, Math.round((val / maxVal) * 92)));
        const topMetric = procViewMode === 'cpu' ? `${Number(p.cpuPct || 0).toFixed(1)}%` : fmtProcMem(p.ramBytes);
        const botMetric = procViewMode === 'cpu' ? fmtProcMem(p.ramBytes) : `${Number(p.cpuPct || 0).toFixed(1)}%`;
        const letter = esc(String(p.name || '?').trim().charAt(0).toUpperCase() || '?');
        const isWatched = watchedSet.has(String(p.processName || '').toLowerCase());
        return `<button type="button" class="proc-row" data-pidx="${i}">
          <span class="proc-badge" style="background:${appBadgeColor(p.name)}">${letter}</span>
          <div class="proc-body">
            <div class="proc-line">
              <span class="proc-name">${esc(p.name)}${p.count > 1 ? ` <span class="proc-cnt">×${p.count}</span>` : ''}${p.protected ? ` <span class="proc-cnt">${ico('lock', 10)}</span>` : ''}${isWatched ? `<span class="proc-watch-tag">WATCH</span>` : ''}</span>
              <span class="proc-vals"><b>${topMetric}</b><small>${botMetric}</small></span>
            </div>
            <div class="proc-track"><div class="proc-fill" style="width:${pctW}%"></div></div>
          </div>
        </button>`;
      }).join('')}
    </div>
  </div>`;

  const wMgr = body.querySelector('[data-w-mgr]');
  if (wMgr) wMgr.onclick = () => { haptic(12); openWatchlistManagerModal(); };
  body.querySelectorAll('[data-pmode]').forEach(btn => {
    btn.onclick = () => { haptic(12); procViewMode = btn.dataset.pmode; renderLaptopProcessesWidget(body); };
  });
  body.querySelectorAll('[data-pidx]').forEach(row => {
    row.onclick = () => { const item = topItems[Number(row.dataset.pidx)]; if (item) { haptic(15); openProcessDetailModal(item); } };
  });
}

function syncPcScreenLoop() {
  clearInterval(pcScreenTimer);
  pcScreenTimer = null;
  if (pcScreenLive) {
    fetch('/api/laptop/screen/request', { method: 'POST', body: '{}' }).catch(() => {});
    pcScreenTimer = setInterval(() => {
      if (!pcScreenLive || document.hidden) return;
      fetch('/api/laptop/screen/request', { method: 'POST', body: '{}' }).catch(() => {});
    }, 900);
  }
}

export function renderPcTrackpadWidget(body) {
  const s = store.state?.settings || {};
  const call = store.state?.callState || {};
  const autoMute = s.call_auto_mute !== '0';
  const notifMirror = s.win_notif_mirror !== '0';

  if (document.activeElement && body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') {
    body.querySelectorAll('[data-call-pill]').forEach(el => {
      el.className = `pcr-toggle ${call.active ? 'call' : (autoMute ? 'on' : '')}`;
      el.innerHTML = `${ico('phone-call', 10)} ${call.active ? 'Call Muted' : (autoMute ? 'AutoMute' : 'Mute Off')}`;
    });
    return;
  }

  body.innerHTML = `<div class="pcr-wrap">
    <div class="pcr-head">
      <span class="pcr-title">${ico('mouse', 12)} TRACKPAD &amp; KEYS</span>
      <div class="pcr-pills">
        <button type="button" data-call-pill="1" class="pcr-toggle ${call.active ? 'call' : (autoMute ? 'on' : '')}">${ico('phone-call', 10)} ${call.active ? 'Call Muted' : (autoMute ? 'AutoMute' : 'Mute Off')}</button>
        <button type="button" data-notif-pill="1" class="pcr-toggle ${notifMirror ? 'on' : ''}">${ico('bell', 10)} ${notifMirror ? 'Toast ON' : 'Toast Off'}</button>
      </div>
    </div>
    <div class="pcr-pad-row">
      <div class="pcr-pad" id="pcrTouchPad"><div class="pcr-pad-hint">Swipe to move · Tap = Left click</div></div>
      <div class="pcr-scroll-rail" id="pcrScrollRail">${ico('arrow-up', 10)}<span>SCR</span>${ico('arrow-down', 10)}</div>
    </div>
    <div class="pcr-click-row">
      <button type="button" class="btn sm" data-pclk="left">Left Click</button>
      <button type="button" class="btn sm" data-pclk="double">2x Click</button>
      <button type="button" class="btn sm" data-pclk="right">Right Click</button>
    </div>
    <form class="pcr-kbd-form" id="pcrTextForm">
      <input id="pcrTextInp" class="pcr-kbd-inp" placeholder="Type text to laptop...">
      <button type="submit" class="btn sm primary">${ico('send', 11)}</button>
    </form>
    <div class="pcr-keys">
      <button type="button" class="pcr-key" data-pkey="alt+tab">Alt+Tab</button>
      <button type="button" class="pcr-key" data-pkey="space">Space</button>
      <button type="button" class="pcr-key" data-pkey="enter">Enter</button>
      <button type="button" class="pcr-key" data-pkey="backspace">Bksp</button>
      <button type="button" class="pcr-key" data-pkey="esc">Esc</button>
      <button type="button" class="pcr-key" data-pkey="win+d">Win+D</button>
      <button type="button" class="pcr-key" data-pkey="left">${ico('arrow-left', 11)}</button>
      <button type="button" class="pcr-key" data-pkey="up">${ico('arrow-up', 11)}</button>
      <button type="button" class="pcr-key" data-pkey="down">${ico('arrow-down', 11)}</button>
      <button type="button" class="pcr-key" data-pkey="right">${ico('arrow-right', 11)}</button>
      <button type="button" class="pcr-key" data-pkey="media_play">${ico('play-pause', 11)}</button>
      <button type="button" class="pcr-key" data-pkey="vol_mute">${ico('volume-x', 11)}</button>
    </div>
  </div>`;

  body.querySelector('[data-call-pill]').onclick = () => { haptic(15); fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ call_auto_mute: autoMute ? '0' : '1' }) }); };
  body.querySelector('[data-notif-pill]').onclick = () => { haptic(15); fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ win_notif_mirror: notifMirror ? '0' : '1' }) }); };

  const pad = body.querySelector('#pcrTouchPad');
  let pActive = false, lastX = 0, lastY = 0, movedDist = 0;
  pad.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); pad.setPointerCapture(e.pointerId); pActive = true; lastX = e.clientX; lastY = e.clientY; movedDist = 0; };
  pad.onpointermove = (e) => {
    if (!pActive) return;
    e.stopPropagation();
    const dx = (e.clientX - lastX) * 2.1, dy = (e.clientY - lastY) * 2.1;
    lastX = e.clientX; lastY = e.clientY; movedDist += Math.hypot(dx, dy); queuePcCursorMove(dx, dy);
  };
  const endPad = (cancel) => { if (!pActive) return; pActive = false; if (!cancel && movedDist < 7) { haptic(12); sendPcInput({ op: 'click', button: 'left' }); } };
  pad.onpointerup = () => endPad(false);
  pad.onpointercancel = () => endPad(true);

  const rail = body.querySelector('#pcrScrollRail');
  let sActive = false, sLastY = 0, sAcc = 0;
  rail.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); rail.setPointerCapture(e.pointerId); sActive = true; sLastY = e.clientY; sAcc = 0; };
  rail.onpointermove = (e) => {
    if (!sActive) return;
    e.stopPropagation();
    sAcc += (sLastY - e.clientY) * 5; sLastY = e.clientY;
    if (Math.abs(sAcc) >= 60) { const step = Math.round(sAcc); sAcc = 0; sendPcInput({ op: 'scroll', dy: step }); }
  };
  rail.onpointerup = () => { sActive = false; };
  rail.onpointercancel = () => { sActive = false; };

  body.querySelectorAll('[data-pclk]').forEach(b => { b.onclick = () => { haptic(15); sendPcInput({ op: 'click', button: b.dataset.pclk }); }; });
  body.querySelectorAll('[data-pkey]').forEach(b => { b.onclick = () => { haptic(12); sendPcInput({ op: 'key', combo: b.dataset.pkey }); }; });
  const form = body.querySelector('#pcrTextForm'), inp = body.querySelector('#pcrTextInp');
  form.onsubmit = (e) => { e.preventDefault(); const txt = inp.value; if (!txt) return; haptic(15); inp.value = ''; sendPcInput({ op: 'text', text: txt }); };
}

export function renderPcScreenWidget(body) {
  const meta = store.state?.laptopScreen || {};
  const ts = Number(meta.ts || 0);
  const existingImg = body.querySelector('[data-pc-screen-img]');
  const bindScreenHandlers = (root) => {
    const img = root.querySelector('[data-pc-screen-img]');
    if (img) {
      img.onclick = (e) => {
        const rect = img.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const rx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const ry = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        haptic(18);
        sendPcInput({ op: 'abs_click', rx, ry, button: 'left' });
        if (!pcScreenLive) setTimeout(() => fetch('/api/laptop/screen/request', { method: 'POST', body: '{}' }).catch(() => {}), 220);
      };
    }
  };
  if (existingImg) {
    const liveBtn = body.querySelector('[data-scr-live]');
    if (liveBtn) { liveBtn.className = `pcr-toggle ${pcScreenLive ? 'on' : ''}`; liveBtn.textContent = pcScreenLive ? 'Live ON' : 'Live'; }
    const szEl = body.querySelector('[data-scr-res]');
    if (szEl && meta.w > 0) szEl.textContent = `${meta.w}×${meta.h}`;
    return;
  }

  body.innerHTML = `<div class="pcr-wrap">
    <div class="pcr-head">
      <span class="pcr-title">${ico('monitor', 12)} LIVE SCREEN PEEK</span>
      <div class="pcr-pills">
        <span data-scr-res="1" class="sub-muted" style="margin:0;font-size:10px">${meta.w > 0 ? `${meta.w}×${meta.h}` : ''}</span>
        <button type="button" class="pcr-toggle ${pcScreenLive ? 'on' : ''}" data-scr-live="1">${pcScreenLive ? 'Live ON' : 'Live'}</button>
        <button type="button" class="btn sm" data-scr-snap="1">${ico('refresh', 11)} Peek</button>
        <button type="button" class="btn sm" data-scr-zoom="1">${ico('maximize-2', 11)}</button>
        <button type="button" class="btn sm" data-cam-toggle="1">${ico('video', 11)} Cam</button>
      </div>
    </div>
    <div class="pcs-stage">
      ${ts > 0 ? `<img data-pc-screen-img="1" src="/api/laptop/screen?t=${ts}" alt="Laptop screen"><span class="pcs-overlay-tip">Tap screen to click PC</span>`
        : `<div class="hw-empty" style="border:0">Tap Peek or Live to view laptop screen</div>`}
    </div>
    <div id="camStage" class="pcs-stage" style="display:none;padding:0">
      <img id="camFeed" src="" alt="Phone Camera" style="width:100%;border-radius:10px;display:block">
      <div style="font-size:10px;color:var(--muted);padding:4px 6px;text-align:right" id="camObsUrl"></div>
    </div>
  </div>`;

  body.querySelector('[data-scr-snap]').onclick = () => { haptic(15); fetch('/api/laptop/screen/request', { method: 'POST', body: '{}' }).catch(() => {}); };
  body.querySelector('[data-scr-live]').onclick = () => { haptic(15); pcScreenLive = !pcScreenLive; syncPcScreenLoop(); renderPcScreenWidget(body); };
  body.querySelector('[data-scr-zoom]').onclick = () => {
    const curTs = Number(store.state?.laptopScreen?.ts || Date.now());
    openDetailModal({
      title: 'Laptop Screen (Tap to Click)',
      bodyHtml: `<div class="pcs-stage" style="height:56vh"><img data-pc-screen-img="1" src="/api/laptop/screen?t=${curTs}" alt="Laptop screen"></div>`,
      actionsHtml: `<button type="button" class="btn sm" id="zoomSnap">Refresh</button><button type="button" class="btn sm primary" id="zoomClose">Done</button>`,
      onBind: (m) => {
        bindScreenHandlers(m);
        m.querySelector('#zoomSnap').onclick = () => fetch('/api/laptop/screen/request', { method: 'POST', body: '{}' }).catch(() => {});
        m.querySelector('#zoomClose').onclick = () => { m.hidden = true; };
      }
    });
  };
  bindScreenHandlers(body);

  // Camera toggle
  let camRunning = false;
  body.querySelector('[data-cam-toggle]').onclick = async () => {
    haptic(15);
    if (!camRunning) {
      camRunning = true;
      const btn = body.querySelector('[data-cam-toggle]');
      btn.classList.add('on');
      const facing = 'back';
      await fetch(`/api/camera/start?facing=${facing}`, { method: 'POST' }).catch(() => {});
      const stage = body.querySelector('#camStage');
      const feed = body.querySelector('#camFeed');
      const obsDiv = body.querySelector('#camObsUrl');
      if (stage && feed) {
        feed.src = `/api/camera.mjpeg?t=${Date.now()}`;
        stage.style.display = 'block';
        const origin = (store.state?.telemetry?.url || location.origin).replace(/\/r\/?$/, '');
        if (obsDiv) obsDiv.textContent = `OBS: ${origin}/api/camera.mjpeg`;
      }
    } else {
      camRunning = false;
      const btn = body.querySelector('[data-cam-toggle]');
      btn?.classList.remove('on');
      await fetch('/api/camera/stop', { method: 'POST' }).catch(() => {});
      const stage = body.querySelector('#camStage');
      const feed = body.querySelector('#camFeed');
      if (stage) stage.style.display = 'none';
      if (feed) feed.src = '';
    }
  };
}

function getDefaultDeckFolders() {
  return [
    {
      name: 'Apps & Power',
      tiles: [
        { label: 'Terminal', icon: 'terminal', tone: 'slate', kind: 'app', appId: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App', proc: 'WindowsTerminal' },
        { label: 'VS Code', icon: 'code', tone: 'blue', kind: 'app', appId: 'Microsoft.VisualStudioCode', proc: 'Code' },
        { label: 'Browser', icon: 'globe', tone: 'cyan', kind: 'app', appId: 'Chrome', proc: 'chrome' },
        { label: 'Files', icon: 'folder', tone: 'amber', kind: 'app', appId: 'Microsoft.Windows.Explorer', proc: 'explorer' },
        { label: 'Notepad', icon: 'clipboard', tone: 'teal', kind: 'app', appId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', proc: 'Notepad' },
        { label: 'Calculator', icon: 'grid', tone: 'violet', kind: 'app', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', proc: 'CalculatorApp' },
        { label: 'Snip', icon: 'scissors', tone: 'teal', kind: 'sys', act: 'snip' },
        { label: 'Task Mgr', icon: 'bar-chart', tone: 'emerald', kind: 'sys', act: 'taskmgr' },
        { label: 'Mute', icon: 'volume-x', tone: 'amber', kind: 'mute', op: 'toggle_mute' },
        { label: 'Screen Off', icon: 'moon', tone: 'purple', kind: 'sys', act: 'screen_off' },
        { label: 'Lock', icon: 'lock', tone: 'red', kind: 'lock', act: 'lock' },
        { label: 'Settings', icon: 'settings', tone: 'slate', kind: 'app', appId: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel', proc: 'SystemSettings' }
      ]
    },
    {
      name: 'Workspace & Keys',
      tiles: [
        { label: 'Edge', icon: 'globe', tone: 'blue', kind: 'app', appId: 'MSEdge', proc: 'msedge' },
        { label: 'VLC Player', icon: 'play', tone: 'amber', kind: 'app', appId: '{6D809377-6AF0-444B-8957-A3773F02200E}\\VideoLAN\\VLC\\vlc.exe', proc: 'vlc' },
        { label: 'Antigravity', icon: 'zap', tone: 'emerald', kind: 'app', appId: 'Google.AntigravityIDE', proc: 'Antigravity IDE' },
        { label: 'Alt+Tab', icon: 'layers', tone: 'cyan', kind: 'key', combo: 'alt+tab' },
        { label: 'Show Desk', icon: 'monitor', tone: 'purple', kind: 'key', combo: 'win+d' },
        { label: 'Copy', icon: 'copy', tone: 'teal', kind: 'key', combo: 'ctrl+c' },
        { label: 'Paste', icon: 'clipboard', tone: 'emerald', kind: 'key', combo: 'ctrl+v' },
        { label: 'Undo', icon: 'arrow-left', tone: 'amber', kind: 'key', combo: 'ctrl+z' },
        { label: 'Close Tab', icon: 'x', tone: 'red', kind: 'key', combo: 'ctrl+w' },
        { label: 'Play/Pause', icon: 'play-pause', tone: 'emerald', kind: 'key', combo: 'media_play' },
        { label: 'Prev Track', icon: 'skip-back', tone: 'slate', kind: 'key', combo: 'media_prev' },
        { label: 'Next Track', icon: 'skip-forward', tone: 'blue', kind: 'key', combo: 'media_next' }
      ]
    }
  ];
}

function getDeckFolders() {
  try {
    const raw = store.state?.settings?.laptop_deck;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.folders) && parsed.folders.length) return parsed.folders;
    }
  } catch (_) {}
  return getDefaultDeckFolders();
}

function executeDeckTile(tile, forceNew = false) {
  haptic(18);
  if (tile.kind === 'lock') {
    const now = Date.now();
    if (now > lockArmUntil) { lockArmUntil = now + 3000; showToast('Safety Guard', 'Tap Lock again within 3s to lock PC', 2500); return false; }
    lockArmUntil = 0; sendPcInput({ op: 'system_act', act: 'lock' }); return true;
  }
  if (tile.kind === 'mute') { sendPcInput({ op: 'toggle_mute' }); return true; }
  if (tile.kind === 'sys') { sendPcInput({ op: 'system_act', act: tile.act }); return true; }
  if (tile.kind === 'key') { sendPcInput({ op: 'key', combo: tile.combo }); return true; }
  if (tile.kind === 'app' || tile.kind === 'uri') {
    sendPcInput({ op: 'launch_app', appId: tile.appId || '', uri: tile.uri || '', proc: tile.proc || '', forceNew });
    return true;
  }
  return false;
}

async function openDeckTileEditorModal(folders, folderIdx, tileIdx) {
  if (!cachedLaptopApps.length) {
    const r = await fetch('/api/laptop/apps').then(x => x.json()).catch(() => ({}));
    cachedLaptopApps = Array.isArray(r.apps) ? r.apps : [];
  }
  const folder = folders[folderIdx];
  const existing = tileIdx >= 0 ? folder.tiles[tileIdx] : { label: '', icon: 'terminal', tone: 'blue', kind: 'app', appId: '', proc: '' };
  openDetailModal({
    title: tileIdx >= 0 ? `Customize "${existing.label}"` : 'Pin App / Action to Deck',
    bodyHtml: `
      <div class="detail-kv" style="margin-bottom:6px">
        <div class="detail-row"><span>Label</span><span><input id="dkLbl" class="inp" style="padding:3px 7px;font-size:11px" value="${esc(existing.label)}"></span></div>
        <div class="detail-row"><span>Tone</span><span><select id="dkTone" class="inp" style="padding:3px 7px;font-size:11px">${Object.keys(DECK_TONES).map(k => `<option value="${k}" ${existing.tone === k ? 'selected' : ''}>${k}</option>`).join('')}</select></span></div>
        <div class="detail-row"><span>Action / URL</span><span><input id="dkUri" class="inp" style="padding:3px 7px;font-size:11px" value="${esc(existing.appId || existing.uri || '')}" placeholder="AppID or https://..."></span></div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <input id="dkAppSearch" class="inp" style="padding:5px 8px;font-size:11px" placeholder="Search ${cachedLaptopApps.length} installed laptop apps...">
        <button type="button" class="btn sm" id="dkRescan">${ico('refresh', 11)}</button>
      </div>
      <div class="deck-app-pick" id="dkAppList"></div>`,
    actionsHtml: `${tileIdx >= 0 && existing.kind === 'app' ? `<button type="button" class="btn sm" id="dkNewWin">Open New</button>` : ''}<button type="button" class="btn sm" id="dkResetAll">Reset Deck</button><button type="button" class="btn sm primary" id="dkSaveTile">Save Tile</button>`,
    onBind: (modal) => {
      const renderApps = (q = '') => {
        const listEl = modal.querySelector('#dkAppList');
        const qq = q.trim().toLowerCase();
        const filtered = cachedLaptopApps.filter(a => !qq || a.name.toLowerCase().includes(qq)).slice(0, 40);
        listEl.innerHTML = filtered.length
          ? filtered.map(a => `<button type="button" class="row-item" style="width:100%;cursor:pointer;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;color:var(--text)" data-pick-id="${esc(a.appId)}" data-pick-nm="${esc(a.name)}"><span>${esc(a.name)}</span><small style="color:var(--muted)">Pin</small></button>`).join('')
          : `<div class="sub-muted">${cachedLaptopApps.length ? 'No matching apps' : 'Tap Refresh to scan laptop apps'}</div>`;
        listEl.querySelectorAll('[data-pick-id]').forEach(btn => {
          btn.onclick = () => { modal.querySelector('#dkLbl').value = btn.dataset.pickNm; modal.querySelector('#dkUri').value = btn.dataset.pickId; haptic(12); };
        });
      };
      renderApps();
      modal.querySelector('#dkAppSearch').oninput = (e) => renderApps(e.target.value);
      modal.querySelector('#dkRescan').onclick = async () => {
        await sendPcInput({ op: 'scan_apps' }); showToast('Scanning Apps', 'Scanning installed laptop apps...');
        setTimeout(async () => {
          const r = await fetch('/api/laptop/apps').then(x => x.json()).catch(() => ({}));
          cachedLaptopApps = Array.isArray(r.apps) ? r.apps : [];
          renderApps(modal.querySelector('#dkAppSearch').value);
        }, 1800);
      };
      const nw = modal.querySelector('#dkNewWin');
      if (nw) nw.onclick = () => { modal.hidden = true; executeDeckTile(existing, true); };
      modal.querySelector('#dkResetAll').onclick = async () => { await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ laptop_deck: '' }) }); modal.hidden = true; showToast('Deck Reset', 'Restored default tiles'); };
      modal.querySelector('#dkSaveTile').onclick = async () => {
        const lbl = modal.querySelector('#dkLbl').value.trim() || 'App';
        const tone = modal.querySelector('#dkTone').value || 'blue';
        const targetVal = modal.querySelector('#dkUri').value.trim();
        const isUrl = /^https?:\/\//i.test(targetVal);
        const updated = { ...existing, label: lbl, tone, kind: isUrl ? 'uri' : (existing.kind && !targetVal ? existing.kind : 'app'), icon: isUrl ? 'external-link' : (existing.icon || 'grid'), appId: isUrl ? '' : targetVal, uri: isUrl ? targetVal : '' };
        if (tileIdx >= 0) folder.tiles[tileIdx] = updated;
        else if (folder.tiles.length < 12) folder.tiles.push(updated);
        else folder.tiles[11] = updated;
        await fetch('/api/laptop/deck', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folders }) });
        modal.hidden = true; haptic(20);
      };
    }
  });
}

export function renderPcDeckWidget(body) {
  const folders = getDeckFolders();
  if (selectedDeckFolderIdx >= folders.length) selectedDeckFolderIdx = 0;
  const folder = folders[selectedDeckFolderIdx];
  const ctrl = store.state?.laptop?.control || {};
  const openWins = Array.isArray(ctrl.wins) ? ctrl.wins : [];
  const procs = store.state?.laptop?.processes || {};
  const bgProcs = new Set([...(procs.byRam || []), ...(procs.byCpu || [])].map(p => String(p.processName || '').toLowerCase()));
  const openProcs = new Set(openWins.map(w => String(w.proc || '').toLowerCase()));
  let activeCount = 0;
  const tilesHtml = (folder.tiles || []).slice(0, 12).map((tile, idx) => {
    const tone = DECK_TONES[tile.tone] || DECK_TONES.slate;
    const procL = String(tile.proc || '').toLowerCase();
    const isMutedTile = tile.kind === 'mute' && Boolean(ctrl.muted);
    const isWinOpen = Boolean(procL && openProcs.has(procL));
    const isBgRun = Boolean(procL && !isWinOpen && bgProcs.has(procL));
    if (isWinOpen) activeCount++;
    const lockArmed = tile.kind === 'lock' && Date.now() <= lockArmUntil;
    const dotCls = isMutedTile ? 'on' : (isWinOpen ? 'run' : (isBgRun ? 'bg' : ''));
    return `<button type="button" class="deck-tile ${isMutedTile ? 'on' : ''} ${lockArmed ? 'armed' : ''}" data-didx="${idx}" style="--dt-bg:${tone.bg};--dt-bd:${tone.bd};--dt-ic:${tone.ic}">
      <span class="deck-dot ${dotCls}"></span><span class="deck-ico">${ico(tile.icon || 'grid', 21)}</span>
      <span class="deck-lbl">${esc(lockArmed ? 'Tap to Lock' : tile.label)}</span>
    </button>`;
  }).join('');

  body.innerHTML = `<div class="deck-shell">
    <div class="deck-top">
      <div class="deck-tabs">${folders.map((f, i) => `<button type="button" class="deck-tab ${i === selectedDeckFolderIdx ? 'active' : ''}" data-dfold="${i}">${esc(f.name)}</button>`).join('')}</div>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="sub-muted" style="margin:0;font-size:10px">${openWins.length} windows · ${activeCount} open</span>
        <button type="button" class="btn sm" data-dadd="1">${ico('plus', 11)} Customize</button>
      </div>
    </div>
    <div class="deck-grid">${tilesHtml}</div>
  </div>`;

  body.querySelectorAll('[data-dfold]').forEach(b => { b.onclick = () => { haptic(12); selectedDeckFolderIdx = Number(b.dataset.dfold); renderPcDeckWidget(body); }; });
  body.querySelector('[data-dadd]').onclick = () => openDeckTileEditorModal(folders, selectedDeckFolderIdx, -1);
  body.querySelectorAll('[data-didx]').forEach(btn => {
    const idx = Number(btn.dataset.didx), tile = folder.tiles[idx];
    let holdTimer = null, didHold = false;
    btn.onpointerdown = () => { didHold = false; holdTimer = setTimeout(() => { didHold = true; haptic(25); openDeckTileEditorModal(folders, selectedDeckFolderIdx, idx); }, 480); };
    btn.onpointerup = btn.onpointercancel = () => clearTimeout(holdTimer);
    btn.oncontextmenu = (e) => { e.preventDefault(); clearTimeout(holdTimer); openDeckTileEditorModal(folders, selectedDeckFolderIdx, idx); };
    btn.onclick = () => { if (!didHold) { executeDeckTile(tile, false); renderPcDeckWidget(body); } };
  });
}

export function renderPcDisplayWidget(body) {
  const ctrl = store.state?.laptop?.control || {};
  const hasBright = typeof ctrl.bright === 'number' && ctrl.bright >= 0;
  const bright = hasBright ? ctrl.bright : 0;
  const clipAuto = store.state?.settings?.clip_auto_sync !== '0';
  const proxLock = store.state?.settings?.presence_auto_lock === '1';
  if (body.querySelector('[data-pc-br]') && Date.now() < store.brightDragLockUntil) return;

  body.innerHTML = `<div class="pcd-wrap">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:4px;flex-wrap:wrap">
      <span class="wx-title">DISPLAY BRIGHTNESS</span>
      <div class="pcr-pills">
        <button type="button" class="pcr-toggle ${proxLock ? 'on' : ''}" data-prox-lock="1" title="Auto-Lock PC when phone leaves desk LAN/BT">${ico('lock', 10)} ${proxLock ? 'Auto-Lock' : 'Walk-Away'}</button>
        <button type="button" class="pcr-toggle ${clipAuto ? 'on' : ''}" data-clip-sync="1">${ico('clipboard', 10)} ${clipAuto ? 'Clip ON' : 'Clip Off'}</button>
      </div>
    </div>
    <div class="pcd-bright-box">
      <span class="pcd-bright-num" data-pc-br-lbl="1">${hasBright ? bright : '--'}</span>
      <input type="range" min="0" max="100" value="${bright}" ${hasBright ? '' : 'disabled'} class="pcm-range" data-pc-br="1">
    </div>
    <div class="wx-title" style="margin-top:4px">QUICK SCENE PROFILES</div>
    <div class="pcd-prof-row">
      <button type="button" class="btn sm" data-prof="music">Music</button>
      <button type="button" class="btn sm" data-prof="meeting">Meeting</button>
      <button type="button" class="btn sm" data-prof="night">Night</button>
      <button type="button" class="btn sm" data-prof="coding">Coding</button>
    </div>
    <div class="pcd-clip-row">
      <button type="button" class="btn sm" style="flex:1" data-pc-open-url="1">${ico('external-link', 11)} Open URL on PC</button>
      <button type="button" class="btn sm primary" style="flex:1" data-pc-paste="1">${ico('clipboard', 11)} Paste Latest to PC</button>
    </div>
  </div>`;

  const br = body.querySelector('[data-pc-br]'), bLbl = body.querySelector('[data-pc-br-lbl]');
  br.oninput = (e) => { store.brightDragLockUntil = Date.now() + 1800; bLbl.textContent = e.target.value; };
  br.onchange = (e) => { store.brightDragLockUntil = Date.now() + 1200; sendPcInput({ op: 'set_bright', pct: Number(e.target.value) }); };
  body.querySelectorAll('[data-prof]').forEach(b => { b.onclick = () => { haptic(18); sendPcInput({ op: 'profile', name: b.dataset.prof }); showToast('Profile Applied', b.textContent); }; });
  body.querySelector('[data-clip-sync]').onclick = () => { haptic(15); fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clip_auto_sync: clipAuto ? '0' : '1' }) }); };
  body.querySelector('[data-prox-lock]').onclick = () => {
    haptic(15);
    const next = proxLock ? '0' : '1';
    fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ presence_auto_lock: next }) });
    showToast('Walk-Away Security', next === '1' ? 'PC will auto-lock when phone leaves desk LAN' : 'Proximity auto-lock disabled');
  };
  body.querySelector('[data-pc-paste]').onclick = async () => {
    const latest = store.state?.clipboard?.[0]?.content;
    if (!latest) return showToast('Clipboard Empty', 'Add text in Clipboard Vault first');
    haptic(15); await sendPcInput({ op: 'set_clip', text: latest });
    setTimeout(() => sendPcInput({ op: 'key', combo: 'ctrl+v' }), 90);
    showToast('Pasted to PC', latest.slice(0, 50));
  };
  body.querySelector('[data-pc-open-url]').onclick = () => {
    openDetailModal({
      title: 'Open URL on Laptop Browser',
      bodyHtml: `<input id="pcUrlInp" class="inp" value="https://" placeholder="https://example.com">`,
      actionsHtml: `<button type="button" class="btn sm" id="pcUrlCancel">Cancel</button><button type="button" class="btn sm primary" id="pcUrlGo">Open on PC</button>`,
      onBind: (m) => {
        const inp = m.querySelector('#pcUrlInp'); setTimeout(() => inp.focus(), 60);
        m.querySelector('#pcUrlCancel').onclick = () => { m.hidden = true; };
        m.querySelector('#pcUrlGo').onclick = () => { const u = inp.value.trim(); if (u) { sendPcInput({ op: 'launch_app', uri: /^https?:\/\//i.test(u) ? u : `https://${u}` }); m.hidden = true; } };
      }
    });
  };
}

export function renderPcWindowsWidget(body) {
  const wins = Array.isArray(store.state?.laptop?.control?.wins) ? store.state.laptop.control.wins : [];
  body.innerHTML = `<div class="pcw-wrap">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex:0 0 auto">
      <span class="wx-title">OPEN WINDOWS (${wins.length})</span>
      <div style="display:flex;gap:5px">
        <button type="button" class="btn sm" data-wkey="alt+tab">Alt+Tab</button>
        <button type="button" class="btn sm" data-wkey="win+d">Show Desktop</button>
      </div>
    </div>
    <div class="pcw-list">
      ${wins.length ? wins.map(w => `<div class="pcw-item ${w.active ? 'active' : ''}">
        <div class="pcw-info" data-wact="focus" data-hwnd="${w.hwnd}"><b>${esc(w.title)}</b><small>${esc(w.proc)}${w.minimized ? ' · minimized' : ''}</small></div>
        <div class="pcw-acts">
          <button type="button" data-wact="snap_left" data-hwnd="${w.hwnd}" title="Snap Left">L</button>
          <button type="button" data-wact="snap_right" data-hwnd="${w.hwnd}" title="Snap Right">R</button>
          <button type="button" data-wact="min" data-hwnd="${w.hwnd}" title="Minimize">_</button>
          <button type="button" class="cls" data-wact="close" data-hwnd="${w.hwnd}" title="Close">×</button>
        </div>
      </div>`).join('') : '<div class="hw-empty" style="grid-column:1/-1">No visible windows reported yet</div>'}
    </div>
  </div>`;
  body.querySelectorAll('[data-wkey]').forEach(b => { b.onclick = () => { haptic(12); sendPcInput({ op: 'key', combo: b.dataset.wkey }); }; });
  body.querySelectorAll('[data-wact]').forEach(el => { el.onclick = () => { haptic(14); sendPcInput({ op: 'win_act', hwnd: Number(el.dataset.hwnd), act: el.dataset.wact }); }; });
}
