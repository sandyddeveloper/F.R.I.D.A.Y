import { ico } from '/shared/icons.js';
import { store, haptic, esc, showToast, emptyMsg, fmtBytes, fmtSec, openDetailModal } from '../lib/core.js';

let noteIndex = 0;
let calMonthOffset = 0;
let weatherCache = null;
let lastWeatherFetch = 0;
let lastWeatherCoords = '';
let weatherFetchPromise = null;

const pomo = { running: false, total: 25 * 60, left: 25 * 60, timer: null };
const qTimer = { mode: 'timer', running: false, left: 300, elapsed: 0, handle: null };

export function openNoteModal(note) {
  const modal = document.getElementById('noteModal');
  const titleInp = document.getElementById('noteTitleInput');
  const bodyInp = document.getElementById('noteBodyInput');
  const delBtn = document.getElementById('noteDelete');
  document.getElementById('noteModalTitle').textContent = note?.id ? 'Edit Note' : 'New Note';
  titleInp.value = note?.title || '';
  bodyInp.value = note?.body || '';
  delBtn.hidden = !note?.id;
  modal.hidden = false;
  document.getElementById('noteCancel').onclick = () => { modal.hidden = true; };
  delBtn.onclick = async () => { await fetch('/api/notes/' + note.id, { method: 'DELETE' }); modal.hidden = true; haptic(20); };
  document.getElementById('noteSave').onclick = async () => {
    await fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: note?.id || null, title: titleInp.value, body: bodyInp.value, pinned: true }) });
    modal.hidden = true; haptic(20);
  };
}

export function openTaskModal() {
  const modal = document.getElementById('taskModal');
  const inp = document.getElementById('taskTextInput');
  inp.value = '';
  modal.hidden = false;
  setTimeout(() => inp.focus(), 80);
  document.getElementById('taskCancel').onclick = () => { modal.hidden = true; };
  document.getElementById('taskSave').onclick = async () => {
    const text = inp.value.trim();
    if (!text) return;
    await fetch('/api/checklists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    modal.hidden = true; haptic(20);
  };
}

export function openClipModal() {
  const modal = document.getElementById('clipModal');
  const inp = document.getElementById('clipTextInput');
  inp.value = '';
  modal.hidden = false;
  setTimeout(() => inp.focus(), 80);
  document.getElementById('clipCancel').onclick = () => { modal.hidden = true; };
  document.getElementById('clipSave').onclick = async () => {
    const text = inp.value.trim();
    if (!text) return;
    await fetch('/api/clipboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text, source: 'phone', copyToDevice: true }) });
    modal.hidden = true; haptic(20);
  };
}

export function openConnectGuideModal() {
  const s = store.state || {};
  const t = s.telemetry || {};
  const set = s.settings || {};
  const relay = s.relay || {};
  const paired = Array.isArray(s.pairedDevices) ? s.pairedDevices : [];
  const lanUrl = t.url || `http://${t.ip || '127.0.0.1'}:${t.port || 8765}`;
  const relayConnUrl = (relay.enabled && relay.url && relay.room) ? `${relay.url.replace(/\/$/, '')}/r/${relay.room}` : '';
  const targetCmdUrl = relayConnUrl || set.remote_url || lanUrl;

  openDetailModal({
    title: 'Connect & Pair Devices (6-Digit Gate)',
    bodyHtml: `
      <div class="detail-kv" style="margin-bottom:8px">
        <div class="detail-row"><span>LAN Endpoint</span><span class="mono-url">${esc(lanUrl)}</span></div>
        <div class="detail-row"><span>Remote / Relay</span><span>${relayConnUrl ? `<span class="badge ok">Relay ${relay.connected ? 'Live' : 'Connecting'}</span>` : (set.remote_url ? esc(set.remote_url) : 'LAN Only (Configure in Admin)')}</span></div>
        <div class="detail-row"><span>CLI Command</span><span><code>npx friday connect ${esc(targetCmdUrl)}</code></span></div>
      </div>
      <div class="wx-title" style="margin:6px 0 4px">PAIRED LAPTOPS (${paired.length})</div>
      <div style="display:flex;flex-direction:column;gap:5px;max-height:28vh;overflow-y:auto">
        ${paired.length ? paired.map(d => `<div class="row-item">
          <div><b>${esc(d.name)}</b><br><small style="color:var(--muted)">${esc(d.platform)} · ${esc(d.remoteIp || 'Paired')}</small></div>
          <button type="button" class="btn sm danger" data-unpair-id="${esc(d.id)}">Revoke</button>
        </div>`).join('') : '<div class="empty-state">No laptops paired yet. Run <code>friday connect</code> on PC — you will be asked to confirm a 6-digit code here.</div>'}
      </div>`,
    actionsHtml: `<button type="button" class="btn sm primary" id="cgClose">Done</button>`,
    onBind: (m) => {
      m.querySelector('#cgClose').onclick = () => { m.hidden = true; };
      m.querySelectorAll('[data-unpair-id]').forEach(btn => {
        btn.onclick = async () => {
          haptic(20);
          await fetch('/api/pair/devices/' + encodeURIComponent(btn.dataset.unpairId), { method: 'DELETE' });
          m.hidden = true;
          showToast('Access Revoked', 'Laptop token removed');
        };
      });
    }
  });
}

function getTzClockParts(timeZone, now) {
  const fmtParts = (tz) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      ...(tz ? { timeZone: tz } : {}),
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(now);
    const get = (pType) => Number(parts.find(p => p.type === pType)?.value || 0);
    return {
      y: get('year'), m: get('month'), d: get('day'),
      hhmm: `${String(get('hour')).padStart(2, '0')}:${String(get('minute')).padStart(2, '0')}`,
      utcMs: Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'))
    };
  };
  const loc = fmtParts(undefined);
  const rem = fmtParts(timeZone);
  const diffHours = Math.round(((rem.utcMs - loc.utcMs) / 3600000) * 10) / 10;
  const dayDiff = Math.round((Date.UTC(rem.y, rem.m - 1, rem.d) - Date.UTC(loc.y, loc.m - 1, loc.d)) / 86400000);
  const dayLbl = dayDiff > 0 ? 'Tomorrow' : (dayDiff < 0 ? 'Yesterday' : 'Today');
  const sign = diffHours > 0 ? '+' : '';
  return { hhmm: rem.hhmm, offsetStr: diffHours === 0 ? `${dayLbl}, Local` : `${dayLbl}, ${sign}${diffHours}h` };
}

function openWorldClocksEditor() {
  const cur = (store.state?.settings?.world_clocks || '').trim();
  openDetailModal({
    title: 'Edit World Clocks (up to 5)',
    bodyHtml: `<p class="sub-muted" style="margin:0 0 8px">Format: <code>IANA_Zone|LABEL</code> comma-separated</p>
      <textarea id="wcEditInput" class="inp" rows="4">${esc(cur)}</textarea>`,
    actionsHtml: `<button type="button" class="btn sm" id="wcEditCancel">Cancel</button><button type="button" class="btn sm primary" id="wcEditSave">Save</button>`,
    onBind: (modal) => {
      modal.querySelector('#wcEditCancel').onclick = () => { modal.hidden = true; };
      modal.querySelector('#wcEditSave').onclick = async () => {
        const val = modal.querySelector('#wcEditInput').value.trim();
        await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ world_clocks: val }) });
        modal.hidden = true; haptic(20);
      };
    }
  });
}

function weatherCodeToIcon(code, isDay) {
  const c = Number(code ?? 0);
  if (c === 0 || c === 1) return { name: isDay ? 'sun' : 'moon', cls: isDay ? 'sun' : '' };
  if (c === 2) return { name: isDay ? 'cloud-sun' : 'cloud', cls: isDay ? 'sun' : '' };
  if (c === 3 || c === 45 || c === 48) return { name: 'cloud', cls: '' };
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return { name: 'cloud-rain', cls: 'rain' };
  if ((c >= 71 && c <= 77) || (c >= 85 && c <= 86)) return { name: 'snowflake', cls: 'rain' };
  if (c >= 95) return { name: 'cloud-lightning', cls: 'rain' };
  return { name: 'cloud', cls: '' };
}

async function fetchOpenMeteoForecast(lat, lon) {
  const coords = `${lat},${lon}`;
  const now = Date.now();
  if (coords === lastWeatherCoords && weatherCache && now - lastWeatherFetch < 600000) return weatherCache;
  if (weatherFetchPromise && coords === lastWeatherCoords) return weatherFetchPromise;
  lastWeatherCoords = coords;
  weatherFetchPromise = (async () => {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,is_day&hourly=temperature_2m,weather_code,is_day&timezone=auto&forecast_days=2`;
      const r = await fetch(url);
      if (r.ok) { weatherCache = await r.json(); lastWeatherFetch = Date.now(); }
    } catch (_) {}
    weatherFetchPromise = null;
    return weatherCache;
  })();
  return weatherFetchPromise;
}

function openWeatherCityModal() {
  const curCity = store.state?.settings?.weather_city || '';
  openDetailModal({
    title: 'Set Weather City',
    bodyHtml: `<input id="wxCityInp" class="inp" value="${esc(curCity)}" placeholder="City name (e.g. Tokyo, London, Hyderabad)">
      <div id="wxCityStatus" class="sub-muted" style="margin-top:8px">Fetches live Open-Meteo coordinates cleanly.</div>`,
    actionsHtml: `<button type="button" class="btn sm" id="wxCityCancel">Cancel</button><button type="button" class="btn sm primary" id="wxCitySave">Apply</button>`,
    onBind: (modal) => {
      const inp = modal.querySelector('#wxCityInp');
      setTimeout(() => inp.focus(), 60);
      modal.querySelector('#wxCityCancel').onclick = () => { modal.hidden = true; };
      modal.querySelector('#wxCitySave').onclick = async () => {
        const q = inp.value.trim();
        if (!q) return;
        const st = modal.querySelector('#wxCityStatus');
        st.textContent = 'Looking up city...';
        try {
          const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`).then(r => r.json());
          const hit = g?.results?.[0];
          if (!hit) { st.textContent = 'City not found — try another spelling'; return; }
          weatherCache = null; lastWeatherFetch = 0;
          await fetch('/api/settings', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              weather_city: `${hit.name}${hit.country_code ? ', ' + hit.country_code : ''}`,
              weather_lat: String(hit.latitude),
              weather_lon: String(hit.longitude)
            })
          });
          modal.hidden = true; haptic(20);
        } catch (_) { st.textContent = 'Network error looking up city'; }
      };
    }
  });
}

function getIsoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

export async function renderMobileWidget(type, card, body, tag, wCfg) {
  const state = store.state || {};
  const t = state.telemetry || {};

  if (type === 'clock') {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(wCfg.opts?.showSeconds ? { second: '2-digit' } : {}) });
    const dateStr = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    tag.innerHTML = t.batteryPct >= 0 ? (t.charging ? `<span class="inline-tag">${ico('zap', 12)} ${t.batteryPct}%</span>` : `${t.batteryPct}%`) : '--';
    body.innerHTML = `<div class="clock-hero">
      <div class="big-time" data-live="clock">${timeStr}</div>
      <div class="clock-meta">
        <div class="sub-muted" style="margin-top:0">${dateStr}</div>
        <div class="clock-dev">${esc(t.deviceName || 'Mobile')}</div>
      </div>
    </div>`;
  }
  else if (type === 'connect_qr' || type === 'server_qr') {
    const paired = Array.isArray(state.pairedDevices) ? state.pairedDevices : [];
    const relay = state.relay || {};
    const lanUrl = t.url || (t.ip && t.ip !== '127.0.0.1' ? `http://${t.ip}:${t.port || 8765}` : '');
    const relayUrl = (relay.enabled && relay.url && relay.room) ? `${relay.url.replace(/\/$/, '')}/r/${relay.room}` : '';
    const qrTarget = relayUrl || t.adminUrl || lanUrl;
    tag.innerHTML = `<span class="badge ${paired.length ? 'ok' : 'info'}">${paired.length} Paired</span>`;
    if (!qrTarget) {
      body.innerHTML = emptyMsg('Connect Wi-Fi or Relay');
    } else {
      body.innerHTML = `<div class="qr-wrap" style="cursor:pointer" title="Tap for CLI pairing & revoke details">
        <img src="/api/qr.svg?text=${encodeURIComponent(qrTarget)}" alt="Pair QR">
        <div style="min-width:0">
          <div style="font-size:12px;font-weight:700;margin-bottom:3px">${relayUrl ? 'Anywhere Relay Active' : 'Scan or CLI Pair'}</div>
          <div class="mono-url">${esc(qrTarget)}</div>
          <small style="color:var(--muted);font-size:10px;display:block;margin-top:3px">Tap for 6-digit pair status</small>
        </div>
      </div>`;
      body.firstElementChild.onclick = openConnectGuideModal;
    }
  }
  else if (type === 'world_strip' || type === 'world_clock') {
    const raw = (state.settings?.world_clocks || '').trim();
    if (!raw) {
      body.innerHTML = `<div class="hw-empty" style="height:100%;cursor:pointer">Tap to configure World Clocks</div>`;
      body.firstElementChild.onclick = openWorldClocksEditor;
      return;
    }
    const zones = raw.split(',').map(x => x.trim()).filter(Boolean).slice(0, 5);
    const now = new Date();
    body.innerHTML = `<div class="ws-strip">
      ${zones.map(z => {
        const [tz, lbl] = z.split('|');
        let info = { hhmm: '--:--', offsetStr: 'Invalid TZ' };
        try { info = getTzClockParts(tz.trim(), now); } catch (_) {}
        return `<div class="ws-cell" title="Tap to edit clocks">
          <span class="ws-city">${esc(lbl || tz)}</span>
          <span class="ws-time" data-live-tz="${esc(tz.trim())}">${info.hhmm}</span>
          <span class="ws-off">${esc(info.offsetStr)}</span>
        </div>`;
      }).join('')}
    </div>`;
    body.querySelectorAll('.ws-cell').forEach(el => { el.onclick = openWorldClocksEditor; });
  }
  else if (type === 'hourly_weather' || type === 'weather') {
    const lat = (state.settings?.weather_lat || '').trim();
    const lon = (state.settings?.weather_lon || '').trim();
    const city = (state.settings?.weather_city || '').trim() || 'Set City';
    if (!lat || !lon) {
      body.innerHTML = `<div class="wx-hours-wrap"><div class="wx-head"><span class="wx-title">WEATHER</span><button type="button" class="wx-city-btn">Set City</button></div><div class="hw-empty" style="flex:1 1 auto">Tap "Set City" to load forecast</div></div>`;
      body.querySelector('.wx-city-btn').onclick = openWeatherCityModal;
      return;
    }
    const data = await fetchOpenMeteoForecast(lat, lon);
    const h = data?.hourly;
    if (!h?.time?.length) {
      body.innerHTML = `<div class="wx-hours-wrap"><div class="wx-head"><span class="wx-title">NEXT HOURS</span><button type="button" class="wx-city-btn">${esc(city)}</button></div><div class="hw-empty" style="flex:1 1 auto">Weather unavailable</div></div>`;
      body.querySelector('.wx-city-btn').onclick = openWeatherCityModal;
      return;
    }
    const nowMs = Date.now();
    let startIdx = h.time.findIndex(tm => { const ms = Date.parse(tm); return Number.isFinite(ms) && ms >= nowMs - 3600000; });
    if (startIdx < 0) startIdx = 0;
    const slots = [];
    for (let i = 0; i < 9; i++) {
      const idx = startIdx + i * 2;
      if (idx >= h.time.length) break;
      const tStr = String(h.time[idx] || '');
      const hh = i === 0 ? 'Now' : (tStr.slice(11, 13) || '--');
      const deg = i === 0 && data.current?.temperature_2m != null ? Math.round(data.current.temperature_2m) : Math.round(h.temperature_2m[idx]);
      const wCode = i === 0 && data.current?.weather_code != null ? data.current.weather_code : h.weather_code?.[idx];
      const isDay = i === 0 && data.current?.is_day != null ? Boolean(data.current.is_day) : Boolean(h.is_day?.[idx] ?? 1);
      slots.push({ hh, deg, icon: weatherCodeToIcon(wCode, isDay) });
    }
    body.innerHTML = `<div class="wx-hours-wrap">
      <div class="wx-head"><span class="wx-title">NEXT HOURS</span><button type="button" class="wx-city-btn">${esc(city)}</button></div>
      <div class="wx-cols">${slots.map(sl => `<div class="wx-col"><span class="wx-col-t">${esc(sl.hh)}</span><span class="wx-col-ico ${sl.icon.cls}">${ico(sl.icon.name, 19)}</span><span class="wx-col-deg">${sl.deg}°</span></div>`).join('')}</div>
    </div>`;
    body.querySelector('.wx-city-btn').onclick = openWeatherCityModal;
  }
  else if (type === 'calendar_month') {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + calMonthOffset, 1);
    const y = target.getFullYear(), m = target.getMonth();
    const monthLabel = target.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();
    const weekNum = getIsoWeekNumber(calMonthOffset === 0 ? now : target);
    const firstDow = (new Date(y, m, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const prevMonthDays = new Date(y, m, 0).getDate();
    const totalCells = firstDow + daysInMonth > 35 ? 42 : 35;
    const cells = [];
    for (let i = 0; i < totalCells; i++) {
      const dayOffset = i - firstDow + 1;
      let num = dayOffset, dim = false, isToday = false;
      if (dayOffset <= 0) { num = prevMonthDays + dayOffset; dim = true; }
      else if (dayOffset > daysInMonth) { num = dayOffset - daysInMonth; dim = true; }
      else isToday = y === now.getFullYear() && m === now.getMonth() && num === now.getDate();
      cells.push(`<span class="cal-day${(i % 7) >= 5 ? ' wknd' : ''}${dim ? ' dim' : ''}${isToday ? ' today' : ''}">${num}</span>`);
    }
    const dows = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((l, i) => `<span class="cal-dow${i >= 5 ? ' wknd' : ''}">${l}</span>`).join('');
    body.innerHTML = `<div class="cal-wrap">
      <div class="cal-head">
        <span class="cal-month" style="cursor:pointer">${esc(monthLabel)}</span>
        <div class="cal-nav"><button type="button" class="cal-nav-btn" data-cal-mv="-1">${ico('chevron-left', 11)}</button><span>Week ${weekNum}</span><button type="button" class="cal-nav-btn" data-cal-mv="1">${ico('chevron-right', 11)}</button></div>
      </div>
      <div class="cal-grid">${dows}${cells.join('')}</div>
    </div>`;
    body.querySelector('.cal-month').onclick = () => { haptic(10); calMonthOffset = 0; store.onRerender?.(); };
    body.querySelectorAll('[data-cal-mv]').forEach(b => { b.onclick = () => { haptic(10); calMonthOffset += Number(b.dataset.calMv); store.onRerender?.(); }; });
  }
  else if (type === 'quick_controls') {
    const s = state.sensors || {}, a = state.audio || {};
    tag.textContent = `Vol ${a.mediaVol ?? 0}%`;
    body.innerHTML = `
      <div class="qc-row">
        <button class="btn sm ${s.torchOn ? 'primary' : ''}" data-qc="torch" ${!s.hasTorch ? 'disabled' : ''}>${ico('flashlight', 13)} ${!s.hasTorch ? 'No Torch' : (s.torchOn ? 'Torch ON' : 'Torch')}</button>
        <button class="btn sm ${a.mediaMuted ? 'danger' : ''}" data-qc="mute">${ico(a.mediaMuted ? 'volume-x' : 'volume-2', 13)} ${a.mediaMuted ? 'Muted' : 'Mute'}</button>
        <button class="btn sm" data-qc="beep">${ico('bell', 13)} Beep</button>
      </div>
      <input type="range" min="0" max="100" value="${a.mediaVol ?? 50}" class="vol-range" data-qc="vol">
    `;
    body.querySelector('[data-qc="torch"]').onclick = () => { haptic(20); fetch('/api/hw/torch', { method: 'POST', body: '{}' }); };
    body.querySelector('[data-qc="mute"]').onclick = () => { haptic(20); fetch('/api/hw/mute', { method: 'POST' }); };
    body.querySelector('[data-qc="beep"]').onclick = () => { haptic(30); fetch('/api/hw/beep', { method: 'POST' }); };
    body.querySelector('[data-qc="vol"]').onchange = (e) => {
      fetch('/api/hw/volume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ percent: Number(e.target.value) }) });
    };
  }
  else if (type === 'now_playing') {
    const m = state.media || {};
    tag.textContent = m.app || (m.connected ? 'Idle' : 'Bridge Off');
    if (!m.connected) {
      body.innerHTML = `${emptyMsg('Notification Bridge disabled')}
        <div style="text-align:center;margin-top:6px"><button class="btn sm primary" data-grant-notif="1">Enable Bridge</button></div>`;
      body.querySelector('[data-grant-notif]').onclick = () => fetch('/api/hw/open-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'notifications' }) });
    } else if (!m.title) {
      body.innerHTML = emptyMsg('No phone media playing');
    } else {
      body.innerHTML = `<div class="media-title">${esc(m.title)}</div><div class="media-sub">${esc(m.artist || m.album || m.app || '')}</div>
        <div class="pomo-btns">
          <button class="btn sm" data-med="prev">${ico('skip-back', 14)}</button>
          <button class="btn sm primary" data-med="play_pause">${m.playing ? `${ico('pause', 14)} Pause` : `${ico('play', 14)} Play`}</button>
          <button class="btn sm" data-med="next">${ico('skip-forward', 14)}</button>
        </div>`;
      body.querySelectorAll('[data-med]').forEach(b => {
        b.onclick = () => { haptic(15); fetch('/api/hw/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: b.dataset.med }) }); };
      });
    }
  }
  else if (type === 'app_dock') {
    const dock = state.appDock || [];
    tag.textContent = `${dock.length}`;
    if (!dock.length) body.innerHTML = emptyMsg('Pin apps in Admin Studio');
    else {
      body.className = 'card-body app-grid';
      body.innerHTML = dock.map(a => `<button class="app-tile" data-launch="${esc(a.pkg)}"><img src="${esc(a.iconUrl)}" alt=""><span>${esc(a.label)}</span></button>`).join('');
      body.querySelectorAll('[data-launch]').forEach(b => {
        b.onclick = () => { haptic(20); fetch('/api/apps/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pkg: b.dataset.launch }) }); };
      });
    }
  }
  else if (type === 'checklist') {
    const items = state.checklists || [];
    tag.innerHTML = `<span>${items.filter(x => x.done).length}/${items.length}</span> <button class="btn sm" data-act="add-task">+ Task</button>`;
    tag.querySelector('[data-act="add-task"]').onclick = openTaskModal;
    if (!items.length) body.innerHTML = emptyMsg('Tap + Task to add');
    else {
      body.className = 'card-body list-scroll';
      body.innerHTML = items.map(it => `<div class="row-item ${it.done ? 'done' : ''}"><span data-chk="${it.id}" data-done="${it.done ? '1' : '0'}" class="inline-tag" style="flex:1;cursor:pointer">${ico(it.done ? 'check-square' : 'square', 14)} ${esc(it.text)}</span><button class="btn sm danger" data-del-chk="${it.id}">${ico('x', 12)}</button></div>`).join('');
      body.querySelectorAll('[data-chk]').forEach(el => { el.onclick = () => { haptic(18); fetch('/api/checklists/' + el.dataset.chk, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: el.dataset.done !== '1' }) }); }; });
      body.querySelectorAll('[data-del-chk]').forEach(btn => { btn.onclick = () => { haptic(15); fetch('/api/checklists/' + btn.dataset.delChk, { method: 'DELETE' }); }; });
    }
  }
  else if (type === 'notes') {
    const notes = state.notes || [];
    if (noteIndex >= notes.length) noteIndex = 0;
    const cur = notes[noteIndex];
    tag.innerHTML = `${notes.length > 1 ? `<button class="btn sm" data-act="next-note">${noteIndex + 1}/${notes.length}</button>` : ''}<button class="btn sm" data-act="new-note">+</button>${cur ? `<button class="btn sm" data-act="edit-note">Edit</button>` : ''}`;
    const nx = tag.querySelector('[data-act="next-note"]');
    if (nx) nx.onclick = () => { noteIndex = (noteIndex + 1) % notes.length; store.onRerender?.(); };
    tag.querySelector('[data-act="new-note"]').onclick = () => openNoteModal({ id: null, title: '', body: '' });
    const ed = tag.querySelector('[data-act="edit-note"]');
    if (ed) ed.onclick = () => openNoteModal(cur);
    body.innerHTML = cur ? `<div class="note-box"><b>${esc(cur.title)}</b>\n${esc(cur.body)}</div>` : emptyMsg('Tap + to write a note');
  }
  else if (type === 'clipboard') {
    const clips = state.clipboard || [];
    tag.innerHTML = `<button class="btn sm" data-act="save-clip">+ Clip</button>`;
    tag.querySelector('[data-act="save-clip"]').onclick = openClipModal;
    if (!clips.length) body.innerHTML = emptyMsg('Tap + Clip or sync from laptop');
    else {
      body.className = 'card-body list-scroll';
      body.innerHTML = clips.slice(0, 6).map(c => `<div class="row-item" data-copy-clip="${esc(c.content)}" style="cursor:pointer"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.content)}</span><span class="badge info">${esc(c.source)}</span></div>`).join('');
      body.querySelectorAll('[data-copy-clip]').forEach(el => {
        el.onclick = async () => { haptic(20); await fetch('/api/clipboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: el.dataset.copyClip, source: 'phone', copyToDevice: true }) }); showToast('Clipboard', 'Copied to phone clipboard'); };
      });
    }
  }
  else if (type === 'files') {
    const files = state.files || [];
    tag.innerHTML = `<span>${files.length}</span> <button class="btn sm" data-act="add-file">+ Add</button>`;
    tag.querySelector('[data-act="add-file"]').onclick = () => document.getElementById('mobileFilePicker').click();
    if (!files.length) body.innerHTML = emptyMsg('Tap + Add to store a file');
    else {
      body.className = 'card-body list-scroll';
      body.innerHTML = files.slice(0, 8).map(f => `<div class="row-item"><a href="/api/files/${f.id}" style="color:var(--text);text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.filename)} <small style="color:var(--muted)">(${fmtBytes(f.sizeBytes)})</small></a><button class="btn sm" title="Send directly to PC Downloads/F.R.I.D.A.Y." data-send-pc="${f.id}">${ico('send', 11)} PC</button><button class="btn sm danger" data-del-file="${f.id}">${ico('x', 12)}</button></div>`).join('');
      body.querySelectorAll('[data-send-pc]').forEach(b => {
        b.onclick = async () => {
          haptic(18);
          const res = await fetch('/api/files/' + b.dataset.sendPc + '/send-pc', { method: 'POST', body: '{}' }).then(r => r.json()).catch(() => ({ ok: false }));
          showToast(res.ok ? 'Sent to PC Drop' : 'Send Failed', res.ok ? `Downloading "${res.filename || 'file'}" on laptop...` : 'Could not queue PC transfer');
        };
      });
      body.querySelectorAll('[data-del-file]').forEach(b => { b.onclick = () => fetch('/api/files/' + b.dataset.delFile, { method: 'DELETE' }); });
    }
  }
  else if (type === 'sensors') {
    const s = state.sensors || {};
    tag.textContent = t.wifiConnected ? `${t.wifiRssi} dBm` : 'No Wi-Fi';
    body.innerHTML = `<div class="stat-grid">
      <div class="wc-box"><small>Light</small><b>${s.lightLux >= 0 ? s.lightLux + ' lx' : 'No data'}</b></div>
      <div class="wc-box"><small>Steps</small><b>${s.steps >= 0 ? s.steps : 'No data'}</b></div>
      <div class="wc-box"><small>Motion</small><b>${s.motionG > 0 ? s.motionG + ' g' : 'No data'}</b></div>
      <div class="wc-box"><small>Voltage</small><b>${t.voltageMv > 0 ? (t.voltageMv / 1000).toFixed(2) + ' V' : 'No data'}</b></div>
    </div>`;
  }
  else if (type === 'metrics_chart') {
    const metricKey = wCfg.opts?.metric || 'batteryPct';
    const pts = state.metrics?.[metricKey] || [];
    tag.textContent = metricKey;
    if (pts.length < 2) body.innerHTML = emptyMsg('Waiting for SQLite samples');
    else {
      const vals = pts.map(p => p.v);
      const min = Math.min(...vals), max = Math.max(...vals), span = Math.max(1, max - min);
      const coords = pts.map((p, i) => `${((i / (pts.length - 1)) * 280).toFixed(1)},${(70 - ((p.v - min) / span) * 56).toFixed(1)}`).join(' ');
      body.innerHTML = `<svg viewBox="0 0 280 80" style="width:100%;height:78%"><polyline fill="none" stroke="var(--accent)" stroke-width="2.5" points="${coords}"/></svg><div class="sub-muted">Latest: ${vals[vals.length - 1].toFixed(1)} · Samples: ${pts.length}</div>`;
    }
  }
  else if (type === 'uptime_monitor') {
    const mons = state.monitors || [];
    tag.innerHTML = mons.length ? `<button class="btn sm" data-act="ping-now">Ping</button>` : '';
    if (!mons.length) body.innerHTML = emptyMsg('Add monitors in Admin');
    else {
      body.className = 'card-body list-scroll';
      body.innerHTML = mons.map(m => `<div class="row-item"><span><b>${esc(m.name)}</b> <small style="color:var(--muted)">${esc(m.host)}</small></span><span class="badge ${m.up === 1 ? 'ok' : (m.up === 0 ? 'error' : 'info')}">${m.up === 1 ? m.latencyMs + 'ms' : (m.up === 0 ? 'DOWN' : '...')}</span></div>`).join('');
      const pbtn = tag.querySelector('[data-act="ping-now"]');
      if (pbtn) pbtn.onclick = () => { haptic(15); fetch('/api/monitors/run', { method: 'POST' }); };
    }
  }
  else if (type === 'rules_widget') {
    const rules = state.rules || [], paused = state.settings?.rules_paused === '1';
    tag.innerHTML = rules.length ? `<button class="btn sm ${paused ? 'danger' : 'primary'}" data-act="pause-rules">${paused ? 'Paused' : 'Active'}</button>` : '';
    if (!rules.length) body.innerHTML = emptyMsg('Create rules in Admin');
    else {
      body.className = 'card-body list-scroll';
      body.innerHTML = rules.map(r => `<div class="row-item"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name)}</span><button class="btn sm ${r.enabled ? 'primary' : ''}" data-tog-rule="${r.id}" data-en="${r.enabled ? '1' : '0'}">${r.enabled ? 'ON' : 'OFF'}</button><button class="btn sm" data-run-rule="${r.id}">${ico('play', 12)}</button></div>`).join('');
      tag.querySelector('[data-act="pause-rules"]').onclick = () => fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules_paused: paused ? '0' : '1' }) });
      body.querySelectorAll('[data-tog-rule]').forEach(b => { b.onclick = () => fetch('/api/rules/' + b.dataset.togRule, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: b.dataset.en !== '1' }) }); });
      body.querySelectorAll('[data-run-rule]').forEach(b => { b.onclick = () => { haptic(20); fetch('/api/rules/' + b.dataset.runRule + '/run', { method: 'POST' }); }; });
    }
  }
  else if (type === 'inbox') {
    const notifs = state.notifications || [];
    tag.innerHTML = `<span>${notifs.length}</span>` + (notifs.length ? ` <button class="btn sm" data-act="clr-notif">Clear</button>` : '');
    const clr = tag.querySelector('[data-act="clr-notif"]');
    if (clr) clr.onclick = () => fetch('/api/notifications', { method: 'DELETE' });
    if (!notifs.length) body.innerHTML = emptyMsg();
    else {
      body.className = 'card-body list-scroll';
      body.innerHTML = notifs.slice(0, 6).map(n => `<div class="row-item"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis"><b>${esc(n.title)}</b>: ${esc(n.body)}</span><span class="badge ${esc(n.level || 'info')}">${esc(n.source || 'hook')}</span></div>`).join('');
    }
  }
  else if (type === 'news_feed') {
    const news = state.news || [];
    tag.innerHTML = `<button class="btn sm" data-act="ref-news">${ico('refresh', 12)}</button>`;
    tag.querySelector('[data-act="ref-news"]').onclick = () => fetch('/api/news/refresh', { method: 'POST' });
    if (!news.length) body.innerHTML = emptyMsg('No articles cached');
    else {
      body.className = 'card-body list-scroll';
      body.innerHTML = news.slice(0, 8).map(n => `<div class="row-item" data-open-url="${esc(n.url)}" style="cursor:pointer"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n.title)}</span><small style="color:var(--muted)">${esc(n.source || '')}</small></div>`).join('');
      body.querySelectorAll('[data-open-url]').forEach(el => { el.onclick = () => fetch('/api/apps/uri', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri: el.dataset.openUrl }) }); });
    }
  }
  else if (type === 'wol') {
    const targets = state.wolTargets || [];
    tag.textContent = 'UDP :9';
    if (!targets.length) body.innerHTML = emptyMsg('Add PC MAC in Admin');
    else {
      body.className = 'card-body list-scroll';
      body.innerHTML = targets.map(w => `<button class="btn" data-wol-mac="${esc(w.mac)}" data-wol-bc="${esc(w.broadcast)}">${ico('zap', 13)} Wake ${esc(w.name)}</button>`).join('');
      body.querySelectorAll('[data-wol-mac]').forEach(b => {
        b.onclick = async () => {
          haptic(30);
          const r = await fetch('/api/wol/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mac: b.dataset.wolMac, broadcast: b.dataset.wolBc }) });
          const j = await r.json(); showToast('Wake-on-LAN', j.message || j.error || 'Sent');
        };
      });
    }
  }
  else if (type === 'timer') {
    tag.innerHTML = `<button class="btn sm" data-tm="mode">${qTimer.mode === 'timer' ? 'Timer' : 'Stopwatch'}</button>`;
    const shown = qTimer.mode === 'timer' ? fmtSec(qTimer.left) : fmtSec(qTimer.elapsed);
    body.innerHTML = `<div class="pomo-time">${shown}</div>
      <div class="pomo-btns">
        <button class="btn primary sm" data-tm="toggle">${qTimer.running ? 'Pause' : 'Start'}</button>
        <button class="btn sm" data-tm="p60">1m</button>
        <button class="btn sm" data-tm="p300">5m</button>
        <button class="btn sm" data-tm="reset">Reset</button>
      </div>`;
    tag.querySelector('[data-tm="mode"]').onclick = () => { qTimer.running = false; qTimer.mode = qTimer.mode === 'timer' ? 'sw' : 'timer'; store.onRerender?.(); };
    body.querySelector('[data-tm="toggle"]').onclick = () => {
      haptic(20); qTimer.running = !qTimer.running;
      if (qTimer.running && !qTimer.handle) {
        qTimer.handle = setInterval(() => {
          if (!qTimer.running) return;
          if (qTimer.mode === 'timer') {
            qTimer.left--;
            if (qTimer.left <= 0) { qTimer.running = false; qTimer.left = 0; fetch('/api/hw/beep', { method: 'POST' }); showToast('Timer Done', 'Countdown finished!'); }
          } else qTimer.elapsed++;
          store.onRerender?.();
        }, 1000);
      }
      store.onRerender?.();
    };
    body.querySelector('[data-tm="p60"]').onclick = () => { qTimer.mode = 'timer'; qTimer.running = false; qTimer.left = 60; store.onRerender?.(); };
    body.querySelector('[data-tm="p300"]').onclick = () => { qTimer.mode = 'timer'; qTimer.running = false; qTimer.left = 300; store.onRerender?.(); };
    body.querySelector('[data-tm="reset"]').onclick = () => { qTimer.running = false; if (qTimer.mode === 'timer') qTimer.left = 300; else qTimer.elapsed = 0; store.onRerender?.(); };
  }
  else if (type === 'pomodoro') {
    tag.textContent = pomo.running ? 'RUNNING' : 'READY';
    body.innerHTML = `<div class="pomo-time">${fmtSec(pomo.left)}</div>
      <div class="pomo-btns"><button class="btn primary sm" data-p="toggle">${pomo.running ? 'Pause' : 'Start'}</button><button class="btn sm" data-p="reset">Reset</button></div>`;
    body.querySelector('[data-p="toggle"]').onclick = () => {
      haptic(20); pomo.running = !pomo.running;
      if (pomo.running && !pomo.timer) {
        pomo.timer = setInterval(() => {
          if (!pomo.running) return;
          pomo.left--;
          if (pomo.left <= 0) { pomo.running = false; pomo.left = pomo.total; haptic(300); fetch('/api/hw/beep', { method: 'POST' }); showToast('Focus Complete', 'Pomodoro finished!'); }
          store.onRerender?.();
        }, 1000);
      }
      store.onRerender?.();
    };
    body.querySelector('[data-p="reset"]').onclick = () => { haptic(15); pomo.running = false; pomo.left = pomo.total; store.onRerender?.(); };
  }
}
