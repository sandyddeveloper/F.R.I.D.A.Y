import { ico, hydrateIcons } from '/shared/icons.js';
import { store, haptic, esc, showToast, classifyPageGroup } from './lib/core.js';
import { renderHardwareMonitorGrid } from './widgets/hardware.js';
import { renderPcMusicPlayerWidget, renderPcAudioStageWidget, tickMusicProgress } from './widgets/music.js';
import { renderMobileWidget, openConnectGuideModal } from './widgets/mobile.js';
import {
  renderLaptopProcessesWidget, renderPcTrackpadWidget, renderPcScreenWidget,
  renderPcDeckWidget, renderPcDisplayWidget, renderPcWindowsWidget
} from './widgets/laptop.js';
import {
  checkPendingAgyModal, renderAntigravityWidget, renderAgyPermissionsWidget,
  renderAgyCodeWidget, renderAgyControlWidget
} from './widgets/agy.js';

hydrateIcons();

const pager = document.getElementById('pager');
const dots = document.getElementById('dots');
const pageTitle = document.getElementById('pageTitle');
const pageBadge = document.getElementById('pageGroupBadge');
const connDot = document.getElementById('connDot');
const ipBadge = document.getElementById('ipBadge');
const pairBadge = document.getElementById('pairBadge');
const overview = document.getElementById('overview');
const ovMobList = document.getElementById('ovMobList');
const ovLapList = document.getElementById('ovLapList');
const ovPairSummary = document.getElementById('ovPairSummary');
const ovAdminHint = document.getElementById('ovAdminHint');
const nightCurtain = document.getElementById('nightCurtain');
const nightClock = document.getElementById('nightClock');

let lastPagesSig = '';
let dismissedPairId = '';

const FLUSH_TYPES = new Set([
  'world_strip', 'world_clock', 'hourly_weather', 'weather', 'calendar_month',
  'pc_trackpad', 'pc_screen', 'pc_display', 'pc_windows',
  'pc_music_player', 'pc_audio_stage', 'pc_media', 'pc_audio'
]);

const HW_FULL_TYPES = new Set(['laptop_monitor', 'phone_monitor', 'laptop_processes', 'pc_deck']);

function applyTheme() {
  const s = store.state?.settings || {};
  document.body.className = 'theme-' + (s.theme || 'glass');
  const root = document.documentElement.style;
  if (s.accent) root.setProperty('--accent', s.accent);
  if (s.card_radius) root.setProperty('--radius', s.card_radius + 'px');
  if (s.grid_gap) root.setProperty('--gap', s.grid_gap + 'px');
}

function gotoPageIndex(idx, smooth = true) {
  const pages = store.state?.pages || [];
  if (!pages.length) return;
  store.currentPageIdx = Math.max(0, Math.min(pages.length - 1, idx));
  pager.scrollTo({ left: store.currentPageIdx * pager.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
  updateNavHeader();
}

store.onNavigatePage = gotoPageIndex;
store.onRerender = renderWidgets;

window.pbStepPage = (delta) => {
  const pages = store.state?.pages || [];
  if (!pages.length) return;
  gotoPageIndex((store.currentPageIdx + delta + pages.length) % pages.length, true);
  haptic(15);
};

window.pbHandleBack = () => {
  if (!nightCurtain.hidden) { nightCurtain.hidden = true; return true; }
  if (!overview.hidden) { overview.hidden = true; return true; }
  for (const id of ['pairModal', 'noteModal', 'taskModal', 'clipModal', 'agyPermModal', 'agyDiffModal', 'detailModal']) {
    const el = document.getElementById(id);
    if (el && !el.hidden) { el.hidden = true; return true; }
  }
  return false;
};

function updateNavHeader() {
  const pages = store.state?.pages || [];
  const active = pages[store.currentPageIdx];
  pageTitle.textContent = active ? active.title : 'F.R.I.D.A.Y.';
  const grp = classifyPageGroup(active);
  if (pageBadge) {
    pageBadge.textContent = grp === 'laptop' ? 'LAPTOP' : 'MOBILE';
    pageBadge.className = `tb-grp ${grp}`;
  }
  [...dots.children].forEach((d, i) => d.classList.toggle('active', i === store.currentPageIdx));
}

pager.addEventListener('scroll', () => {
  if (!pager.clientWidth) return;
  const idx = Math.round(pager.scrollLeft / pager.clientWidth);
  if (idx !== store.currentPageIdx) { store.currentPageIdx = idx; updateNavHeader(); }
});

document.getElementById('btnOverview').onclick = () => { renderOverview(); overview.hidden = false; };
document.getElementById('ovClose').onclick = () => { overview.hidden = true; };
document.getElementById('btnNight').onclick = () => { nightCurtain.hidden = false; updateClocks(); };
nightCurtain.onclick = () => { nightCurtain.hidden = true; };
if (pairBadge) pairBadge.onclick = openConnectGuideModal;

function renderOverview() {
  const s = store.state || {};
  const pages = s.pages || [];
  const lap = s.laptop || {};
  const paired = Array.isArray(s.pairedDevices) ? s.pairedDevices : [];
  const relay = s.relay || {};
  const lapLive = Boolean(lap.sampledAt && (Date.now() - Number(lap.updatedAt || lap.sampledAt || 0) < 15000));

  const renderCard = (p, idx) => `<button class="ov-card ${idx === store.currentPageIdx ? 'active' : ''}" data-idx="${idx}">
    <span class="ov-card-top"><b>${esc(p.title)}</b><span class="ov-dot ${classifyPageGroup(p) === 'laptop' ? (lapLive ? 'ok' : 'idle') : 'ok'}"></span></span>
    <small>${(p.widgets || []).length} widget${(p.widgets || []).length === 1 ? '' : 's'}</small>
  </button>`;

  const mobItems = [], lapItems = [];
  pages.forEach((p, idx) => {
    if (classifyPageGroup(p) === 'laptop') lapItems.push(renderCard(p, idx));
    else mobItems.push(renderCard(p, idx));
  });

  ovMobList.innerHTML = mobItems.join('');
  ovLapList.innerHTML = lapItems.join('');
  overview.querySelectorAll('.ov-card').forEach(btn => {
    btn.onclick = () => { overview.hidden = true; gotoPageIndex(Number(btn.dataset.idx)); haptic(15); };
  });

  if (ovPairSummary) {
    ovPairSummary.innerHTML = `
      <span class="badge ${paired.length ? 'ok' : 'warn'}">${paired.length} Paired Laptop${paired.length === 1 ? '' : 's'}</span>
      ${relay.enabled ? `<span class="badge ${relay.connected ? 'ok' : 'warn'}">Relay ${relay.connected ? 'Online' : 'Connecting'}</span>` : ''}
      <button type="button" class="btn sm" id="ovOpenPairBtn">${ico('shield', 12)} Pair &amp; Security</button>
    `;
    ovPairSummary.querySelector('#ovOpenPairBtn').onclick = () => { overview.hidden = true; openConnectGuideModal(); };
  }
  ovAdminHint.textContent = 'Admin Studio: ' + (s.telemetry?.adminUrl || 'http://127.0.0.1:8765/admin/');
}

function buildLayout() {
  const s = store.state;
  const pages = s.pages || [];
  const isPortrait = window.innerHeight > window.innerWidth;
  const sig = (isPortrait ? 'P|' : 'L|') + pages.map(p => p.id + ':' + p.title + ':' + JSON.stringify(p.widgets)).join('|');
  if (sig === lastPagesSig) return;
  lastPagesSig = sig;

  pager.innerHTML = '';
  dots.innerHTML = '';

  pages.forEach((p, idx) => {
    const pageEl = document.createElement('section');
    pageEl.className = 'page';
    pageEl.dataset.pageId = p.id;

    (p.widgets || []).forEach(w => {
      const card = document.createElement('article');
      const isHw = HW_FULL_TYPES.has(w.type);
      const isFlush = FLUSH_TYPES.has(w.type);
      card.className = 'card' + (isHw ? ' card-hw' : (isFlush ? ' card-flush' : ''));
      card.dataset.wid = w.id;
      card.dataset.wtype = w.type;

      if (isPortrait) {
        const isAgy = w.type === 'antigravity' || w.type.startsWith('agy_');
        const isRemote = w.type === 'pc_trackpad' || w.type === 'pc_screen';
        const isMusic = w.type === 'pc_music_player' || w.type === 'pc_audio_stage';
        const isHeroWide = w.type === 'clock' || w.type === 'connect_qr' || w.type === 'server_qr';
        const isFullRow = isHw || isFlush || isAgy || isRemote || isMusic || isHeroWide
          || w.type === 'timer' || w.type === 'pc_display' || w.type === 'pc_windows'
          || (w.w || 4) >= 6;
        const spanCol = isFullRow ? 6 : 3;
        const spanRow = isHw ? 8 : (isRemote || isMusic ? 5 : (isAgy ? 4 : (isHeroWide ? 2 : Math.max(2, Math.round((w.h || 3) * 0.85)))));
        card.style.gridColumn = `span ${spanCol}`;
        card.style.gridRow = `span ${spanRow}`;
      } else {
        card.style.gridColumn = `${(w.x || 0) + 1} / span ${w.w || 4}`;
        card.style.gridRow = `${(w.y || 0) + 1} / span ${w.h || 3}`;
      }
      card.innerHTML = `<div class="card-head"><span>${esc(w.title || w.type)}</span><span class="w-tag"></span></div><div class="card-body"></div>`;
      pageEl.appendChild(card);
    });

    pager.appendChild(pageEl);
    const dot = document.createElement('span');
    dot.className = 'pdot' + (idx === store.currentPageIdx ? ' active' : '');
    dot.onclick = () => gotoPageIndex(idx);
    dots.appendChild(dot);
  });

  if (store.currentPageIdx >= pages.length) store.currentPageIdx = 0;
  gotoPageIndex(store.currentPageIdx, false);
}

function renderWidgets() {
  const s = store.state;
  if (!s) return;
  const t = s.telemetry || {};
  ipBadge.textContent = t.wifiConnected && t.ip ? `${t.ip}:${t.port}` : `127.0.0.1:${t.port || 8765}`;

  const paired = Array.isArray(s.pairedDevices) ? s.pairedDevices : [];
  if (pairBadge) {
    const lapOnline = Boolean(s.laptop?.sampledAt && (Date.now() - Number(s.laptop?.updatedAt || s.laptop?.sampledAt || 0) < 15000));
    pairBadge.textContent = paired.length ? (lapOnline ? 'PC Linked' : `${paired.length} Paired`) : 'Pair PC';
    pairBadge.className = `chip ${lapOnline ? 'chip-ok' : (paired.length ? '' : 'chip-warn')}`;
  }

  document.querySelectorAll('.card').forEach(card => {
    const type = card.dataset.wtype;
    const wid = card.dataset.wid;
    const pageId = card.closest('.page')?.dataset.pageId;
    const page = (s.pages || []).find(p => p.id === pageId);
    const wCfg = (page?.widgets || []).find(w => w.id === wid) || { opts: {} };
    const body = card.querySelector('.card-body');
    const tag = card.querySelector('.w-tag');
    body.className = 'card-body';

    if (type === 'laptop_monitor') renderHardwareMonitorGrid(body, 'laptop');
    else if (type === 'phone_monitor') renderHardwareMonitorGrid(body, 'phone');
    else if (type === 'pc_music_player' || type === 'pc_media') renderPcMusicPlayerWidget(body);
    else if (type === 'pc_audio_stage' || type === 'pc_audio') renderPcAudioStageWidget(body);
    else if (type === 'laptop_processes') renderLaptopProcessesWidget(body);
    else if (type === 'pc_trackpad') renderPcTrackpadWidget(body);
    else if (type === 'pc_screen') renderPcScreenWidget(body);
    else if (type === 'pc_deck') renderPcDeckWidget(body);
    else if (type === 'pc_display') renderPcDisplayWidget(body);
    else if (type === 'pc_windows') renderPcWindowsWidget(body);
    else if (type === 'antigravity') renderAntigravityWidget(body, tag);
    else if (type === 'agy_permissions') renderAgyPermissionsWidget(body, tag);
    else if (type === 'agy_code') renderAgyCodeWidget(body, tag);
    else if (type === 'agy_control') renderAgyControlWidget(body, tag);
    else renderMobileWidget(type, card, body, tag, wCfg);
  });
}

function checkPendingPairModal(forceOpen = false) {
  const modal = document.getElementById('pairModal');
  if (!modal) return;
  const reqs = Array.isArray(store.state?.pendingPairs) ? store.state.pendingPairs : [];
  const active = reqs[0];
  if (!active) { modal.hidden = true; modal.dataset.reqId = ''; dismissedPairId = ''; return; }
  if (!forceOpen && active.id === dismissedPairId && !active.approved) return;

  modal.dataset.reqId = active.id;
  document.getElementById('pairDevName').textContent = active.deviceName || 'Laptop';
  document.getElementById('pairDevMeta').textContent = `${active.platform || 'PC'} · ${active.remoteIp || 'Remote'}`;
  const codeBox = document.getElementById('pairCodeBox');
  const codeNum = document.getElementById('pairCodeDigits');
  const actRow = document.getElementById('pairActions');

  if (active.approved && active.code) {
    codeBox.hidden = false;
    codeNum.textContent = String(active.code).replace(/(\d{3})(\d{3})/, '$1  $2');
    actRow.innerHTML = `<button type="button" class="btn danger" id="pairCancelBtn">Cancel Request</button>`;
  } else {
    codeBox.hidden = true;
    actRow.innerHTML = `
      <button type="button" class="btn danger" id="pairDenyBtn">Deny</button>
      <button type="button" class="btn primary" id="pairApproveBtn">${ico('shield', 14)} Allow &amp; Show 6-Digit Code</button>
    `;
    actRow.querySelector('#pairApproveBtn').onclick = async () => {
      haptic(25);
      await fetch('/api/pair/approve/' + encodeURIComponent(active.id), { method: 'POST', body: '{}' });
    };
    actRow.querySelector('#pairDenyBtn').onclick = async () => {
      haptic(20);
      await fetch('/api/pair/deny/' + encodeURIComponent(active.id), { method: 'POST', body: '{}' });
      modal.hidden = true;
    };
  }
  const cBtn = actRow.querySelector('#pairCancelBtn');
  if (cBtn) cBtn.onclick = async () => { await fetch('/api/pair/deny/' + encodeURIComponent(active.id), { method: 'POST', body: '{}' }); modal.hidden = true; };

  document.getElementById('pairModalClose').onclick = () => { dismissedPairId = active.id; modal.hidden = true; };
  modal.hidden = false;
}

document.getElementById('mobileFilePicker').onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  await fetch('/api/files?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  e.target.value = ''; haptic(20);
};

function updateClocks() {
  const now = new Date();
  const s = nightClock;
  if (s) s.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.querySelectorAll('[data-live="clock"]').forEach(el => {
    const showSec = el.textContent.split(':').length >= 3;
    el.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(showSec ? { second: '2-digit' } : {}) });
  });
  document.querySelectorAll('[data-live-tz]').forEach(el => {
    try { el.textContent = now.toLocaleTimeString([], { timeZone: el.dataset.liveTz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch (_) {}
  });
  tickMusicProgress();
}
setInterval(updateClocks, 1000);

setInterval(() => {
  if (store.state?.settings?.oled_shift === '1') {
    const x = Math.round((Math.random() - 0.5) * 4);
    const y = Math.round((Math.random() - 0.5) * 4);
    document.getElementById('shell').style.transform = `translate(${x}px, ${y}px)`;
  }
}, 120000);

function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('state', (ev) => {
    connDot.classList.add('on');
    store.state = JSON.parse(ev.data);
    applyTheme();
    buildLayout();
    renderWidgets();
    checkPendingPairModal(false);
    checkPendingAgyModal(false);
  });
  es.addEventListener('pair_request', () => { dismissedPairId = ''; haptic(45); checkPendingPairModal(true); });
  es.addEventListener('agy_perm', (ev) => {
    const p = JSON.parse(ev.data);
    if (!store.state) store.state = {};
    store.state.agyPermissions = [p, ...(store.state.agyPermissions || []).filter(x => x.id !== p.id)];
    haptic(40);
    checkPendingAgyModal(true);
  });
  es.addEventListener('toast', (ev) => { const d = JSON.parse(ev.data); showToast(d.title, d.body); });
  es.addEventListener('goto', (ev) => {
    const d = JSON.parse(ev.data);
    const idx = (store.state?.pages || []).findIndex(p => p.id === d.page || p.title.toLowerCase() === String(d.page).toLowerCase());
    if (idx >= 0) gotoPageIndex(idx);
  });
  es.addEventListener('screen_ready', (ev) => {
    const meta = JSON.parse(ev.data);
    if (!store.state) store.state = {};
    store.state.laptopScreen = meta;
    const url = `/api/laptop/screen?t=${meta.ts || Date.now()}`;
    const imgs = document.querySelectorAll('[data-pc-screen-img]');
    if (imgs.length) {
      imgs.forEach(img => { img.src = url; });
      document.querySelectorAll('[data-scr-res]').forEach(el => { if (meta.w > 0) el.textContent = `${meta.w}×${meta.h}`; });
    } else {
      document.querySelectorAll('[data-wtype="pc_screen"] .card-body').forEach(b => renderPcScreenWidget(b));
    }
  });
  es.addEventListener('smtc_art_ready', (ev) => {
    const meta = JSON.parse(ev.data);
    if (!store.state) store.state = {};
    store.state.smtcArt = meta;
    document.querySelectorAll('[data-wtype="pc_music_player"] .card-body').forEach(b => renderPcMusicPlayerWidget(b));
  });
  es.onerror = () => { connDot.classList.remove('on'); es.close(); setTimeout(connectStream, 2000); };
}

window.addEventListener('resize', () => { lastPagesSig = ''; if (store.state) { buildLayout(); renderWidgets(); } });

// --- Voice Command Engine ---
let voiceActive = false;
const btnVoice = document.getElementById('btnVoice');
if (btnVoice) {
  btnVoice.onclick = () => {
    if (!voiceActive) {
      voiceActive = true;
      btnVoice.classList.add('voice-on');
      haptic(25);
      window.PhoneBoxNative?.startVoiceCommand();
    } else {
      voiceActive = false;
      btnVoice.classList.remove('voice-on');
      window.PhoneBoxNative?.stopVoiceCommand();
    }
  };
}

window.fridayOnVoiceTranscript = (type, text) => {
  if (type === 'ready') { showToast('Listening\u2026', 'Speak a command'); return; }
  if (type === 'error') { voiceActive = false; btnVoice?.classList.remove('voice-on'); showToast('Voice Error', text); return; }
  if (type === 'partial') { return; } // silently update — no toast for partial
  if (type === 'result') {
    voiceActive = false;
    btnVoice?.classList.remove('voice-on');
    runFridayVoiceCommand(text.toLowerCase().trim());
  }
};

function runFridayVoiceCommand(cmd) {
  if (!cmd) return;
  haptic(20);
  // Strip wake word if spoken aloud
  cmd = cmd.replace(/^(hey\s+)?f\.?r\.?i\.?d\.?a\.?y\.?\s*/i, '').trim();
  if (!cmd) { showToast('Voice Ready', 'Say a command after \u201cHey F.R.I.D.A.Y.\u201d'); return; }

  const post = (op, extra) => fetch('/api/laptop/input', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, ...extra })
  });

  // Volume — "set volume 60" / "volume 60"
  const volMatch = cmd.match(/volume\s+(\d+)/);
  if (volMatch) { post('set_vol', { pct: Math.min(100, Number(volMatch[1])) }); showToast('Volume', volMatch[1] + '%'); return; }

  // Media controls
  if (/\b(play|resume)\b/.test(cmd) && !/pause/.test(cmd)) { post('key', { combo: 'media_play' }); showToast('Playing'); return; }
  if (/\bpause\b/.test(cmd)) { post('key', { combo: 'media_play' }); showToast('Paused'); return; }
  if (/\b(next|skip)\b/.test(cmd)) { post('key', { combo: 'media_next' }); showToast('Next Track'); return; }
  if (/\bprev(ious)?\b/.test(cmd)) { post('key', { combo: 'media_prev' }); showToast('Previous Track'); return; }
  if (/\b(mute|unmute)\b/.test(cmd)) { post('toggle_mute', {}); showToast('Mute Toggled'); return; }

  // Lock PC
  if (/\block\s*(pc|computer|laptop)?\b/.test(cmd)) { post('system_act', { act: 'lock' }); showToast('Locking PC'); return; }

  // Profile switcher — "coding mode", "night profile", "music"
  const profMatch = cmd.match(/\b(coding|music|night|meeting|focus|gaming)\s*(mode|profile)?\b/);
  if (profMatch) { post('profile', { name: profMatch[1] }); showToast('Profile: ' + profMatch[1]); return; }

  // Screen off
  if (/\b(screen off|turn off screen|sleep)\b/.test(cmd)) { post('system_act', { act: 'screen_off' }); showToast('Screen Off'); return; }

  // Open app — "open notepad" / "open spotify"
  const openMatch = cmd.match(/^open\s+(.+)$/);
  if (openMatch) { post('launch_app', { appId: openMatch[1].trim() }); showToast('Opening', openMatch[1].trim()); return; }

  // Type text — "type hello world"
  const typeMatch = cmd.match(/^type\s+(.+)$/);
  if (typeMatch) { post('key', { combo: 'type:' + typeMatch[1] }); showToast('Typed', typeMatch[1]); return; }

  // Fallback: show recognized text as toast
  showToast('Voice: "' + cmd + '"', 'Command not recognized');
}

connectStream();
