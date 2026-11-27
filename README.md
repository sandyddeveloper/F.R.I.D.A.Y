<p align="center">
  <img src="app/src/main/assets/www/shared/friday-logo.png" alt="F.R.I.D.A.Y. Logo" width="110" />
</p>

# F.R.I.D.A.Y. — Mobile & PC Control Center

**Turn any Android phone into an always-on secondary smart monitor, PC control deck, music studio, wireless trackpad, and telemetry hub — accessible over LAN or anywhere on the internet with mutual 6-digit pairing.**

---

## Core Features

- **Clean Mobile vs Laptop Pages** — Dedicated non-duplicated screens neatly grouped under Mobile (`Mobile Home`, `Mobile Hardware`, `World & Weather`, `Apps & Toolbox`, `Ops & Automation`) and Laptop (`Laptop Hardware`, `Processes & Jobs`, `Music Studio`, `PC Control Deck`, `PC Remote & Screen`, `Windows & Display`, plus AI Dev pages).
- **Unified Music Studio & Interactive 3D Hardware Stage** —
  - Real Windows SMTC media metadata, live album art, 1-second interpolated timeline & seek scrubbing, Play/Pause/Prev/Next, and Master Volume.
  - Drag-to-orbit interactive CSS `preserve-3d` hardware models (TWS Earbuds + Case, Over-Ear Headphones, Acoustic Speaker, Display Soundbar, 3D Phone & 3D Laptop hardware cores) synced to your active output device, plus instant CoreAudio output switching and per-app audio mixer.
- **Wireless Trackpad, Keyboard & Live Screen Peek** — Touch mouse, scroll rail, shortcuts (`Alt+Tab`, `Win+D`, arrow keys), real-time screen capture & tap-to-click.
- **Process Monitor & Job Completion Ping** — Monitor CPU/RAM-sorted Windows apps, terminate tasks, or arm `Alert on Exit` / `Alert if Idle` high-priority mobile alerts.
- **Smart Phone ↔ Desktop Sync** — OTP extract/copy popups & inline Windows replies, Call-Aware Auto-Mute when phone calls ring, and bi-directional Clipboard sync.
- **Mutual 6-Digit Pairing Security** — Zero open access by default. New laptops and browsers must request access, receive approval on the phone screen, and enter the **6-digit confirmation code** on the laptop before receiving a cryptographic device token.
- **Connect Anytime, Anywhere** — Works over home Wi-Fi / LAN, Tailscale / Cloudflare Tunnel, or the included zero-dependency self-hostable Relay Server (`relay/server.mjs`).

---

## Quick Start (For Any User)

### 1. Install the Android App
Build or install the debug/release APK onto your Android device (`Android 8+`):
```bash
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
Open **F.R.I.D.A.Y.** on your phone. Grant Notification Listener and Accessibility permissions in the app if you want Phone Media, Notification mirroring, and Call-Aware Auto-Mute.

### 2. Install & Connect from Your Laptop (Windows)
Requires **Node.js 18+** on your laptop:
```bash
# Inside the cloned repository:
npm link   # or run `node ./bin/phonebox.mjs connect` directly

friday connect
```
1. `friday connect` discovers your phone on Wi-Fi (or accepts a Tailscale / Tunnel / Relay URL).
2. Your phone wakes and asks **"Laptop Pairing Request — Allow & Show 6-Digit Code"**.
3. Tap **Allow** on the phone, then type the **6-digit code** into your laptop terminal to confirm.
4. Once confirmed, F.R.I.D.A.Y. stores a private device token in `~/.phonebox/credentials.json` and launches the background service automatically.

Useful CLI commands:
```bash
friday status    # Check connection (LAN / Relay) and paired token status
friday start     # Start background telemetry & control bridge
friday stop      # Stop background daemon
friday unpair    # Revoke access on phone and clear local credentials
```

---

## Connect Anytime, Anywhere

### Option A: Tailscale / WireGuard / Cloudflare Tunnel
Enter your phone's persistent Tailscale or tunnel URL in **Admin Studio -> Pairing Gate, Anywhere & Security -> Remote URL** (or when prompted after `friday connect`). The laptop CLI prefers fast LAN Wi-Fi first and seamlessly fails over to your Remote URL when away from home.

### Option B: Self-Hostable Relay Server (Zero Dependencies)
If you want cellular/NAT access without a VPN:
1. Run `relay/server.mjs` on any cloud host, VPS, Render, Railway, or Docker container:
   ```bash
   PORT=8787 node relay/server.mjs
   ```
2. On your phone's **Admin Studio -> Security & Relay**, enable **Connect out to Self-Host Relay** and enter your relay base URL (for example `https://your-relay.example.com`).
3. Pair or connect your laptop using the Relay URL shown in the phone's **Connect & Pair** widget:
   ```bash
   friday connect https://your-relay.example.com/r/<your-room-id>
   ```
   Even when traffic travels through your Relay server, end-to-end **6-digit mutual pairing + `X-PhoneBox-Token` authentication** is strictly enforced on the phone itself.

---

## Architecture

- `app/` — Android Kotlin foreground service + Ktor CIO embedded HTTP/SSE server + SQLite (WAL mode) + interactive landscape/portrait WebView dashboard & ES-modular widgets.
- `bin/phonebox.mjs` — Cross-platform Node CLI (`friday connect`, `start`, `stop`, `status`, `unpair`).
- `bridge/` — Laptop bridge daemon (`phonebox-telemetry.mjs`), WinRT/CoreAudio/SMTC worker (`phonebox-winhost.ps1`), native notification popup (`phonebox-notif-popup.ps1`), and optional AI/code sync helpers.
- `relay/` — Lightweight zero-dependency Node HTTP tunnel relay for outside-LAN connectivity.

## License
MIT
