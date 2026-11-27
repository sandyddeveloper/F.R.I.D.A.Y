import { ico } from '/shared/icons.js';
import {
  store, haptic, esc, fmtTrackTime, sendPcInput,
  buildAudioOutputsHtml, buildAudioSessionsHtml, bindAudioSwitcherAndMixer, shortOutputName
} from '../lib/core.js';
import { classifyAudioDeviceKind, build3dAudioModelHtml, bindD3Viewport } from './models3d.js';

let smtcClockAnchor = { sig: '', pos: 0, dur: 0, at: 0, playing: false };
const d3AudioTilt = { rx: 14, ry: -18, dragging: false };

function getLiveSmtcPos(smtc) {
  const dur = Math.max(0, Number(smtc?.durSec || 0));
  const rawPos = Math.max(0, Number(smtc?.posSec || 0));
  const sig = `${smtc?.title || ''}|${rawPos}|${Boolean(smtc?.playing)}`;
  if (sig !== smtcClockAnchor.sig) {
    smtcClockAnchor = { sig, pos: rawPos, dur, at: Date.now(), playing: Boolean(smtc?.playing) };
  }
  if (!smtc?.active) return { pos: 0, dur: 0 };
  if (!smtc.playing || dur <= 0) return { pos: Math.min(dur || rawPos, rawPos), dur };
  const elapsed = Math.max(0, (Date.now() - smtcClockAnchor.at) / 1000);
  return { pos: Math.min(dur, smtcClockAnchor.pos + elapsed), dur };
}

export function tickMusicProgress() {
  if (Date.now() < store.musicSeekDragUntil) return;
  const smtc = store.state?.laptop?.control?.smtc;
  if (!smtc?.active) return;
  const { pos, dur } = getLiveSmtcPos(smtc);
  const pct = dur > 0 ? Math.min(100, Math.max(0, (pos / dur) * 100)) : 0;
  document.querySelectorAll('[data-wtype="pc_music_player"]').forEach(card => {
    const sk = card.querySelector('[data-ms-seek]');
    const pl = card.querySelector('[data-ms-pos]');
    if (sk) {
      sk.value = Math.round(pos);
      sk.style.setProperty('--p', `${pct.toFixed(1)}%`);
    }
    if (pl) pl.textContent = fmtTrackTime(pos);
  });
}

export function renderPcMusicPlayerWidget(body) {
  const ctrl = store.state?.laptop?.control || {};
  const smtc = ctrl.smtc || {};
  const hasVol = typeof ctrl.vol === 'number' && ctrl.vol >= 0;
  const vol = hasVol ? ctrl.vol : 0;
  const muted = Boolean(ctrl.muted);
  const { pos, dur } = getLiveSmtcPos(smtc);
  const pct = dur > 0 ? Math.min(100, Math.max(0, (pos / dur) * 100)) : 0;
  const artTs = Number(store.state?.smtcArt?.ts || 0);

  if (Date.now() < store.volDragLockUntil || Date.now() < store.musicSeekDragUntil) {
    const playBtn = body.querySelector('[data-ms-act="media_play"]');
    if (playBtn) playBtn.innerHTML = ico(smtc.playing ? 'pause' : 'play', 20);
    return;
  }

  const rawApp = String(smtc.app || '').split('!')[0].split('.').pop() || '';
  const srcName = rawApp ? rawApp.toUpperCase() : 'WINDOWS MEDIA';
  const titleText = smtc.title || 'Ready to Play';
  const subParts = [smtc.artist, smtc.album].filter(Boolean);
  const subText = subParts.length ? subParts.join(' · ') : (smtc.active ? (smtc.status || 'Paused') : 'Start Spotify, Chrome or VLC on laptop');
  const vinylFallbackHtml = `<div class="ms-vinyl-disc"><div class="ms-vinyl-core">${ico('music', 18)}</div></div>`;
  const artInner = artTs > 0 && smtc.hasThumb
    ? `<img class="ms-art-img" data-ms-art="1" src="/api/laptop/smtc-art?t=${artTs}" alt="Album Art">`
    : vinylFallbackHtml;

  body.innerHTML = `<div class="ms-player">
    <div class="ms-head">
      <div class="ms-art-wrap ${smtc.playing ? 'playing' : ''}">${artInner}</div>
      <div class="ms-meta">
        <div class="ms-source-row">
          <span class="ms-source">${esc(srcName)}</span>
          <span class="ms-eq ${smtc.playing ? 'playing' : ''}"><i></i><i></i><i></i></span>
        </div>
        <div class="ms-title">${esc(titleText)}</div>
        <div class="ms-sub">${esc(subText)}</div>
      </div>
    </div>
    <div class="ms-prog-wrap">
      <input type="range" class="ms-seek" data-ms-seek="1" min="0" max="${Math.max(1, Math.round(dur))}" value="${Math.round(pos)}" ${smtc.active && dur > 1 ? '' : 'disabled'} style="--p:${pct.toFixed(1)}%">
      <div class="ms-times">
        <span data-ms-pos="1">${smtc.active ? fmtTrackTime(pos) : '0:00'}</span>
        <span data-ms-dur="1">${dur > 0 ? fmtTrackTime(dur) : (smtc.active ? 'LIVE' : '0:00')}</span>
      </div>
    </div>
    <div class="ms-foot">
      <div class="ms-transport">
        <button type="button" class="ms-nav-btn" data-ms-act="media_prev" aria-label="Previous">${ico('skip-back', 18)}</button>
        <button type="button" class="ms-hero-play" data-ms-act="media_play" aria-label="Play or Pause">${ico(smtc.playing ? 'pause' : 'play', 20)}</button>
        <button type="button" class="ms-nav-btn" data-ms-act="media_next" aria-label="Next">${ico('skip-forward', 18)}</button>
      </div>
      <div class="ms-vol-wrap">
        <button type="button" class="ms-vol-btn ${muted ? 'muted' : ''}" data-ms-mute="1" aria-label="Mute">${ico(muted ? 'volume-x' : 'volume-2', 16)}</button>
        <input type="range" class="ms-vol-range" data-ms-vol="1" min="0" max="100" value="${vol}" ${hasVol ? '' : 'disabled'} style="--vp:${vol}%">
        <span class="ms-vol-num" data-ms-vol-lbl="1">${hasVol ? vol : '--'}</span>
      </div>
    </div>
  </div>`;

  const img = body.querySelector('[data-ms-art]');
  if (img) img.onerror = () => { if (img.parentNode) img.parentNode.innerHTML = vinylFallbackHtml; };

  body.querySelectorAll('[data-ms-act]').forEach(b => {
    b.onclick = () => { haptic(16); sendPcInput({ op: 'key', combo: b.dataset.msAct }); };
  });
  body.querySelector('[data-ms-mute]').onclick = () => { haptic(18); sendPcInput({ op: 'toggle_mute' }); };

  const seekEl = body.querySelector('[data-ms-seek]');
  const posEl = body.querySelector('[data-ms-pos]');
  seekEl.oninput = (e) => {
    store.musicSeekDragUntil = Date.now() + 2000;
    const v = Number(e.target.value);
    const maxV = Math.max(1, Number(seekEl.max || 1));
    seekEl.style.setProperty('--p', `${Math.min(100, (v / maxV) * 100).toFixed(1)}%`);
    if (posEl) posEl.textContent = fmtTrackTime(v);
  };
  seekEl.onchange = (e) => {
    const v = Number(e.target.value);
    store.musicSeekDragUntil = Date.now() + 1400;
    smtcClockAnchor = { ...smtcClockAnchor, sig: '', pos: v, at: Date.now() };
    sendPcInput({ op: 'seek_smtc', posSec: v });
  };

  const vr = body.querySelector('[data-ms-vol]');
  const vLbl = body.querySelector('[data-ms-vol-lbl]');
  vr.oninput = (e) => {
    store.volDragLockUntil = Date.now() + 1800;
    vr.style.setProperty('--vp', `${e.target.value}%`);
    vLbl.textContent = String(e.target.value);
  };
  vr.onchange = (e) => {
    store.volDragLockUntil = Date.now() + 1200;
    sendPcInput({ op: 'set_vol', pct: Number(e.target.value) });
  };
}

export function renderPcAudioStageWidget(body) {
  const ctrl = store.state?.laptop?.control || {};
  const outputs = Array.isArray(ctrl.outputs) ? ctrl.outputs : [];
  const sessions = Array.isArray(ctrl.audioSessions) ? ctrl.audioSessions : [];
  const smtc = ctrl.smtc || {};
  if (d3AudioTilt.dragging || [...store.appVolDragLocks.values()].some(t => Date.now() < t)) return;

  const activeOut = outputs.find(o => o.isDefault) || outputs[0] || { name: 'System Audio' };
  const devKindLabel = classifyAudioDeviceKind(activeOut.name).toUpperCase();

  body.innerHTML = `<div class="d3-card-wrap">
    <div class="d3-stage">
      <div class="d3-top-bar">
        <span class="d3-dev-pill" title="${esc(activeOut.name)}">${esc(shortOutputName(activeOut.name))}</span>
        <span class="d3-hint">${esc(devKindLabel)} · 3D</span>
      </div>
      <div class="d3-viewport" data-d3-vp="1">
        <div class="d3-rig idle-float" data-d3-rig="1" style="--rx:${d3AudioTilt.rx}deg;--ry:${d3AudioTilt.ry}deg">
          <div class="d3-floor ${smtc.playing ? 'playing' : ''}"></div>
          ${build3dAudioModelHtml(activeOut)}
        </div>
      </div>
      <div class="d3-foot-row">${buildAudioOutputsHtml(outputs)}</div>
    </div>
    <div class="d3-mixer-box">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="wx-title">APP MIXER</span>
        <span class="sub-muted" style="margin:0;font-size:10px">${sessions.length} active</span>
      </div>
      ${buildAudioSessionsHtml(sessions)}
    </div>
  </div>`;

  bindAudioSwitcherAndMixer(body);
  bindD3Viewport(body, d3AudioTilt);
}
