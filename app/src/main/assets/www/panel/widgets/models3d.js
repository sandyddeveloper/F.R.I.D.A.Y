export function classifyAudioDeviceKind(name) {
  const n = String(name || '').toLowerCase();
  if (/buds|airpods|earbud|tws|pod|freebuds|wf-|galaxy buds/i.test(n)) return 'earbuds';
  if (/headphone|headset|wh-1|xm4|xm5|qc|over-ear|arctis/i.test(n)) return 'headphones';
  if (/transcreen|hdmi|display|monitor|tv|projector|dp audio|nvidia high|amd high/i.test(n)) return 'display';
  return 'speaker';
}

export function build3dAudioModelHtml(dev) {
  const kind = classifyAudioDeviceKind(dev?.name);
  if (kind === 'earbuds') {
    return `
      <div class="d3-layer" style="transform:translateZ(-14px)">
        <svg viewBox="0 0 160 110" width="138" height="95" aria-hidden="true">
          <defs>
            <linearGradient id="d3CaseBg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#334155"/><stop offset="100%" stop-color="#0f172a"/>
            </linearGradient>
            <linearGradient id="d3Lid" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#64748b"/><stop offset="100%" stop-color="#1e293b"/>
            </linearGradient>
          </defs>
          <path d="M40 40 C40 16, 120 16, 120 40 Z" fill="url(#d3Lid)" stroke="rgba(255,255,255,0.24)" stroke-width="1.2"/>
          <rect x="34" y="42" width="92" height="54" rx="26" fill="url(#d3CaseBg)" stroke="rgba(255,255,255,0.2)" stroke-width="1.4"/>
        </svg>
      </div>
      <div class="d3-layer" style="transform:translateZ(6px)">
        <svg viewBox="0 0 160 110" width="138" height="95" aria-hidden="true">
          <ellipse cx="80" cy="48" rx="34" ry="8" fill="#090d16" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>
          <circle cx="80" cy="69" r="3" fill="var(--accent)"/>
          <circle cx="80" cy="69" r="8" fill="var(--accent)" opacity="0.25"/>
        </svg>
      </div>
      <div class="d3-layer" style="transform:translateZ(22px)">
        <svg viewBox="0 0 160 110" width="138" height="95" aria-hidden="true">
          <defs>
            <linearGradient id="d3BudStem" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#f1f5f9"/><stop offset="55%" stop-color="#94a3b8"/><stop offset="100%" stop-color="#334155"/>
            </linearGradient>
          </defs>
          <rect x="57" y="34" width="8" height="32" rx="4" transform="rotate(-12 61 50)" fill="url(#d3BudStem)"/>
          <ellipse cx="56" cy="31" rx="11" ry="8.5" fill="#1e293b" stroke="rgba(255,255,255,0.36)" stroke-width="1.2"/>
          <rect x="95" y="34" width="8" height="32" rx="4" transform="rotate(12 99 50)" fill="url(#d3BudStem)"/>
          <ellipse cx="104" cy="31" rx="11" ry="8.5" fill="#1e293b" stroke="rgba(255,255,255,0.36)" stroke-width="1.2"/>
        </svg>
      </div>
      <div class="d3-layer" style="transform:translateZ(35px)">
        <svg viewBox="0 0 160 110" width="138" height="95" aria-hidden="true">
          <ellipse cx="47" cy="32" rx="4.2" ry="5.6" fill="var(--accent)" opacity="0.9"/>
          <ellipse cx="113" cy="32" rx="4.2" ry="5.6" fill="var(--accent)" opacity="0.9"/>
          <circle cx="62" cy="32" r="2.2" fill="#f8fafc" opacity="0.72"/>
          <circle cx="98" cy="32" r="2.2" fill="#f8fafc" opacity="0.72"/>
        </svg>
      </div>`;
  }
  if (kind === 'headphones') {
    return `
      <div class="d3-layer" style="transform:translateZ(-12px)">
        <svg viewBox="0 0 160 110" width="138" height="95" aria-hidden="true">
          <path d="M40 58 C40 16, 120 16, 120 58" fill="none" stroke="#475569" stroke-width="10" stroke-linecap="round"/>
          <path d="M44 54 C44 21, 116 21, 116 54" fill="none" stroke="rgba(255,255,255,0.24)" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="d3-layer" style="transform:translateZ(12px)">
        <svg viewBox="0 0 160 110" width="138" height="95" aria-hidden="true">
          <rect x="26" y="48" width="22" height="38" rx="11" fill="#1e293b" stroke="rgba(255,255,255,0.3)" stroke-width="1.4"/>
          <rect x="112" y="48" width="22" height="38" rx="11" fill="#1e293b" stroke="rgba(255,255,255,0.3)" stroke-width="1.4"/>
        </svg>
      </div>
      <div class="d3-layer" style="transform:translateZ(28px)">
        <svg viewBox="0 0 160 110" width="138" height="95" aria-hidden="true">
          <rect x="33" y="54" width="10" height="26" rx="5" fill="#090d16" stroke="var(--accent)" stroke-width="1.5"/>
          <rect x="117" y="54" width="10" height="26" rx="5" fill="#090d16" stroke="var(--accent)" stroke-width="1.5"/>
        </svg>
      </div>`;
  }
  if (kind === 'display') {
    return `
      <div class="d3-layer" style="transform:translateZ(-16px)">
        <svg viewBox="0 0 160 110" width="138" height="95" aria-hidden="true">
          <path d="M56 96 L104 96 L94 88 L66 88 Z" fill="#475569"/>
          <rect x="73" y="70" width="14" height="20" rx="3" fill="#334155"/>
        </svg>
      </div>
      <div class="d3-layer" style="transform:translateZ(4px)">
        <svg viewBox="0 0 160 110" width="138" height="95" aria-hidden="true">
          <defs>
            <linearGradient id="d3Scr" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.4"/><stop offset="60%" stop-color="#1e1b4b" stop-opacity="0.9"/><stop offset="100%" stop-color="#ec4899" stop-opacity="0.38"/>
            </linearGradient>
          </defs>
          <rect x="16" y="14" width="128" height="60" rx="8" fill="#0f172a" stroke="rgba(255,255,255,0.28)" stroke-width="1.5"/>
          <rect x="21" y="19" width="118" height="50" rx="4" fill="url(#d3Scr)"/>
        </svg>
      </div>
      <div class="d3-layer" style="transform:translateZ(26px)">
        <svg viewBox="0 0 160 110" width="138" height="95" aria-hidden="true">
          <rect x="30" y="74" width="100" height="14" rx="7" fill="#1e293b" stroke="rgba(255,255,255,0.28)" stroke-width="1.2"/>
          <line x1="50" y1="81" x2="110" y2="81" stroke="var(--accent)" stroke-width="2" stroke-dasharray="3 3" stroke-linecap="round"/>
        </svg>
      </div>`;
  }
  return `
    <div class="d3-layer" style="transform:translateZ(-14px)">
      <svg viewBox="0 0 160 110" width="138" height="95" aria-hidden="true">
        <rect x="44" y="10" width="72" height="90" rx="14" fill="#0f172a" stroke="rgba(255,255,255,0.18)" stroke-width="1.3"/>
      </svg>
    </div>
    <div class="d3-layer" style="transform:translateZ(8px)">
      <svg viewBox="0 0 160 110" width="138" height="95" aria-hidden="true">
        <rect x="48" y="14" width="64" height="82" rx="11" fill="#1e293b" stroke="rgba(255,255,255,0.26)" stroke-width="1.3"/>
        <circle cx="80" cy="31" r="9" fill="#090d16" stroke="rgba(255,255,255,0.3)" stroke-width="1.2"/>
        <circle cx="80" cy="64" r="22" fill="#090d16" stroke="rgba(255,255,255,0.24)" stroke-width="1.6"/>
      </svg>
    </div>
    <div class="d3-layer" style="transform:translateZ(24px)">
      <svg viewBox="0 0 160 110" width="138" height="95" aria-hidden="true">
        <circle cx="80" cy="31" r="3.5" fill="var(--accent)" opacity="0.9"/>
        <circle cx="80" cy="64" r="15" fill="none" stroke="var(--accent)" stroke-width="2" opacity="0.78"/>
        <circle cx="80" cy="64" r="7" fill="#334155" stroke="rgba(255,255,255,0.4)" stroke-width="1.2"/>
      </svg>
    </div>`;
}

export function build3dPhoneHtml(ph) {
  const bat = Math.max(8, Math.min(100, Number(ph?.batteryPct ?? 50)));
  const fillH = Math.round((bat / 100) * 28);
  const col = ph?.charging ? '#4ade80' : (bat <= 20 ? '#f87171' : '#2dd4bf');
  return `
    <div class="d3-layer" style="transform:translateZ(-8px)">
      <svg viewBox="0 0 90 60" width="56" height="38" aria-hidden="true">
        <rect x="27" y="4" width="36" height="52" rx="8" fill="#0f172a" stroke="rgba(255,255,255,0.22)" stroke-width="1.4"/>
      </svg>
    </div>
    <div class="d3-layer" style="transform:translateZ(6px)">
      <svg viewBox="0 0 90 60" width="56" height="38" aria-hidden="true">
        <rect x="30" y="7" width="30" height="46" rx="5.5" fill="#131c2e" stroke="rgba(255,255,255,0.24)" stroke-width="1"/>
        <rect x="37" y="${47 - Math.min(22, fillH)}" width="16" height="${Math.min(22, fillH)}" rx="3" fill="${col}" opacity="0.78"/>
      </svg>
    </div>
    <div class="d3-layer" style="transform:translateZ(16px)">
      <svg viewBox="0 0 90 60" width="56" height="38" aria-hidden="true">
        <rect x="39" y="9" width="12" height="2.4" rx="1.2" fill="#94a3b8"/>
        <circle cx="45" cy="30" r="5" fill="${col}" opacity="0.92"/>
      </svg>
    </div>`;
}

export function build3dLaptopHtml(lap) {
  const load = Math.max(Number(lap?.cpuPct || 0), Number(lap?.gpuPct || 0));
  const glowCol = load >= 80 ? '#f87171' : (load >= 45 ? '#f59e0b' : '#2dd4bf');
  return `
    <div class="d3-layer" style="transform:translateZ(-10px)">
      <svg viewBox="0 0 110 64" width="66" height="40" aria-hidden="true">
        <rect x="20" y="8" width="70" height="38" rx="5" fill="#1e293b" stroke="rgba(255,255,255,0.28)" stroke-width="1.3"/>
        <rect x="24" y="12" width="62" height="30" rx="2.5" fill="#090d16"/>
      </svg>
    </div>
    <div class="d3-layer" style="transform:translateZ(6px)">
      <svg viewBox="0 0 110 64" width="66" height="40" aria-hidden="true">
        <rect x="30" y="17" width="50" height="20" rx="3" fill="${glowCol}" opacity="0.22"/>
        <circle cx="55" cy="27" r="6" fill="none" stroke="${glowCol}" stroke-width="1.8"/>
      </svg>
    </div>
    <div class="d3-layer" style="transform:translateZ(18px)">
      <svg viewBox="0 0 110 64" width="66" height="40" aria-hidden="true">
        <path d="M14 48 L96 48 L104 56 L6 56 Z" fill="#334155" stroke="rgba(255,255,255,0.28)" stroke-width="1.1"/>
        <rect x="44" y="51" width="22" height="3" rx="1.5" fill="${glowCol}" opacity="0.85"/>
      </svg>
    </div>`;
}

export function bindD3Viewport(container, tiltState) {
  const vp = container.querySelector('[data-d3-vp]');
  const rig = container.querySelector('[data-d3-rig]');
  if (!vp || !rig) return;
  let sx = 0, sy = 0, brx = tiltState.rx, bry = tiltState.ry;
  vp.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    tiltState.dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    brx = tiltState.rx;
    bry = tiltState.ry;
    try { vp.setPointerCapture(e.pointerId); } catch (_) {}
  });
  vp.addEventListener('pointermove', (e) => {
    if (!tiltState.dragging) return;
    e.stopPropagation();
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    tiltState.rx = Math.max(-28, Math.min(28, brx - dy * 0.36));
    tiltState.ry = Math.max(-48, Math.min(48, bry + dx * 0.48));
    rig.style.setProperty('--rx', `${tiltState.rx.toFixed(1)}deg`);
    rig.style.setProperty('--ry', `${tiltState.ry.toFixed(1)}deg`);
  });
  const endDrag = () => { tiltState.dragging = false; };
  vp.addEventListener('pointerup', endDrag);
  vp.addEventListener('pointercancel', endDrag);
}
