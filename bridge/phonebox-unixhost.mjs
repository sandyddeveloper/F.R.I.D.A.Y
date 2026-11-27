import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IS_MAC = process.platform === 'darwin';
let cachedApps = null;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function runCmd(bin, args = [], timeout = 1800) {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout, maxBuffer: 6 * 1024 * 1024 });
    return { ok: true, out: String(stdout || '').trim() };
  } catch (e) {
    return { ok: false, out: String(e?.stdout || '').trim() };
  }
}

async function getVolState() {
  if (IS_MAC) {
    const r = await runCmd('osascript', ['-e', 'output volume of (get volume settings) & "," & output muted of (get volume settings)']);
    const [v, m] = r.out.split(',');
    return { vol: Number(v || 50), muted: String(m || '').trim() === 'true' };
  }
  const rv = await runCmd('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
  const rm = await runCmd('pactl', ['get-sink-mute', '@DEFAULT_SINK@']);
  const m = rv.out.match(/(\d+)%/);
  return { vol: m ? Number(m[1]) : 50, muted: /yes/i.test(rm.out) };
}

async function listOutputs() {
  if (IS_MAC) {
    const r = await runCmd('SwitchAudioSource', ['-a', '-t', 'output']);
    const cur = await runCmd('SwitchAudioSource', ['-c', '-t', 'output']);
    if (!r.ok || !r.out) return [{ id: 'default', name: 'Mac Speakers', kind: 'speaker', active: true }];
    return r.out.split(/\r?\n/).filter(Boolean).map((name) => ({
      id: name,
      name,
      kind: /airpods|buds|headphone|bluetooth/i.test(name) ? 'headphones' : (/hdmi|display/i.test(name) ? 'display' : 'speaker'),
      active: name.trim() === cur.out.trim()
    }));
  }
  const r = await runCmd('pactl', ['list', 'short', 'sinks']);
  const def = await runCmd('pactl', ['get-default-sink']);
  if (!r.ok || !r.out) return [];
  return r.out.split(/\r?\n/).filter(Boolean).map((line) => {
    const cols = line.split(/\t+/);
    const id = cols[1] || cols[0] || '';
    return {
      id,
      name: id.replace(/^alsa_output\./, '').replace(/\./g, ' '),
      kind: /bluez|headphone/i.test(id) ? 'headphones' : (/hdmi/i.test(id) ? 'display' : 'speaker'),
      active: id === def.out.trim()
    };
  });
}

async function listAudioSessions() {
  if (IS_MAC) return [];
  const r = await runCmd('pactl', ['list', 'sink-inputs']);
  if (!r.ok || !r.out) return [];
  const blocks = r.out.split(/Sink Input #/).slice(1);
  return blocks.slice(0, 12).map((blk) => {
    const idM = blk.match(/^(\d+)/);
    const nameM = blk.match(/application\.name\s*=\s*"([^"]+)"/) || blk.match(/media\.name\s*=\s*"([^"]+)"/);
    const volM = blk.match(/Volume:[^\n]*?(\d+)%/);
    const muteM = blk.match(/Mute:\s*(yes|no)/i);
    return {
      key: idM ? idM[1] : '',
      name: nameM ? nameM[1] : 'Audio Stream',
      vol: volM ? Number(volM[1]) : 100,
      muted: muteM ? /yes/i.test(muteM[1]) : false
    };
  }).filter(x => x.key);
}

async function getMediaState() {
  if (IS_MAC) {
    const sc = 'if application "Spotify" is running then tell application "Spotify" to return "Spotify|" & player state & "|" & name of current track & "|" & artist of current track';
    const r = await runCmd('osascript', ['-e', sc]);
    if (r.ok && r.out.includes('|')) {
      const [source, st, title, artist] = r.out.split('|');
      return { active: true, playing: st === 'playing', title, artist, source, posSec: 0, durSec: 0, hasThumb: false };
    }
    return { active: false };
  }
  const r = await runCmd('playerctl', ['metadata', '--format', '{{playerName}}|{{status}}|{{title}}|{{artist}}|{{mpris:length}}|{{position}}']);
  if (!r.ok || !r.out.includes('|')) return { active: false };
  const [source, status, title, artist, lenUs, posUs] = r.out.split('|');
  if (!title) return { active: false };
  return {
    active: true,
    playing: /playing/i.test(status),
    title,
    artist,
    source: source || 'Media',
    durSec: lenUs ? Math.round(Number(lenUs) / 1e6) : 0,
    posSec: posUs ? Math.round(Number(posUs) / 1e6) : 0,
    hasThumb: false,
    thumbKey: `${source}:${title}`
  };
}

async function getDesktopWindows() {
  if (IS_MAC) return [];
  const r = await runCmd('wmctrl', ['-lp']);
  if (!r.ok || !r.out) return [];
  return r.out.split(/\r?\n/).filter(Boolean).slice(0, 20).map((ln) => {
    const parts = ln.trim().split(/\s+/);
    const hwnd = parts[0];
    const title = parts.slice(4).join(' ');
    return { hwnd, title, app: parts[3] || 'window', active: false };
  });
}

async function captureScreenB64(maxW = 960) {
  const tmpPng = path.join(os.tmpdir(), `friday_cap_${Date.now()}.jpg`);
  try {
    if (IS_MAC) {
      await runCmd('screencapture', ['-x', '-t', 'jpg', tmpPng], 2500);
      await runCmd('sips', ['-Z', String(maxW), tmpPng], 2000);
    } else {
      let ok = (await runCmd('grim', ['-t', 'jpeg', '-q', '68', tmpPng], 2500)).ok;
      if (!ok) ok = (await runCmd('scrot', ['-q', '68', '-z', tmpPng], 2500)).ok;
      if (!ok) await runCmd('import', ['-window', 'root', '-resize', `${maxW}x`, '-quality', '68', tmpPng], 2500);
    }
    if (!fs.existsSync(tmpPng)) return { w: 0, h: 0, b64: '' };
    const b64 = fs.readFileSync(tmpPng).toString('base64');
    return { w: maxW, h: Math.round(maxW * 0.5625), b64 };
  } catch (_) {
    return { w: 0, h: 0, b64: '' };
  } finally {
    try { fs.unlinkSync(tmpPng); } catch (_) {}
  }
}

async function scanInstalledApps() {
  if (cachedApps) return cachedApps;
  const list = [];
  try {
    if (IS_MAC) {
      for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.app')) list.push({ name: f.replace(/\.app$/, ''), appId: path.join(dir, f) });
        }
      }
    } else {
      for (const dir of ['/usr/share/applications', path.join(os.homedir(), '.local/share/applications')]) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.desktop')) list.push({ name: f.replace(/\.desktop$/, ''), appId: f.replace(/\.desktop$/, '') });
        }
      }
    }
  } catch (_) {}
  cachedApps = list.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 120);
  return cachedApps;
}

async function handleCmd(cmd) {
  const rid = cmd.id || '';
  switch (cmd.op) {
    case 'get_control_state': {
      const [vs, outputs, audioSessions, smtc, wins] = await Promise.all([
        getVolState(), listOutputs(), listAudioSessions(), getMediaState(), getDesktopWindows()
      ]);
      const clipRes = IS_MAC ? await runCmd('pbpaste') : (await runCmd('wl-paste')).ok ? await runCmd('wl-paste') : await runCmd('xclip', ['-o', '-selection', 'clipboard']);
      send({
        id: rid, op: 'get_control_state', vol: vs.vol, muted: vs.muted, bright: -1,
        outputs, audioSessions, wins, smtc, clip: String(clipRes.out || '').slice(0, 4000)
      });
      break;
    }
    case 'set_vol': {
      const pct = Math.max(0, Math.min(100, Number(cmd.pct ?? 50)));
      if (IS_MAC) await runCmd('osascript', ['-e', `set volume output volume ${pct}`]);
      else await runCmd('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${pct}%`]);
      if (rid) send({ id: rid, op: 'set_vol', vol: pct });
      break;
    }
    case 'set_mute':
    case 'toggle_mute': {
      const vs = await getVolState();
      const next = cmd.op === 'toggle_mute' ? !vs.muted : Boolean(cmd.mute);
      if (IS_MAC) await runCmd('osascript', ['-e', `set volume output muted ${next}`]);
      else await runCmd('pactl', ['set-sink-mute', '@DEFAULT_SINK@', next ? '1' : '0']);
      if (rid) send({ id: rid, op: cmd.op, wasMuted: vs.muted, muted: next });
      break;
    }
    case 'get_mute': {
      const vs = await getVolState();
      send({ id: rid, op: 'get_mute', muted: vs.muted });
      break;
    }
    case 'set_audio_output': {
      const dev = String(cmd.deviceId || '');
      let ok = false;
      if (dev) {
        ok = IS_MAC ? (await runCmd('SwitchAudioSource', ['-s', dev])).ok : (await runCmd('pactl', ['set-default-sink', dev])).ok;
      }
      if (rid) send({ id: rid, op: 'set_audio_output', ok });
      break;
    }
    case 'set_app_audio': {
      if (!IS_MAC && cmd.key) {
        if (cmd.vol != null) await runCmd('pactl', ['set-sink-input-volume', String(cmd.key), `${Math.max(0, Math.min(100, Number(cmd.vol)))}%`]);
        if (cmd.mute != null) await runCmd('pactl', ['set-sink-input-mute', String(cmd.key), cmd.mute ? '1' : '0']);
      }
      if (rid) send({ id: rid, op: 'set_app_audio', ok: true });
      break;
    }
    case 'media': {
      const act = String(cmd.act || 'play_pause');
      if (IS_MAC) {
        const verb = act === 'next' ? 'next track' : (act === 'prev' ? 'previous track' : 'playpause');
        await runCmd('osascript', ['-e', `if application "Spotify" is running then tell application "Spotify" to ${verb}`]);
      } else {
        const verb = act === 'next' ? 'next' : (act === 'prev' ? 'previous' : 'play-pause');
        await runCmd('playerctl', [verb]);
      }
      break;
    }
    case 'seek_smtc': {
      if (!IS_MAC) await runCmd('playerctl', ['position', String(Math.max(0, Number(cmd.posSec || 0)))]);
      if (rid) send({ id: rid, op: 'seek_smtc', ok: !IS_MAC });
      break;
    }
    case 'move': {
      if (!IS_MAC) await runCmd('xdotool', ['mousemove_relative', '--', String(Math.round(cmd.dx || 0)), String(Math.round(cmd.dy || 0))]);
      break;
    }
    case 'click': {
      if (!IS_MAC) {
        const btn = cmd.btn === 'right' ? '3' : (cmd.btn === 'middle' ? '2' : '1');
        await runCmd('xdotool', ['click', btn]);
      }
      break;
    }
    case 'scroll': {
      if (!IS_MAC) {
        const dy = Number(cmd.dy || 0);
        await runCmd('xdotool', ['click', dy > 0 ? '4' : '5']);
      }
      break;
    }
    case 'text': {
      if (!IS_MAC && cmd.text) await runCmd('xdotool', ['type', '--clearmodifiers', String(cmd.text)]);
      else if (IS_MAC && cmd.text) await runCmd('osascript', ['-e', `tell application "System Events" to keystroke ${JSON.stringify(String(cmd.text))}`]);
      break;
    }
    case 'key': {
      if (!IS_MAC && cmd.combo) await runCmd('xdotool', ['key', String(cmd.combo).replace('win+', 'Super_L+')]);
      break;
    }
    case 'set_clip': {
      if (cmd.text) {
        if (IS_MAC) execFile('pbcopy', [], (err, _, __) => {}).stdin?.end(String(cmd.text));
        else execFile('xclip', ['-selection', 'clipboard'], () => {}).stdin?.end(String(cmd.text));
      }
      break;
    }
    case 'launch_app': {
      if (cmd.appId || cmd.url) {
        if (IS_MAC) await runCmd('open', [String(cmd.url || cmd.appId)]);
        else await runCmd(cmd.url ? 'xdg-open' : 'gtk-launch', [String(cmd.url || cmd.appId)]);
      }
      if (rid) send({ id: rid, op: 'launch_app', result: 'ok' });
      break;
    }
    case 'scan_apps': {
      send({ id: rid, op: 'scan_apps', apps: await scanInstalledApps() });
      break;
    }
    case 'capture': {
      const pic = await captureScreenB64(Number(cmd.maxW || 960));
      send({ id: rid, op: 'capture', ...pic });
      break;
    }
    case 'toast': {
      const title = String(cmd.title || 'F.R.I.D.A.Y.');
      const body = String(cmd.body || '');
      if (IS_MAC) await runCmd('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]);
      else await runCmd('notify-send', [title, body]);
      break;
    }
    case 'system_act': {
      const act = String(cmd.act || '');
      if (act === 'lock' || act === 'screen_off') {
        if (IS_MAC) await runCmd('pmset', ['displaysleepnow']);
        else if (act === 'lock') await runCmd('loginctl', ['lock-session']);
        else await runCmd('xset', ['dpms', 'force', 'off']);
      }
      break;
    }
    case 'check_bt_presence': {
      let connected = false;
      const pat = String(cmd.name || '').toLowerCase();
      if (!IS_MAC) {
        const res = await runCmd('bluetoothctl', ['devices', 'Connected']);
        if (res.ok && res.out.trim()) {
          connected = !pat || res.out.toLowerCase().includes(pat);
        }
      }
      send({ id: rid, op: 'check_bt_presence', connected });
      break;
    }
  }
}

send({ ready: true });
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const raw = line.trim();
  if (!raw) return;
  try {
    const cmd = JSON.parse(raw);
    handleCmd(cmd).catch(() => {});
  } catch (_) {}
});
