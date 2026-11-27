import { ico, hydrateIcons } from '/shared/icons.js';
hydrateIcons();

let state = null;
let catalog = [];
let appsCache = [];
let pagesDraft = [];
let activePageIdx = 0;
let selectedWidgetId = null;
let dirty = false;
let portraitPreview = false;
let dragPayload = null;
let sseHandle = null;

const VIEW_META = {
  home: ['Live Dashboard', 'Real-time phone server overview & instant controls'],
  builder: ['Builder Room', 'Choose widgets and customize your mobile screen'],
  control: ['Phone & Apps', 'Launch apps, navigate remotely & view notifications'],
  setup: ['Rules & Settings', 'Automation rules, monitors, weather & device preferences']
};

const PRESETS = {
  desk: [
    { id: 'w1', type: 'clock', x: 0, y: 0, w: 5, h: 3, title: 'Clock', opts: { showSeconds: true } },
    { id: 'w2', type: 'connect_qr', x: 5, y: 0, w: 4, h: 3, title: 'Connect & Pair', opts: {} },
    { id: 'w3', type: 'quick_controls', x: 9, y: 0, w: 3, h: 3, title: 'Quick Controls', opts: {} },
    { id: 'w4', type: 'checklist', x: 0, y: 3, w: 4, h: 3, title: 'Daily Tasks', opts: {} },
    { id: 'w5', type: 'notes', x: 4, y: 3, w: 4, h: 3, title: 'Quick Notes', opts: {} },
    { id: 'w6', type: 'sensors', x: 8, y: 3, w: 4, h: 3, title: 'Sensors & Signal', opts: {} }
  ],
  server: [
    { id: 's1', type: 'uptime_monitor', x: 0, y: 0, w: 4, h: 3, title: 'Uptime Monitor', opts: {} },
    { id: 's2', type: 'metrics_chart', x: 4, y: 0, w: 5, h: 3, title: 'Phone History', opts: { metric: 'batteryPct' } },
    { id: 's3', type: 'wol', x: 9, y: 0, w: 3, h: 3, title: 'Wake PC', opts: {} },
    { id: 's4', type: 'rules_widget', x: 0, y: 3, w: 4, h: 3, title: 'Automation Rules', opts: {} },
    { id: 's5', type: 'inbox', x: 4, y: 3, w: 4, h: 3, title: 'Webhook Inbox', opts: {} },
    { id: 's6', type: 'news_feed', x: 8, y: 3, w: 4, h: 3, title: 'Tech News', opts: {} }
  ],
  apps: [
    { id: 'a1', type: 'now_playing', x: 0, y: 0, w: 6, h: 3, title: 'Phone Media', opts: {} },
    { id: 'a2', type: 'app_dock', x: 6, y: 0, w: 6, h: 3, title: 'App Dock', opts: {} },
    { id: 'a3', type: 'clipboard', x: 0, y: 3, w: 4, h: 3, title: 'Clipboard Vault', opts: {} },
    { id: 'a4', type: 'files', x: 4, y: 3, w: 4, h: 3, title: 'File Vault', opts: {} },
    { id: 'a5', type: 'timer', x: 8, y: 3, w: 4, h: 3, title: 'Timers & Focus', opts: {} }
  ],
  music: [
    { id: 'pm1', type: 'pc_music_player', x: 0, y: 0, w: 7, h: 6, title: 'Now Playing', opts: {} },
    { id: 'pm2', type: 'pc_audio_stage', x: 7, y: 0, w: 5, h: 6, title: '3D Audio Devices & Mixer', opts: {} }
  ]
};

let activePairReqId = '';
let catalogFilter = 'all';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
function fmtDur(sec) { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h > 0 ? `${h}h ${m}m` : (m > 0 ? `${m}m ${s}s` : `${s}s`); }
function showToast(msg) {
  const el = document.getElementById('toastBox');
  el.textContent = msg; el.hidden = false;
  clearTimeout(showToast._t); showToast._t = setTimeout(() => { el.hidden = true; }, 2600);
}
function markDirty(f = true) { dirty = f; document.getElementById('unsavedBadge').hidden = !dirty; }

const BASE_PREFIX = location.pathname.includes('/r/') ? location.pathname.replace(/\/admin.*$/, '') : '';
function apiUrl(u) { return BASE_PREFIX && u.startsWith('/') ? BASE_PREFIX + u : u; }

async function api(url, opts = {}) {
  const pin = localStorage.getItem('pb_pin') || '';
  const token = localStorage.getItem('pb_token') || '';
  const headers = {
    ...(opts.headers || {}),
    ...(pin ? { 'X-PhoneBox-Pin': pin } : {}),
    ...(token ? { 'X-PhoneBox-Token': token } : {})
  };
  const res = await fetch(apiUrl(url), { ...opts, headers });
  if (res.status === 401) { document.getElementById('pinModal').hidden = false; throw new Error('AUTH'); }
  return res.json();
}

document.getElementById('pairReqBtn').onclick = async () => {
  const r = await fetch(apiUrl('/api/pair/request'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceName: `Browser (${navigator.platform || 'Web'})`, platform: 'web' })
  }).then(x => x.json()).catch(() => ({}));
  if (!r.ok) return alert(r.error || 'Could not request pairing');
  activePairReqId = r.requestId;
  document.getElementById('authPromptSub').textContent = 'Approve the request on your F.R.I.D.A.Y. phone screen, then enter the 6-digit code below.';
};

document.getElementById('pinSubmit').onclick = async () => {
  const val = document.getElementById('pinInput').value.trim();
  if (!val) return;
  if (activePairReqId) {
    const res = await fetch(apiUrl('/api/pair/confirm'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: activePairReqId, code: val })
    }).then(r => r.json()).catch(() => ({}));
    if (res.ok && res.token) {
      localStorage.setItem('pb_token', res.token);
      activePairReqId = '';
      document.getElementById('pinModal').hidden = true;
      initRealtime();
      loadApps();
      return;
    }
    return alert(res.error || 'Waiting for phone approval or wrong 6-digit code');
  }
  localStorage.setItem('pb_pin', val);
  const chk = await fetch(apiUrl('/api/auth/check'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: val }) }).then(r => r.json());
  if (chk.ok) { document.getElementById('pinModal').hidden = true; initRealtime(); loadApps(); } else alert('Invalid PIN — or click Request 6-Digit Pairing Code above.');
};

// Navigation
const sidebar = document.getElementById('sidebar');
document.getElementById('menuBtn').onclick = () => sidebar.classList.add('open');
document.getElementById('sbClose').onclick = () => sidebar.classList.remove('open');

function goView(name) {
  sidebar.classList.remove('open');
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  const [title, sub] = VIEW_META[name] || ['Dashboard', ''];
  document.getElementById('viewTitle').textContent = title;
  document.getElementById('viewSub').textContent = sub;
  document.getElementById('btnSaveLayout').hidden = (name !== 'builder');
  if (name === 'control' && !appsCache.length) loadApps();
}

document.querySelectorAll('.nav-item').forEach(b => { b.onclick = () => goView(b.dataset.view); });
document.getElementById('goBuilderBtn').onclick = () => goView('builder');

// Sub-tabs
document.querySelectorAll('[data-sb]').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('[data-sb]').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.sb-pane').forEach(p => p.classList.toggle('active', p.id === 'sb-' + b.dataset.sb));
  };
});
document.querySelectorAll('[data-st]').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('[data-st]').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.st-pane').forEach(p => p.classList.toggle('active', p.id === 'st-' + b.dataset.st));
  };
});

let relayPollTimer = null;

async function initRealtime() {
  try { catalog = (await api('/api/catalog')).widgets || []; } catch (_) { return; }
  if (sseHandle) sseHandle.close();
  clearInterval(relayPollTimer);
  const pin = localStorage.getItem('pb_pin') || '';
  const tok = localStorage.getItem('pb_token') || '';
  const basePrefix = location.pathname.includes('/r/') ? location.pathname.replace(/\/admin.*$/, '') : '';
  if (basePrefix) {
    const pollFn = async () => {
      try {
        state = await api(basePrefix + '/api/state');
        document.getElementById('srvDot').classList.add('on');
        document.getElementById('sseDot').classList.add('on');
        document.getElementById('sseLabel').textContent = 'Relay Live';
        if (!dirty) pagesDraft = JSON.parse(JSON.stringify(state.pages || []));
        renderAll();
      } catch (_) {}
    };
    pollFn();
    relayPollTimer = setInterval(pollFn, 2500);
    return;
  }

  const qs = [];
  if (tok) qs.push('token=' + encodeURIComponent(tok));
  if (pin) qs.push('pin=' + encodeURIComponent(pin));
  sseHandle = new EventSource('/api/stream' + (qs.length ? '?' + qs.join('&') : ''));

  sseHandle.addEventListener('state', (ev) => {
    state = JSON.parse(ev.data);
    document.getElementById('srvDot').classList.add('on');
    document.getElementById('sseDot').classList.add('on');
    document.getElementById('sseLabel').textContent = 'Live';
    if (!dirty) pagesDraft = JSON.parse(JSON.stringify(state.pages || []));
    renderAll();
  });
  sseHandle.onerror = () => {
    document.getElementById('srvDot').classList.remove('on');
    document.getElementById('sseDot').classList.remove('on');
    document.getElementById('sseLabel').textContent = 'Reconnecting';
  };
}

async function loadApps() {
  try {
    appsCache = (await api('/api/apps')).apps || [];
    document.getElementById('navAppCount').textContent = appsCache.length;
    renderApps();
  } catch (_) {}
}

function ringSvg(pct, color) {
  const val = pct >= 0 ? Math.max(0, Math.min(100, pct)) : 0;
  const c = 2 * Math.PI * 22;
  const offset = c - (val / 100) * c;
  return `<svg class="ring-svg" viewBox="0 0 54 54">
    <circle class="ring-bg" cx="27" cy="27" r="22"/>
    <circle class="ring-fg" cx="27" cy="27" r="22" stroke="${color}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/>
  </svg>`;
}

function renderAll() {
  if (!state) return;
  const t = state.telemetry || {};
  document.getElementById('sbDevName').textContent = t.deviceName || 'Android';
  document.getElementById('sbDevUrl').textContent = `${t.ip || '127.0.0.1'}:${t.port || 8765}`;
  document.getElementById('sbBat').textContent = t.batteryPct >= 0 ? `${t.batteryPct}%` : 'No data';
  document.getElementById('sbTemp').textContent = t.socTempC > 0 ? `${t.socTempC}°C` : (t.tempC >= 0 ? `${t.tempC}°C` : 'No data');
  document.getElementById('sbWifi').textContent = t.wifiConnected ? `${t.wifiRssi} dBm` : 'Offline';
  document.getElementById('sbUp').textContent = fmtDur(t.serverUptimeSec || 0);
  const sh = t.serverHealth || {};
  const sshEl = document.getElementById('sbSsh');
  if (sshEl) sshEl.textContent = sh.sshListening ? 'Listening' : (sh.termuxInstalled ? 'Stopped' : 'No Termux');
  document.getElementById('navPageCount').textContent = (state.pages || []).length;
  document.getElementById('mockIp').textContent = `${t.ip || '127.0.0.1'}:${t.port || 8765}`;

  renderHome();
  renderBuilder();
  renderControl();
  renderSetup();
}

// --- 1. LIVE DASHBOARD ---
function renderHome() {
  const t = state.telemetry || {};
  const m = state.metrics || {};
  const sens = state.sensors || {};
  const a = state.audio || {};
  const perms = state.permissions || {};

  const cpuOk = t.cpuPct >= 0;
  const ramOk = t.ramPct >= 0;
  const batOk = t.batteryPct >= 0;
  const diskOk = t.storagePct >= 0;

  document.getElementById('heroRings').innerHTML = [
    [cpuOk ? t.cpuPct : 0, '#2dd4bf', 'CPU Load', cpuOk ? `${t.cpuPct}%` : 'No data', t.cpuFreqMhz > 0 ? `${t.cpuFreqMhz} MHz` : 'Unavailable'],
    [ramOk ? t.ramPct : 0, '#38bdf8', 'Memory', ramOk ? `${t.ramPct}%` : 'No data', `${t.ramUsedMb || 0} / ${t.ramTotalMb || 0} MB`],
    [batOk ? t.batteryPct : 0, '#a78bfa', 'Battery', batOk ? `${t.batteryPct}%` : 'No data', `${t.chargeSource || ''} · ${t.socTempC > 0 ? t.socTempC + '°C' : ''}`],
    [diskOk ? t.storagePct : 0, '#f59e0b', 'Storage Free', `${t.storageFreeGb || 0} GB`, `Net ↓${t.netRxKbps >= 0 ? t.netRxKbps : 0} ↑${t.netTxKbps >= 0 ? t.netTxKbps : 0} KB/s`]
  ].map(([pct, col, lbl, val, sub]) => `
    <div class="ring-card">
      ${ringSvg(pct, col)}
      <div class="ring-meta"><small>${lbl}</small><b>${esc(val)}</b><span>${esc(sub)}</span></div>
    </div>
  `).join('');

  // Area Chart
  const cpu = m.cpuPct || [], ram = m.ramPct || [], bat = m.batteryPct || [];
  const makeArea = (arr, col, gradId) => {
    if (arr.length < 2) return '';
    const coords = arr.map((p, i) => [((i / (arr.length - 1)) * 600), (185 - (Math.max(0, Math.min(100, p.v)) / 100) * 165)]);
    const line = coords.map(c => `${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ');
    const area = `0,190 ${line} 600,190`;
    return `<polygon fill="url(#${gradId})" points="${area}"/><polyline fill="none" stroke="${col}" stroke-width="2.5" points="${line}"/>`;
  };
  const hasSeries = cpu.length >= 2 || ram.length >= 2 || bat.length >= 2;
  document.getElementById('liveChart').innerHTML = hasSeries ? `
    <svg viewBox="0 0 600 195" style="width:100%;height:100%">
      <defs>
        <linearGradient id="gCpu" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2dd4bf" stop-opacity=".28"/><stop offset="100%" stop-color="#2dd4bf" stop-opacity="0"/></linearGradient>
        <linearGradient id="gRam" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#38bdf8" stop-opacity=".22"/><stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/></linearGradient>
        <linearGradient id="gBat" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#a78bfa" stop-opacity=".18"/><stop offset="100%" stop-color="#a78bfa" stop-opacity="0"/></linearGradient>
      </defs>
      <line x1="0" y1="20" x2="600" y2="20" stroke="rgba(255,255,255,0.06)"/>
      <line x1="0" y1="105" x2="600" y2="105" stroke="rgba(255,255,255,0.06)"/>
      <line x1="0" y1="190" x2="600" y2="190" stroke="rgba(255,255,255,0.09)"/>
      ${makeArea(bat, '#a78bfa', 'gBat')}
      ${makeArea(ram, '#38bdf8', 'gRam')}
      ${makeArea(cpu, '#2dd4bf', 'gCpu')}
    </svg>` : `<div class="muted" style="display:grid;place-items:center;height:100%">No data found (waiting for samples...)</div>`;

  document.getElementById('homeFgApp').textContent = perms.foregroundPkg ? `Foreground: ${perms.foregroundPkg.split('.').pop()}` : 'Foreground: Phone Panel';
  document.getElementById('qTorch').classList.toggle('on', !!sens.torchOn);
  document.getElementById('qTorchLbl').textContent = sens.torchOn ? 'On' : 'Off';
  document.getElementById('qMute').classList.toggle('on', !!a.mediaMuted);
  document.getElementById('qMuteIco').innerHTML = ico(a.mediaMuted ? 'volume-x' : 'volume-2', 18);
  document.getElementById('qMuteLbl').textContent = a.mediaMuted ? 'Muted' : 'Active';
  document.getElementById('qPlayLbl').textContent = state.media?.title ? state.media.title.slice(0, 18) : 'Play / Pause';
  document.getElementById('qVolRange').value = a.mediaVol ?? 50;
  document.getElementById('qVolText').textContent = (a.mediaVol ?? 50) + '%';

  document.getElementById('homeSensors').innerHTML = `
    <div class="sens-chip"><span class="muted">Room Light</span><b>${sens.lightLux >= 0 ? sens.lightLux + ' lx' : 'No data'}</b></div>
    <div class="sens-chip"><span class="muted">Steps</span><b>${sens.steps >= 0 ? sens.steps : 'No data'}</b></div>
  `;

  const pages = state.pages || [];
  document.getElementById('homePagesList').innerHTML = pages.length ? pages.map(p => `
    <div class="list-row">
      <div><b>${esc(p.title)}</b> <small class="muted">· ${(p.widgets || []).length} widgets</small></div>
      <button class="btn sm" data-focus-p="${esc(p.id)}">Show on Phone</button>
    </div>
  `).join('') : '<p class="muted">No data found</p>';
  document.querySelectorAll('[data-focus-p]').forEach(b => {
    b.onclick = () => api('/api/goto/' + encodeURIComponent(b.dataset.focusP), { method: 'POST' }).then(() => showToast('Switched phone screen'));
  });

  const mons = state.monitors || [];
  document.getElementById('homeMonitorsList').innerHTML = mons.length ? mons.map(mon => `
    <div class="list-row">
      <div><b>${esc(mon.name)}</b> <small class="muted">${esc(mon.host)}</small></div>
      <span class="chip ${mon.up === 1 ? 'ok' : 'err'}">${mon.up === 1 ? mon.latencyMs + 'ms' : (mon.up === 0 ? 'Offline' : 'Checking')}</span>
    </div>
  `).join('') : '<p class="muted">No data found (add monitors in Rules & Settings)</p>';
}

document.getElementById('qTorch').onclick = () => api('/api/hw/torch', { method: 'POST', body: '{}' });
document.getElementById('qMute').onclick = () => api('/api/hw/mute', { method: 'POST' });
document.getElementById('qPlay').onclick = () => api('/api/hw/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'play_pause' }) });
document.getElementById('qBeep').onclick = () => api('/api/hw/beep', { method: 'POST' }).then(() => showToast('Ringing phone'));
document.getElementById('qVolRange').onchange = (e) => api('/api/hw/volume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ percent: Number(e.target.value) }) });
document.getElementById('homePingBtn').onclick = () => api('/api/monitors/run', { method: 'POST' }).then(() => showToast('Pinged all monitors'));

// --- 2. BUILDER ROOM ---
let themeSynced = false;
function syncThemePreview(style, accent, rad, gap) {
  const scr = document.getElementById('phoneScreen');
  scr.className = 'frame-screen theme-' + style;
  scr.style.setProperty('--mock-accent', accent);
  scr.style.setProperty('--mock-radius', rad + 'px');
  scr.style.setProperty('--mock-gap', gap + 'px');
  document.documentElement.style.setProperty('--accent', accent);
  document.getElementById('thRadVal').textContent = rad + 'px';
  document.getElementById('thGapVal').textContent = gap + 'px';
  document.querySelectorAll('.th-card').forEach(b => b.classList.toggle('active', b.dataset.th === style));
  document.querySelectorAll('.adot').forEach(b => b.classList.toggle('active', b.dataset.col === accent));
}

let curStyle = 'glass', curAccent = '#2dd4bf';
document.querySelectorAll('.th-card').forEach(b => {
  b.onclick = () => { curStyle = b.dataset.th; syncThemePreview(curStyle, curAccent, document.getElementById('thRadius').value, document.getElementById('thGap').value); };
});
document.querySelectorAll('.adot').forEach(b => {
  b.onclick = () => { curAccent = b.dataset.col; document.getElementById('thAccent').value = curAccent; syncThemePreview(curStyle, curAccent, document.getElementById('thRadius').value, document.getElementById('thGap').value); };
});
document.getElementById('thAccent').oninput = (e) => { curAccent = e.target.value; syncThemePreview(curStyle, curAccent, document.getElementById('thRadius').value, document.getElementById('thGap').value); };
document.getElementById('thRadius').oninput = () => syncThemePreview(curStyle, curAccent, document.getElementById('thRadius').value, document.getElementById('thGap').value);
document.getElementById('thGap').oninput = () => syncThemePreview(curStyle, curAccent, document.getElementById('thRadius').value, document.getElementById('thGap').value);

document.getElementById('btnSaveTheme').onclick = () => api('/api/settings', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ theme: curStyle, accent: curAccent, card_radius: document.getElementById('thRadius').value, grid_gap: document.getElementById('thGap').value })
}).then(() => showToast('Look & Theme applied to phone!'));

function findNextFreeSlot(widgets, w, h) {
  const occ = Array.from({ length: 6 }, () => Array(12).fill(false));
  for (const it of widgets) {
    for (let yy = it.y; yy < Math.min(6, it.y + it.h); yy++)
      for (let xx = it.x; xx < Math.min(12, it.x + it.w); xx++) occ[yy][xx] = true;
  }
  for (let y = 0; y <= 6 - h; y++)
    for (let x = 0; x <= 12 - w; x++) {
      let ok = true;
      for (let dy = 0; dy < h && ok; dy++) for (let dx = 0; dx < w && ok; dx++) if (occ[y + dy][x + dx]) ok = false;
      if (ok) return { x, y };
    }
  return { x: 0, y: 0 };
}

function getLiveTilePreview(w) {
  if (!state) return '...';
  const t = state.telemetry || {};
  const s = state.sensors || {};
  if (w.type === 'clock') return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (w.type === 'phone_stats') return `CPU ${t.cpuPct >= 0 ? t.cpuPct + '%' : 'N/A'} · RAM ${t.ramPct ?? 0}%`;
  if (w.type === 'sensors') return s.lightLux >= 0 ? `Light ${s.lightLux} lx` : 'No data found';
  if (w.type === 'weather') return (state.settings?.weather_lat && state.settings?.weather_lon) ? (state.settings.weather_city || 'Set') : 'No data found';
  if (w.type === 'world_clock') return state.settings?.world_clocks ? 'Configured' : 'No data found';
  if (w.type === 'checklist') return (state.checklists || []).length ? `${state.checklists.length} tasks` : 'No data found';
  if (w.type === 'notes') return (state.notes || []).length ? state.notes[0].title : 'No data found';
  if (w.type === 'uptime_monitor') return (state.monitors || []).length ? `${state.monitors.length} hosts` : 'No data found';
  if (w.type === 'wol') return (state.wolTargets || []).length ? `${state.wolTargets.length} PCs` : 'No data found';
  if (w.type === 'app_dock') return (state.appDock || []).length ? `${state.appDock.length} apps` : 'No data found';
  if (w.type === 'clipboard') return (state.clipboard || []).length ? `${state.clipboard.length} clips` : 'No data found';
  if (w.type === 'files') return (state.files || []).length ? `${state.files.length} files` : 'No data found';
  if (w.type === 'rules_widget') return (state.rules || []).length ? `${state.rules.length} rules` : 'No data found';
  if (w.type === 'inbox') return (state.notifications || []).length ? `${state.notifications.length} alerts` : 'No data found';
  if (w.type === 'news_feed') return (state.news || []).length ? `${state.news.length} articles` : 'No data found';
  if (w.type === 'now_playing') return state.media?.title || 'No data found';
  if (w.type === 'push_value') return state.pushed?.[w.opts?.key || 'status']?.value ?? 'No data found';
  if (w.type === 'counter') return state.pushed?.[w.opts?.key || 'counter_daily']?.value ?? 'No data found';
  if (w.type === 'antigravity') return state.agy?.model ? `${state.agy.model} · ${Math.round(((state.agy.contextTokens || 0) / (state.agy.contextLimit || 1048576)) * 100)}% ctx` : 'No data found';
  if (w.type === 'agy_permissions') {
    const pend = (state.agyPermissions || []).filter(p => p.status === 'pending').length;
    return pend ? `${pend} pending approval` : (state.settings?.agy_gate_enabled === '1' ? 'Gate ON' : 'Gate OFF');
  }
  if (w.type === 'agy_code') {
    const fc = (state.agyCode?.files || []).length;
    return fc ? `${fc} files · +${state.agyCode.totalAdded || 0}/-${state.agyCode.totalRemoved || 0}` : 'No changes';
  }
  if (w.type === 'agy_control') {
    return state.settings?.agy_paused === '1' ? 'Paused on Mobile' : 'Remote Ready';
  }
  if (w.type === 'laptop_monitor') {
    const l = state.laptop || {};
    return l.sampledAt ? `CPU ${l.cpuPct ?? 0}% · GPU ${l.gpuPct ?? 'N/A'}%` : 'Waiting for stream';
  }
  if (w.type === 'phone_monitor') {
    return `CPU ${t.cpuPct >= 0 ? t.cpuPct + '%' : 'N/A'} · RAM ${t.ramPct ?? 0}%`;
  }
  if (w.type === 'laptop_processes') {
    const p = state.laptop?.processes || {};
    return p.totalProcs ? `${p.totalProcs} procs · ${p.totalApps} apps` : 'Waiting for stream';
  }
  if (w.type === 'world_strip') return state.settings?.world_clocks ? '5 World Clocks' : 'No data found';
  if (w.type === 'hourly_weather') return state.settings?.weather_city || 'Set city';
  if (w.type === 'calendar_month') return new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  if (w.type === 'pc_trackpad') return state.callState?.active ? 'Call Active (Muted)' : 'Trackpad & Keys';
  if (w.type === 'pc_screen') return state.laptopScreen?.w ? `${state.laptopScreen.w}×${state.laptopScreen.h}` : 'Live Screen Peek';
  if (w.type === 'pc_deck') return '4×3 PC App & Power Deck';
  if (w.type === 'connect_qr' || w.type === 'server_qr') return `${(state.pairedDevices || []).length} paired`;
  if (w.type === 'pc_music_player') return state.laptop?.control?.smtc?.title || 'Now Playing · Seek & Volume';
  if (w.type === 'pc_audio_stage') {
    const outs = state.laptop?.control?.outputs || [];
    const cur = outs.find(o => o.isDefault) || outs[0];
    return cur ? cur.name : `${outs.length} audio outputs`;
  }
  if (w.type === 'pc_display') return `Bright ${state.laptop?.control?.bright ?? '--'}%`;
  if (w.type === 'pc_windows') return `${(state.laptop?.control?.wins || []).length} open windows`;
  return `${w.w}×${w.h}`;
}

function renderBuilder() {
  const s = state.settings || {};
  if (!themeSynced && s.theme) {
    themeSynced = true;
    curStyle = s.theme || 'glass';
    curAccent = s.accent || '#2dd4bf';
    document.getElementById('thAccent').value = curAccent;
    document.getElementById('thRadius').value = s.card_radius || '16';
    document.getElementById('thGap').value = s.grid_gap || '8';
  }
  syncThemePreview(curStyle, curAccent, document.getElementById('thRadius').value, document.getElementById('thGap').value);

  const tabsEl = document.getElementById('pageTabs');
  tabsEl.innerHTML = pagesDraft.map((p, i) => `
    <button class="page-pill ${i === activePageIdx ? 'active' : ''}" data-pidx="${i}">${esc(p.title)}</button>
  `).join('');
  tabsEl.querySelectorAll('.page-pill').forEach(b => {
    b.onclick = () => { activePageIdx = Number(b.dataset.pidx); selectedWidgetId = null; renderBuilder(); };
  });

  const page = pagesDraft[activePageIdx];
  const widgets = page?.widgets || [];
  document.getElementById('mockPageTitle').textContent = page?.title || 'Page';

  // Catalog (filtered by Mobile / Laptop + search, zero duplicates)
  const q = document.getElementById('widgetSearch').value.trim().toLowerCase();
  const activeTypes = new Set(widgets.map(w => w.type));
  const groups = {};
  for (const spec of catalog) {
    if (catalogFilter !== 'all' && spec.device !== catalogFilter) continue;
    if (q && !spec.name.toLowerCase().includes(q) && !spec.desc.toLowerCase().includes(q)) continue;
    const grpKey = `${spec.device === 'laptop' ? 'Laptop' : 'Mobile'} · ${spec.category}`;
    (groups[grpKey] ||= []).push(spec);
  }
  document.querySelectorAll('[data-cat-dev]').forEach(btn => {
    btn.classList.toggle('primary', btn.dataset.catDev === catalogFilter);
    btn.onclick = () => { catalogFilter = btn.dataset.catDev; renderBuilder(); };
  });
  const catEl = document.getElementById('catalogList');
  catEl.innerHTML = Object.entries(groups).map(([catName, items]) => `
    <div class="pick-cat">${esc(catName)}</div>
    ${items.map(spec => {
      const enabled = activeTypes.has(spec.type);
      return `<div class="pick-card ${enabled ? 'on' : ''}" draggable="true" data-drag-type="${esc(spec.type)}">
        <div><b>${esc(spec.name)}</b><small>${esc(spec.desc)}</small></div>
        <label class="switch"><input type="checkbox" ${enabled ? 'checked' : ''} data-toggle-widget="${esc(spec.type)}"></label>
      </div>`;
    }).join('')}
  `).join('');

  catEl.querySelectorAll('[data-drag-type]').forEach(el => {
    el.ondragstart = () => { dragPayload = { kind: 'new', type: el.dataset.dragType }; };
  });
  catEl.querySelectorAll('[data-toggle-widget]').forEach(cb => {
    cb.onchange = () => {
      if (!page) return;
      const type = cb.dataset.toggleWidget;
      if (cb.checked) {
        const spec = catalog.find(x => x.type === type);
        const pos = findNextFreeSlot(page.widgets, spec.w, spec.h);
        const wid = 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
        page.widgets.push({ id: wid, type, title: spec.name, x: pos.x, y: pos.y, w: spec.w, h: spec.h, opts: {} });
        selectedWidgetId = wid;
      } else {
        page.widgets = page.widgets.filter(w => w.type !== type);
        if (!page.widgets.some(w => w.id === selectedWidgetId)) selectedWidgetId = null;
      }
      markDirty(true); renderBuilder();
    };
  });

  // Phone Canvas
  const canvas = document.getElementById('gridCanvas');
  canvas.innerHTML = '';
  canvas.ondragover = (e) => { e.preventDefault(); canvas.classList.add('drop-active'); };
  canvas.ondragleave = () => canvas.classList.remove('drop-active');
  canvas.ondrop = (e) => {
    e.preventDefault(); canvas.classList.remove('drop-active');
    if (!page || !dragPayload) return;
    const rect = canvas.getBoundingClientRect();
    const cols = portraitPreview ? 6 : 12;
    const gx = Math.max(0, Math.min(cols - 1, Math.floor(((e.clientX - rect.left) / rect.width) * cols)));
    const gy = Math.max(0, Math.min(5, Math.floor(((e.clientY - rect.top) / rect.height) * 6)));
    if (dragPayload.kind === 'new') {
      const spec = catalog.find(x => x.type === dragPayload.type);
      const wid = 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
      page.widgets.push({ id: wid, type: spec.type, title: spec.name, x: Math.min(12 - spec.w, portraitPreview ? gx * 2 : gx), y: Math.min(6 - spec.h, gy), w: spec.w, h: spec.h, opts: {} });
      selectedWidgetId = wid;
    } else if (dragPayload.kind === 'move') {
      const w = page.widgets.find(x => x.id === dragPayload.id);
      if (w) { w.x = Math.min(12 - w.w, portraitPreview ? gx * 2 : gx); w.y = Math.min(6 - w.h, gy); }
    }
    dragPayload = null; markDirty(true); renderBuilder();
  };

  widgets.forEach(w => {
    const el = document.createElement('div');
    el.className = 'tile' + (w.id === selectedWidgetId ? ' selected' : '');
    el.draggable = true;
    el.ondragstart = () => { dragPayload = { kind: 'move', id: w.id }; };
    if (portraitPreview) {
      el.style.gridColumn = `span ${Math.max(3, Math.min(6, Math.round((w.w || 4) / 2)))}`;
      el.style.gridRow = `span ${Math.max(2, Math.round((w.h || 3) * 0.9))}`;
    } else {
      el.style.gridColumn = `${(w.x || 0) + 1} / span ${w.w || 4}`;
      el.style.gridRow = `${(w.y || 0) + 1} / span ${w.h || 3}`;
    }
    el.innerHTML = `<b>${esc(w.title || w.type)}</b><small>${esc(getLiveTilePreview(w))}</small>`;
    el.onclick = () => { selectedWidgetId = w.id; renderBuilder(); };
    canvas.appendChild(el);
  });

  // Simple Friendlier Inspector
  const insp = document.getElementById('inspector');
  const w = widgets.find(x => x.id === selectedWidgetId);
  if (!w) {
    insp.innerHTML = '<span class="muted">Click any widget on the phone screen above to rename, resize, or move it.</span>';
    return;
  }
  insp.innerHTML = `
    <input id="iwTitle" class="inp" style="max-width:170px" value="${esc(w.title || '')}" placeholder="Widget title">
    <div class="row-gap">
      <button class="btn sm" data-mv="left">${ico('arrow-left', 13)}</button>
      <button class="btn sm" data-mv="up">${ico('arrow-up', 13)}</button>
      <button class="btn sm" data-mv="down">${ico('arrow-down', 13)}</button>
      <button class="btn sm" data-mv="right">${ico('arrow-right', 13)}</button>
    </div>
    <select id="iwSize" class="inp sm-sel">
      <option value="">Resize preset...</option>
      <option value="4x3" ${w.w===4&&w.h===3?'selected':''}>Compact (1/3)</option>
      <option value="6x3" ${w.w===6&&w.h===3?'selected':''}>Half Wide (1/2)</option>
      <option value="12x3" ${w.w===12&&w.h===3?'selected':''}>Full Row</option>
      <option value="6x6" ${w.w===6&&w.h===6?'selected':''}>Large Half</option>
    </select>
    ${w.type === 'push_value' || w.type === 'counter' ? `<input id="iwKey" class="inp" style="max-width:130px" value="${esc(w.opts?.key || 'status')}" placeholder="Key">` : ''}
    <button class="btn sm primary" id="iwSaveTile">Update</button>
    <button class="btn sm danger" id="iwDelTile">Remove</button>
  `;
  insp.querySelectorAll('[data-mv]').forEach(b => {
    b.onclick = () => {
      const dir = b.dataset.mv;
      if (dir === 'left') w.x = Math.max(0, w.x - 1);
      if (dir === 'right') w.x = Math.min(12 - w.w, w.x + 1);
      if (dir === 'up') w.y = Math.max(0, w.y - 1);
      if (dir === 'down') w.y = Math.min(6 - w.h, w.y + 1);
      markDirty(true); renderBuilder();
    };
  });
  document.getElementById('iwSize').onchange = (e) => {
    const val = e.target.value; if (!val) return;
    const [nw, nh] = val.split('x').map(Number);
    w.w = nw; w.h = nh;
    w.x = Math.min(w.x, 12 - w.w); w.y = Math.min(w.y, 6 - w.h);
    markDirty(true); renderBuilder();
  };
  document.getElementById('iwSaveTile').onclick = () => {
    w.title = document.getElementById('iwTitle').value;
    const keyEl = document.getElementById('iwKey'); if (keyEl) w.opts = { ...(w.opts || {}), key: keyEl.value };
    markDirty(true); renderBuilder();
  };
  document.getElementById('iwDelTile').onclick = () => {
    page.widgets = page.widgets.filter(x => x.id !== w.id);
    selectedWidgetId = null; markDirty(true); renderBuilder();
  };
}

document.getElementById('widgetSearch').oninput = renderBuilder;
document.getElementById('btnOrientation').onclick = () => {
  portraitPreview = !portraitPreview;
  document.getElementById('phoneBezel').classList.toggle('portrait', portraitPreview);
  document.getElementById('btnOrientation').textContent = portraitPreview ? 'Portrait' : 'Landscape';
  renderBuilder();
};
document.getElementById('btnNewPage').onclick = () => {
  const title = prompt('New mobile screen name:', 'Custom');
  if (!title) return;
  pagesDraft.push({ id: title.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now().toString().slice(-3), title, widgets: [] });
  activePageIdx = pagesDraft.length - 1; selectedWidgetId = null; markDirty(true); renderBuilder();
};
document.getElementById('btnRenamePage').onclick = () => {
  const p = pagesDraft[activePageIdx]; if (!p) return;
  const t = prompt('Screen name:', p.title); if (t) { p.title = t; markDirty(true); renderBuilder(); }
};
document.getElementById('btnDelPage').onclick = () => {
  if (pagesDraft.length <= 1) return alert('Keep at least 1 mobile screen.');
  pagesDraft.splice(activePageIdx, 1); activePageIdx = 0; selectedWidgetId = null; markDirty(true); renderBuilder();
};
document.getElementById('btnApplyPreset').onclick = () => {
  const key = document.getElementById('presetSelect').value;
  if (!key || !PRESETS[key] || !pagesDraft[activePageIdx]) return;
  pagesDraft[activePageIdx].widgets = JSON.parse(JSON.stringify(PRESETS[key]));
  selectedWidgetId = null; markDirty(true); renderBuilder();
};
document.getElementById('btnGotoPhone').onclick = () => {
  const p = pagesDraft[activePageIdx]; if (p) api('/api/goto/' + encodeURIComponent(p.id), { method: 'POST' }).then(() => showToast('Focused on phone'));
};
document.getElementById('btnSaveLayout').onclick = async () => {
  await api('/api/pages', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pages: pagesDraft }) });
  markDirty(false); showToast('Layout saved to your phone!');
};

// --- 3. PHONE & APPS CONTROL ---
function renderControl() {
  const perms = state.permissions || {};
  const banner = document.getElementById('permBanner');
  if (perms.a11yConnected && perms.notifConnected) {
    banner.innerHTML = `<div class="row-gap"><span class="chip ok">All Remote Permissions Active</span><span class="muted">Media, Notifications &amp; App Automation are ready.</span></div>`;
  } else {
    banner.innerHTML = `
      <div class="row-gap">
        <span class="chip ${perms.a11yConnected ? 'ok' : 'warn'}">Remote Touch: ${perms.a11yConnected ? 'On' : 'Off'}</span>
        <span class="chip ${perms.notifConnected ? 'ok' : 'warn'}">Notifications &amp; Media: ${perms.notifConnected ? 'On' : 'Off'}</span>
      </div>
      <div class="row-gap">
        <button class="btn sm" onclick="openPhoneSettings('app_info')">1. Allow Restricted</button>
        <button class="btn sm" onclick="openPhoneSettings('accessibility')">2. Enable Remote Touch</button>
        <button class="btn sm" onclick="openPhoneSettings('notifications')">3. Enable Notifications</button>
      </div>
    `;
  }

  const macSel = document.getElementById('macAppPick');
  if (appsCache.length && macSel.options.length <= 1) {
    macSel.innerHTML = '<option value="">Pick an app...</option>' + appsCache.map(a => `<option value="${esc(a.pkg)}">${esc(a.label)}</option>`).join('');
  }

  const macros = state.macros || [];
  document.getElementById('macrosList').innerHTML = macros.length ? macros.map(m => `
    <div class="list-row">
      <div><b>${esc(m.name)}</b></div>
      <div class="row-gap">
        <button class="btn sm primary" data-run-mac="${m.id}">Run</button>
        <button class="btn sm danger" data-del-mac="${m.id}">${ico('x', 12)}</button>
      </div>
    </div>
  `).join('') : '<p class="muted">No data found</p>';
  document.querySelectorAll('[data-run-mac]').forEach(b => { b.onclick = () => api('/api/macros/' + b.dataset.runMac + '/run', { method: 'POST' }).then(() => showToast('Shortcut executed')); });
  document.querySelectorAll('[data-del-mac]').forEach(b => { b.onclick = () => api('/api/macros/' + b.dataset.delMac, { method: 'DELETE' }); });

  const pns = state.phoneNotifications || [];
  document.getElementById('phoneNotifList').innerHTML = pns.length ? pns.map(n => `
    <div class="list-row" style="flex-direction:column;align-items:stretch">
      <div class="row-between">
        <div><b>${esc(n.app)}</b>: ${esc(n.title)} <small class="muted">${esc(n.text)}</small></div>
        <button class="btn sm" data-dis-notif="${esc(n.key)}">Dismiss</button>
      </div>
      ${(n.actions || []).filter(x => x.canReply).map(act => `
        <div class="row-gap" style="margin-top:6px">
          <input class="inp" id="rep_${esc(n.key)}_${act.index}" placeholder="Reply via ${esc(act.title)}...">
          <button class="btn sm primary" data-rep-key="${esc(n.key)}" data-rep-idx="${act.index}">Reply</button>
        </div>
      `).join('')}
    </div>
  `).join('') : '<p class="muted">No data found</p>';
  document.querySelectorAll('[data-dis-notif]').forEach(b => { b.onclick = () => api('/api/phone-notifications/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: b.dataset.disNotif }) }); });
  document.querySelectorAll('[data-rep-key]').forEach(b => {
    b.onclick = () => {
      const inp = document.getElementById(`rep_${b.dataset.repKey}_${b.dataset.repIdx}`);
      api('/api/phone-notifications/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: b.dataset.repKey, actionIndex: Number(b.dataset.repIdx), text: inp.value }) }).then(() => showToast('Reply sent'));
    };
  });
}

window.openPhoneSettings = (kind) => api('/api/hw/open-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) });

function renderApps() {
  const q = document.getElementById('appSearch').value.trim().toLowerCase();
  const pinned = new Set((state?.appDock || []).map(a => a.pkg));
  const filtered = appsCache.filter(a => !q || a.label.toLowerCase().includes(q)).slice(0, 60);
  document.getElementById('appsGrid').innerHTML = filtered.length ? filtered.map(a => {
    const isPinned = pinned.has(a.pkg);
    return `<div class="app-tile-card">
      <div class="app-tile-top">
        <img src="${esc(a.iconUrl)}" alt="" loading="lazy">
        <b title="${esc(a.label)}">${esc(a.label)}</b>
      </div>
      <div class="row-gap">
        <button class="btn sm primary" style="flex:1" data-launch-app="${esc(a.pkg)}">Open</button>
        <button class="btn sm ${isPinned ? 'danger' : ''}" data-pin-app="${esc(a.pkg)}" data-pin-lbl="${esc(a.label)}" data-pinned="${isPinned ? '1' : '0'}">${isPinned ? 'Pinned' : 'Pin'}</button>
      </div>
    </div>`;
  }).join('') : '<p class="muted">No data found</p>';

  document.querySelectorAll('[data-launch-app]').forEach(b => { b.onclick = () => api('/api/apps/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pkg: b.dataset.launchApp }) }).then(() => showToast('Launched app')); });
  document.querySelectorAll('[data-pin-app]').forEach(b => {
    b.onclick = async () => {
      if (b.dataset.pinned === '1') await api('/api/app-dock/' + encodeURIComponent(b.dataset.pinApp), { method: 'DELETE' });
      else await api('/api/app-dock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pkg: b.dataset.pinApp, label: b.dataset.pinLbl }) });
      renderApps();
    };
  });
}

document.getElementById('appSearch').oninput = renderApps;
document.getElementById('btnRefreshApps').onclick = loadApps;
document.getElementById('btnOpenUri').onclick = () => api('/api/apps/uri', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri: document.getElementById('deepLinkUri').value }) }).then(() => showToast('Link opened on phone'));
document.getElementById('btnPushClip').onclick = () => api('/api/clipboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: document.getElementById('rmClipText').value, source: 'laptop', copyToDevice: true }) }).then(() => { document.getElementById('rmClipText').value = ''; showToast('Sent to phone clipboard'); });
document.getElementById('btnSpeakTts').onclick = () => api('/api/hw/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: document.getElementById('rmTtsText').value }) });
document.getElementById('btnTypeText').onclick = () => api('/api/a11y/type', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: document.getElementById('a11yTypeText').value }) });
document.querySelectorAll('[data-g]').forEach(b => { b.onclick = () => api('/api/a11y/global', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: b.dataset.g }) }); });
document.getElementById('btnInspectNodes').onclick = async () => {
  const res = await api('/api/a11y/nodes');
  const box = document.getElementById('nodesBox');
  box.hidden = false;
  if (!res.connected) { box.innerHTML = '<span class="muted">Enable Remote Touch permission first.</span>'; return; }
  box.innerHTML = (res.nodes || []).length ? (res.nodes || []).map(n => `<button class="node-btn" data-nx="${n.cx}" data-ny="${n.cy}">${esc(n.text || n.cls)}</button>`).join('') : '<span class="muted">No tappable text found</span>';
  box.querySelectorAll('[data-nx]').forEach(ch => { ch.onclick = () => api('/api/a11y/tap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: Number(ch.dataset.nx), y: Number(ch.dataset.ny) }) }); });
};
document.getElementById('btnAddMacro').onclick = async () => {
  const name = document.getElementById('macName').value.trim();
  const pkg = document.getElementById('macAppPick').value;
  if (!pkg) return alert('Pick an app first');
  await api('/api/macros', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name || pkg.split('.').pop(), steps: [{ op: 'launch', value: pkg }, { op: 'wait', ms: 1000 }] }) });
  document.getElementById('macName').value = ''; showToast('Shortcut saved');
};

// --- 4. RULES & SETTINGS ---
let prefsSynced = false;
function renderSetup() {
  const rules = state.rules || [];
  document.getElementById('rulesList').innerHTML = rules.length ? rules.map(r => `
    <div class="list-row">
      <div><b>${esc(r.name)}</b><br><small class="muted">${esc(r.triggerType)} (${esc(r.triggerValue)}) → ${esc(r.actionType)}</small></div>
      <div class="row-gap">
        <button class="btn sm ${r.enabled ? 'primary' : ''}" data-tog-rule="${r.id}" data-en="${r.enabled ? '1' : '0'}">${r.enabled ? 'On' : 'Off'}</button>
        <button class="btn sm" data-run-rule="${r.id}">Test</button>
        <button class="btn sm danger" data-del-rule="${r.id}">${ico('x', 12)}</button>
      </div>
    </div>
  `).join('') : '<p class="muted">No data found</p>';
  document.querySelectorAll('[data-tog-rule]').forEach(b => { b.onclick = () => api('/api/rules/' + b.dataset.togRule, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: b.dataset.en !== '1' }) }); });
  document.querySelectorAll('[data-run-rule]').forEach(b => { b.onclick = () => api('/api/rules/' + b.dataset.runRule + '/run', { method: 'POST' }).then(() => showToast('Rule triggered')); });
  document.querySelectorAll('[data-del-rule]').forEach(b => { b.onclick = () => api('/api/rules/' + b.dataset.delRule, { method: 'DELETE' }); });

  const mons = state.monitors || [];
  document.getElementById('monList').innerHTML = mons.length ? mons.map(m => `
    <div class="list-row">
      <div><b>${esc(m.name)}</b> <small class="muted">${esc(m.host)}</small></div>
      <div class="row-gap"><span class="chip ${m.up === 1 ? 'ok' : 'err'}">${m.up === 1 ? m.latencyMs + 'ms' : (m.up === 0 ? 'Down' : '...')}</span><button class="btn sm danger" data-del-mon="${m.id}">${ico('x', 12)}</button></div>
    </div>
  `).join('') : '<p class="muted">No data found</p>';
  document.querySelectorAll('[data-del-mon]').forEach(b => { b.onclick = () => api('/api/monitors/' + b.dataset.delMon, { method: 'DELETE' }); });

  const wols = state.wolTargets || [];
  document.getElementById('wolList').innerHTML = wols.length ? wols.map(w => `
    <div class="list-row"><div><b>${esc(w.name)}</b> <small class="muted">${esc(w.mac)}</small></div><button class="btn sm danger" data-del-wol="${w.id}">${ico('x', 12)}</button></div>
  `).join('') : '<p class="muted">No data found</p>';
  document.querySelectorAll('[data-del-wol]').forEach(b => { b.onclick = () => api('/api/wol/' + b.dataset.delWol, { method: 'DELETE' }); });

  const feeds = state.feeds || [];
  document.getElementById('feedsList').innerHTML = feeds.length ? feeds.map(f => `
    <div class="list-row"><div><b>${esc(f.name)}</b><br><small class="muted">${esc(f.url)}</small></div><button class="btn sm danger" data-del-feed="${f.id}">${ico('x', 12)}</button></div>
  `).join('') : '<p class="muted">No data found</p>';
  document.querySelectorAll('[data-del-feed]').forEach(b => { b.onclick = () => api('/api/feeds/' + b.dataset.delFeed, { method: 'DELETE' }); });

  const s = state.settings || {};
  if (!prefsSynced) {
    prefsSynced = true;
    document.getElementById('setCity').value = s.weather_city || '';
    document.getElementById('setLat').value = s.weather_lat || '';
    document.getElementById('setLon').value = s.weather_lon || '';
    document.getElementById('setWorldClocks').value = s.world_clocks || '';
    document.getElementById('setKeepOn').checked = s.keep_screen_on === '1';
    document.getElementById('setOledShift').checked = s.oled_shift === '1';
    document.getElementById('setReqPairing').checked = s.require_pairing !== '0';
    document.getElementById('setPinEnabled').checked = s.pin_enabled === '1';
    document.getElementById('setPin').value = s.pin || '1234';
    document.getElementById('setRemoteUrl').value = s.remote_url || '';
    document.getElementById('setRelayEnabled').checked = s.relay_enabled === '1';
    document.getElementById('setRelayUrl').value = s.relay_url || '';
    document.getElementById('setRelayRoom').value = s.relay_room || '';
  }

  const pairedDevs = Array.isArray(state.pairedDevices) ? state.pairedDevices : [];
  const pairedEl = document.getElementById('pairedDevicesList');
  if (pairedEl) {
    pairedEl.innerHTML = pairedDevs.length ? pairedDevs.map(d => `<div class="list-row">
      <div><b>${esc(d.name)}</b> <small class="muted">(${esc(d.platform)}) · ${esc(d.remoteIp || 'Paired')}</small></div>
      <button class="btn sm danger" data-adm-unpair="${esc(d.id)}">Revoke</button>
    </div>`).join('') : '<p class="muted">No laptops paired yet. Run <code>friday connect</code> on your PC.</p>';
    pairedEl.querySelectorAll('[data-adm-unpair]').forEach(b => {
      b.onclick = () => api('/api/pair/devices/' + encodeURIComponent(b.dataset.admUnpair), { method: 'DELETE' }).then(() => showToast('Device Unpaired'));
    });
  }

  const sh = state.telemetry?.serverHealth || {};
  const sshRows = [
    ['Termux SSH (:8022)', sh.sshListening ? 'Listening' : 'Offline', sh.sshListening],
    ['Termux Package', sh.termuxInstalled ? `Installed (${sh.termuxUser || 'ready'})` : 'Not installed', !!sh.termuxInstalled],
    ['Network Auto-Start Job', sh.networkJobScheduled ? 'Armed' : 'Missing', !!sh.networkJobScheduled],
    ['Termux RUN_COMMAND Perm', sh.runCmdPermGranted ? 'Granted' : 'Denied', !!sh.runCmdPermGranted],
    ['Termux:Boot', sh.termuxBootInstalled ? 'Installed' : 'Not installed', !!sh.termuxBootInstalled],
    ['CPU WakeLock', sh.wakeLock ? 'Held' : 'Inactive', !!sh.wakeLock],
    ['Wi-Fi Low-Latency Lock', sh.wifiLock ? 'Held' : 'Inactive', !!sh.wifiLock],
    ['Battery Doze Exempt', sh.batteryExempt ? 'Allowed' : 'Optimized', !!sh.batteryExempt]
  ];
  document.getElementById('sshHealthList').innerHTML = sshRows.map(([k, v, ok]) => `
    <div class="list-row"><span>${esc(k)}</span><span class="chip ${ok ? 'ok' : 'err'}">${esc(v)}</span></div>
  `).join('');
  const autoSshEl = document.getElementById('setAutoKeepSsh');
  if (autoSshEl) autoSshEl.checked = sh.autoKeepSsh !== false;
  document.getElementById('sshCmdHelp').textContent = sh.sshCmd
    ? `Laptop SSH: ${sh.sshCmd}\nChange phone SSH password: run "passwd" inside Termux`
    : 'No data found (install Termux & sshd on phone)';

  const agy = state.agy || {};
  const gateOn = s.agy_gate_enabled === '1';
  const agyGateEl = document.getElementById('setAgyGate');
  if (agyGateEl) agyGateEl.checked = gateOn;
  const fmtK = n => { const x = Number(n || 0); return x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : String(x); };
  const agyStatsEl = document.getElementById('agyStatsList');
  if (agyStatsEl) {
    const q5 = agy.quota?.['gemini-5h']?.remaining_fraction;
    const qw = agy.quota?.['gemini-weekly']?.remaining_fraction;
    agyStatsEl.innerHTML = agy.updatedAt ? [
      ['Model', agy.model || 'Unknown'],
      ['Gemini 5h / Weekly', `${q5 != null ? Math.round(q5 * 100) + '%' : '--'} / ${qw != null ? Math.round(qw * 100) + '%' : '--'} left`],
      ['Context Used', `${fmtK(agy.contextTokens)} / ${fmtK(agy.contextLimit || 1048576)}`],
      ['Session Tokens', `In ${fmtK(agy.sessionIn)} · Out ${fmtK(agy.sessionOut)} · Cached ${fmtK(agy.sessionCached)}`],
      ['5-Hour Tokens', `${fmtK(agy.window5hTokens)} (${agy.window5hSessions || 0} sessions)`],
      ['Weekly Tokens', `${fmtK(agy.weeklyTokens)} (${agy.weeklyTurns || 0} turns)`]
    ].map(([k, v]) => `<div class="list-row"><span>${esc(k)}</span><span class="chip ok">${esc(v)}</span></div>`).join('')
      : '<p class="muted">No data found (connect laptop Antigravity hook)</p>';
  }
  const agyPerms = state.agyPermissions || [];
  const agyPermsEl = document.getElementById('agyPermsList');
  if (agyPermsEl) {
    agyPermsEl.innerHTML = agyPerms.length ? agyPerms.slice(0, 8).map(p => {
      const ans = p.response?.answers?.map(a => (a.selected || []).concat(a.customText ? [a.customText] : []).join(', ')).filter(Boolean).join(' · ');
      const info = ans ? `Choice: ${ans}` : (p.detail || p.target || '').slice(0, 70);
      return `<div class="list-row">
        <div><b>${esc(p.toolName)}</b><br><small class="muted">${esc(info)}</small></div>
        <div class="row-gap">
          ${p.status === 'pending' ? `<button class="btn sm primary" data-ad-id="${p.id}" data-ad-d="auto_approve" title="Approve &amp; Run">${ico('check', 12)}</button><button class="btn sm danger" data-ad-id="${p.id}" data-ad-d="deny" title="Deny">${ico('x', 12)}</button>` : `<span class="chip ${p.status === 'deny' ? 'err' : 'ok'}">${esc(p.status)}</span>`}
        </div>
      </div>`;
    }).join('') : '<p class="muted">No data found</p>';
    agyPermsEl.querySelectorAll('[data-ad-id]').forEach(b => {
      b.onclick = () => api(`/api/agy/permission/${b.dataset.adId}/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: b.dataset.adD }) });
    });
  }

  document.getElementById('dbTables').innerHTML = Object.entries(state.db?.tables || {}).map(([k, v]) => `
    <div class="list-row"><span>${esc(k)}</span><span class="chip">${v} rows</span></div>
  `).join('');
  document.getElementById('logBox').textContent = (state.logs || []).length
    ? (state.logs || []).slice(0, 15).map(l => `[${new Date(l.ts).toLocaleTimeString()}] ${l.tag}: ${l.message}`).join('\n')
    : 'No data found';
  const base = state.telemetry?.url || location.origin;
  document.getElementById('curlHelp').textContent =
`curl -X POST ${base}/api/push/status -H "Content-Type: application/json" -d '{"value":"Online","sub":"Synced"}'
curl -X POST ${base}/api/notify -H "Content-Type: application/json" -d '{"title":"Alert","body":"Done"}'`;
}

document.getElementById('btnAddRule').onclick = () => api('/api/rules', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: document.getElementById('ruleName').value,
    triggerType: document.getElementById('ruleTrigType').value,
    triggerValue: document.getElementById('ruleTrigVal').value,
    actionType: document.getElementById('ruleActType').value,
    actionValue: document.getElementById('ruleActVal').value
  })
}).then(() => { document.getElementById('ruleName').value = ''; showToast('Rule created'); });

document.getElementById('btnAddMonitor').onclick = () => api('/api/monitors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('monName').value, host: document.getElementById('monHost').value, port: Number(document.getElementById('monPort').value || 0) }) });
document.getElementById('btnRunMonitors').onclick = () => api('/api/monitors/run', { method: 'POST' }).then(() => showToast('Pinged all'));
document.getElementById('btnAddWol').onclick = () => api('/api/wol', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('wolName').value, mac: document.getElementById('wolMac').value }) });
document.getElementById('btnAddFeed').onclick = () => api('/api/feeds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('feedName').value, url: document.getElementById('feedUrl').value }) });
document.getElementById('btnRefreshNews').onclick = () => api('/api/news/refresh', { method: 'POST' }).then(() => showToast('Feeds refreshed'));

document.getElementById('btnFindCity').onclick = async () => {
  const city = document.getElementById('setCity').value.trim();
  if (!city) return alert('Enter a city name');
  const res = await api('/api/geocode?city=' + encodeURIComponent(city));
  if (!res.ok) return alert(res.error || 'No data found');
  document.getElementById('setCity').value = `${res.name}${res.country ? ', ' + res.country : ''}`;
  document.getElementById('setLat').value = String(res.lat);
  document.getElementById('setLon').value = String(res.lon);
  showToast('Found ' + document.getElementById('setCity').value);
};
document.getElementById('btnFillZones').onclick = () => {
  document.getElementById('setWorldClocks').value = 'Asia/Kolkata|IST,UTC|UTC,America/New_York|NYC,Europe/London|LON';
};
function saveAllPrefs() {
  return api('/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      weather_city: document.getElementById('setCity').value,
      weather_lat: document.getElementById('setLat').value,
      weather_lon: document.getElementById('setLon').value,
      world_clocks: document.getElementById('setWorldClocks').value,
      keep_screen_on: document.getElementById('setKeepOn').checked ? '1' : '0',
      oled_shift: document.getElementById('setOledShift').checked ? '1' : '0',
      require_pairing: document.getElementById('setReqPairing').checked ? '1' : '0',
      pin_enabled: document.getElementById('setPinEnabled').checked ? '1' : '0',
      pin: document.getElementById('setPin').value,
      remote_url: document.getElementById('setRemoteUrl').value.trim(),
      relay_enabled: document.getElementById('setRelayEnabled').checked ? '1' : '0',
      relay_url: document.getElementById('setRelayUrl').value.trim()
    })
  }).then(() => showToast('Preferences, Security & Relay saved!'));
}
document.getElementById('btnSaveSettings1').onclick = saveAllPrefs;
document.getElementById('btnSaveSettings2').onclick = saveAllPrefs;

document.getElementById('btnOpenTermux').onclick = () => api('/api/apps/launch', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pkg: 'com.termux' })
}).then(r => showToast(r.ok ? 'Opened Termux on phone' : 'Termux not installed'));

document.getElementById('btnEnsureSsh').onclick = () => api('/api/hw/ensure-ssh', { method: 'POST' })
  .then(() => showToast('Triggered Termux SSH start'));

document.getElementById('btnBatterySettings').onclick = () => api('/api/hw/open-settings', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ kind: 'battery_exempt' })
}).then(() => showToast('Opened phone battery settings'));

document.getElementById('setAutoKeepSsh').onchange = (e) => api('/api/settings', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ auto_keep_ssh: e.target.checked ? '1' : '0' })
}).then(() => showToast('Updated Auto-Keep SSH'));

document.getElementById('setAgyGate').onchange = (e) => api('/api/agy/gate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ enabled: e.target.checked })
}).then(() => showToast(e.target.checked ? 'Phone Approval Gate ON' : 'Phone Approval Gate OFF'));

document.getElementById('btnClearAgyPerms').onclick = () => api('/api/agy/permissions', { method: 'DELETE' })
  .then(() => showToast('Cleared resolved permission history'));

document.getElementById('btnCopySsh').onclick = async () => {
  const cmd = state?.telemetry?.serverHealth?.sshCmd || '';
  if (!cmd) return showToast('No SSH command available');
  try { await navigator.clipboard.writeText(cmd); showToast('Copied: ' + cmd); }
  catch (_) { showToast(cmd); }
};

initRealtime();
loadApps();
