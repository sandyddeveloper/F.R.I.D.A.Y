import { ico } from '/shared/icons.js';
import { store, haptic, esc, fmtUptime, fmtNetRate, buildSparkSvg } from '../lib/core.js';
import { build3dPhoneHtml, build3dLaptopHtml, bindD3Viewport } from './models3d.js';

const miniTiltPhone = { rx: 12, ry: -16, dragging: false };
const miniTiltLaptop = { rx: 14, ry: -18, dragging: false };

export function renderHardwareMonitorGrid(body, mode) {
  const isLap = mode === 'laptop';
  const tilt = isLap ? miniTiltLaptop : miniTiltPhone;
  if (tilt.dragging) return;

  const s = store.state || {};
  const m = s.metrics || {};
  const lap = s.laptop || {};
  const ph = s.telemetry || {};

  const targetPageId = isLap ? 'phone_hw' : 'laptop';
  const hasOtherPage = (s.pages || []).some(p => p.id === targetPageId);
  const jumpToTarget = () => {
    haptic(15);
    const idx = (s.pages || []).findIndex(p => p.id === targetPageId);
    if (idx >= 0 && store.onNavigatePage) store.onNavigatePage(idx);
  };

  if (isLap && !lap.sampledAt && !lap.updatedAt) {
    body.innerHTML = `<div class="hw-shell">
      <div class="hw-head-mini">
        <div class="hw-host">
          <div class="d3-mini-vp" data-d3-vp="1"><div class="d3-mini-rig" data-d3-rig="1" style="--rx:${tilt.rx}deg;--ry:${tilt.ry}deg">${build3dLaptopHtml({ cpuPct: 10, gpuPct: 0 })}</div></div>
          <span class="agy-live-pill idle"><i class="agy-beacon"></i>Laptop Offline</span>
          <small>Run <code>friday connect</code> on your PC</small>
        </div>
        ${hasOtherPage ? `<button type="button" class="hw-switch-btn" data-hw-jump="${targetPageId}">${ico('smartphone', 11)} Mobile</button>` : ''}
      </div>
      <div class="hw-empty" style="flex:1 1 auto">Waiting for paired laptop telemetry stream...</div>
    </div>`;
    bindD3Viewport(body, tilt);
    const btn = body.querySelector('[data-hw-jump]');
    if (btn) btn.onclick = jumpToTarget;
    return;
  }

  const staleSec = isLap ? Math.max(0, Math.floor((Date.now() - Number(lap.updatedAt || lap.sampledAt || 0)) / 1000)) : 0;
  const hostTitle = isLap ? `${lap.hostname || 'Laptop'} · Windows` : `${ph.deviceName || 'Mobile Server'} · Android ${ph.androidVersion || ''}`;
  const liveLabel = isLap ? (staleSec > 12 ? `${staleSec}s ago` : 'live') : 'live';
  const liveClass = isLap && staleSec > 12 ? 'idle' : '';

  const cpuPct = isLap ? (lap.cpuPct ?? null) : (ph.cpuPct >= 0 ? ph.cpuPct : null);
  const cpuModel = isLap ? (lap.cpuName || 'CPU') : (ph.socName || ph.deviceName || 'SoC');
  const cpuClockStr = isLap
    ? `${lap.cpuClockMhz ? (lap.cpuClockMhz / 1000).toFixed(2) + ' GHz' : 'N/A'} · ${lap.cpuCores || 0}T`
    : `${ph.socTempC > 0 ? ph.socTempC + '°C · ' : ''}${ph.cpuFreqMhz > 0 ? (ph.cpuFreqMhz / 1000).toFixed(2) + ' GHz' : `${ph.cpuCores || 0}C`}`;
  const cpuSeries = isLap ? (m.lap_cpuPct || []) : (m.cpuPct || []);

  const card2Title = isLap ? 'GRAPHICS' : 'POWER & THERMAL';
  const card2Model = isLap ? (lap.gpuName || 'No GPU API') : (ph.socTempC > 0 ? `SoC ${ph.socTempC}°C` : 'Battery');
  const card2Hero = isLap
    ? (lap.gpuPct != null ? `${Math.round(lap.gpuPct)}<small>%</small>` : 'N/A')
    : (ph.batteryPct >= 0 ? `${ph.batteryPct}<small>%</small>` : 'N/A');
  const card2Pill = isLap
    ? [lap.gpuTempC != null ? `${lap.gpuTempC}°C` : null, lap.gpuPowerW != null ? `${Number(lap.gpuPowerW).toFixed(0)}W` : null].filter(Boolean).join(' · ') || 'No sensor'
    : [ph.tempC > 0 ? `Bat ${ph.tempC}°C` : null, ph.powerW > 0 ? `${Number(ph.powerW).toFixed(1)}W` : null, ph.chargeSource || ''].filter(Boolean).join(' · ');
  const card2Series = isLap
    ? (m.lap_gpuPct || [])
    : ((m.socTempC && m.socTempC.length >= 2) ? m.socTempC : (m.batteryPct || []));
  const card2FixedMax = isLap ? 100 : ((m.socTempC && m.socTempC.length >= 2) ? null : 100);

  const uptimeStr = `Up ${fmtUptime(isLap ? lap.uptimeSec : ph.deviceUptimeSec)}`;
  const ramPct = isLap ? Number(lap.ramPct || 0) : Math.max(0, Number(ph.ramPct || 0));
  const ramText = isLap
    ? `${lap.ramUsedGb ?? '--'} / ${lap.ramTotalGb ?? '--'} GB`
    : `${((ph.ramUsedMb || 0) / 1024).toFixed(1)} / ${((ph.ramTotalMb || 0) / 1024).toFixed(1)} GB`;

  let memExtraBars = '';
  let diskHtml = '';
  if (isLap) {
    if (lap.vramTotalMb > 0) {
      const vUsed = ((Number(lap.vramUsedMb || 0)) / 1024).toFixed(1);
      const vTot = ((Number(lap.vramTotalMb || 0)) / 1024).toFixed(1);
      const vPct = Math.round((Number(lap.vramUsedMb || 0) / Number(lap.vramTotalMb)) * 100);
      memExtraBars += `<div class="hw-bar-row">
        <div class="hw-bar-head"><span>VRAM</span><span>${vUsed} / ${vTot} GB</span></div>
        <div class="hw-bar-track"><div class="hw-bar-fill" style="width:${vPct}%;background:#84cc16;box-shadow:0 0 8px rgba(132,204,22,0.5)"></div></div>
      </div>`;
    }
    if (lap.igpuName) {
      const igGb = lap.igpuVramMb > 0 ? `${(lap.igpuVramMb / 1024).toFixed(1)} GB` : 'Shared';
      memExtraBars += `<div class="hw-bar-row">
        <div class="hw-bar-head"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(lap.igpuName)}</span><span>${igGb}</span></div>
        <div class="hw-bar-track"><div class="hw-bar-fill" style="width:${lap.vramTotalMb > 0 ? Math.min(100, Math.round((lap.igpuVramMb / lap.vramTotalMb) * 100)) : 25}%;background:#38bdf8;opacity:0.7"></div></div>
      </div>`;
    }
    const disks = Array.isArray(lap.disks) ? lap.disks : [];
    diskHtml = disks.length
      ? disks.slice(0, 4).map(d => `<div class="hw-disk-item">
          <div class="hw-disk-top"><b>${esc(d.label)}</b><small>${d.usedGb}/${d.totalGb}G · ${d.pct}%</small></div>
          <div class="hw-bar-track"><div class="hw-bar-fill" style="width:${d.pct}%;background:${d.pct >= 85 ? '#f59e0b' : '#a78bfa'}"></div></div>
        </div>`).join('')
      : '<div class="hw-disk-item"><small style="color:var(--muted)">No disks reported</small></div>';
  } else {
    const dPct = Math.max(0, Number(ph.storagePct || 0));
    memExtraBars = `<div class="hw-bar-row">
      <div class="hw-bar-head"><span>Internal Storage</span><span>${ph.storageUsedGb ?? 0} / ${ph.storageTotalGb ?? 0} GB</span></div>
      <div class="hw-bar-track"><div class="hw-bar-fill" style="width:${dPct}%;background:#38bdf8;box-shadow:0 0 8px rgba(56,189,248,0.45)"></div></div>
    </div>`;
    diskHtml = `
      <div class="hw-disk-item">
        <div class="hw-disk-top"><b>Free Space</b><small>${ph.storageFreeGb ?? 0} GB</small></div>
        <div class="hw-bar-track"><div class="hw-bar-fill" style="width:${Math.max(0, 100 - dPct)}%;background:#2dd4bf"></div></div>
      </div>
      <div class="hw-disk-item">
        <div class="hw-disk-top"><b>Voltage</b><small>${ph.voltageMv > 0 ? (ph.voltageMv / 1000).toFixed(2) + 'V' : 'N/A'} · ${ph.currentMa ?? 0}mA</small></div>
        <div class="hw-bar-track"><div class="hw-bar-fill" style="width:${Math.max(0, Number(ph.batteryPct || 0))}%;background:#84cc16"></div></div>
      </div>`;
  }

  const rxKbps = isLap ? lap.netRxKbps : ph.netRxKbps;
  const txKbps = isLap ? lap.netTxKbps : ph.netTxKbps;
  const netMeta = isLap
    ? (lap.pingMs >= 0 ? `Ping ${lap.pingMs} ms · loss ${lap.lossPct ?? 0}%` : (lap.lossPct != null ? `Offline · loss ${lap.lossPct}%` : 'LAN active'))
    : (ph.wifiConnected ? `Wi-Fi ${ph.wifiRssi} dBm · ${ph.ip || ''}` : 'Wi-Fi offline');
  const rxSeries = isLap ? (m.lap_netRxKbps || []) : (m.netRxKbps || []);
  const txSeries = isLap ? (m.lap_netTxKbps || []) : (m.netTxKbps || []);
  const miniModelHtml = isLap ? build3dLaptopHtml(lap) : build3dPhoneHtml(ph);

  body.innerHTML = `<div class="hw-shell">
    <div class="hw-head-mini">
      <div class="hw-host">
        <div class="d3-mini-vp" data-d3-vp="1" title="Drag 3D Hardware">
          <div class="d3-mini-rig" data-d3-rig="1" style="--rx:${tilt.rx}deg;--ry:${tilt.ry}deg">${miniModelHtml}</div>
        </div>
        <span class="agy-live-pill ${liveClass}"><i class="agy-beacon"></i>${liveLabel}</span>
        <span>${esc(hostTitle)}</span>
      </div>
      ${hasOtherPage ? `<button type="button" class="hw-switch-btn" data-hw-jump="${targetPageId}">${ico(isLap ? 'smartphone' : 'cpu', 11)} ${isLap ? 'Mobile' : 'Laptop'}</button>` : ''}
    </div>
    <div class="hw-grid">
      <div class="hw-card" style="--hw-c:#2dd4bf">
        <div class="hw-top">
          <span class="hw-title">PROCESSOR</span>
          <div class="hw-meta">
            <span class="hw-model">${esc(cpuModel)}</span>
            <span class="hw-pill">${esc(cpuClockStr)}</span>
          </div>
        </div>
        <div class="hw-hero-row">
          <div class="hw-pct">${cpuPct != null ? `${Math.round(cpuPct)}<small>%</small>` : 'N/A'}</div>
        </div>
        <div class="hw-chart">${buildSparkSvg([{ points: cpuSeries, color: '#2dd4bf' }], 100, isLap ? 'lcpu' : 'pcpu')}</div>
      </div>

      <div class="hw-card" style="--hw-c:#84cc16">
        <div class="hw-top">
          <span class="hw-title">${card2Title}</span>
          <div class="hw-meta">
            <span class="hw-model">${esc(card2Model)}</span>
            <span class="hw-pill">${esc(card2Pill)}</span>
          </div>
        </div>
        <div class="hw-hero-row">
          <div class="hw-pct">${card2Hero}</div>
        </div>
        <div class="hw-chart">${buildSparkSvg([{ points: card2Series, color: '#84cc16' }], card2FixedMax, isLap ? 'lgpu' : 'pgpu')}</div>
      </div>

      <div class="hw-card" style="--hw-c:#a78bfa">
        <div class="hw-top">
          <span class="hw-title">MEMORY</span>
          <span class="hw-sub-right">${esc(uptimeStr)}</span>
        </div>
        <div class="hw-mem-rows">
          <div class="hw-bar-row">
            <div class="hw-bar-head"><span>RAM</span><span>${esc(ramText)}</span></div>
            <div class="hw-bar-track"><div class="hw-bar-fill" style="width:${ramPct}%;background:#a78bfa;box-shadow:0 0 8px rgba(167,139,250,0.5)"></div></div>
          </div>
          ${memExtraBars}
        </div>
        <div class="hw-disks">${diskHtml}</div>
      </div>

      <div class="hw-card" style="--hw-c:#f59e0b">
        <div class="hw-top">
          <span class="hw-title">NETWORK</span>
          <span class="hw-sub-right">${esc(netMeta)}</span>
        </div>
        <div class="hw-net-rates">
          <span class="hw-rate-dl">↓ ${esc(fmtNetRate(rxKbps))}</span>
          <span class="hw-rate-ul">↑ ${esc(fmtNetRate(txKbps))}</span>
        </div>
        <div class="hw-chart">${buildSparkSvg([
          { points: rxSeries, color: '#f59e0b' },
          { points: txSeries, color: '#38bdf8' }
        ], null, isLap ? 'lnet' : 'pnet')}</div>
      </div>
    </div>
  </div>`;

  bindD3Viewport(body, tilt);
  const btn = body.querySelector('[data-hw-jump]');
  if (btn) btn.onclick = jumpToTarget;
}
