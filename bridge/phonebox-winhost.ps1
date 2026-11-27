$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, System.Runtime.WindowsRuntime

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

[StructLayout(LayoutKind.Sequential)]
public struct PROPVARIANT {
  public ushort vt; public ushort r1; public ushort r2; public ushort r3;
  public IntPtr p; public IntPtr p2;
}

[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
  int GetCount(out uint cProps);
  int GetAt(uint iProp, out PROPERTYKEY pkey);
  int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
  int f0(); int f1(); int f2(); int f3();
  int SetMasterVolumeLevelScalar(float fLevel, Guid ctx);
  int f5();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int f7(); int f8(); int f9(); int f10();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid ctx);
  int GetMute(out bool pbMute);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceCollection {
  int GetCount(out uint numDevices);
  int Item(uint nDevice, out IMMDevice device);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
  int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
  int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
  int GetState(out uint pdwState);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IMMDeviceCollection ppDevices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumerator {}

[Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfig {
  int f0(); int f1(); int f2(); int f3(); int f4(); int f5(); int f6(); int f7(); int f8(); int f9();
  int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string wszDeviceId, int eRole);
}
[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] public class PolicyConfigClient {}

[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISimpleAudioVolume {
  int SetMasterVolume(float fLevel, ref Guid EventContext);
  int GetMasterVolume(out float pfLevel);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid EventContext);
  int GetMute(out bool pbMute);
}

[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2 {
  int GetState(out int pRetVal);
  int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
  int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
  int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
  int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
  int GetGroupingParam(out Guid pRetVal);
  int SetGroupingParam(ref Guid Override, ref Guid EventContext);
  int RegisterAudioSessionNotification(IntPtr NewNotifications);
  int UnregisterAudioSessionNotification(IntPtr NewNotifications);
  int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
  int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
  int GetProcessId(out uint pRetVal);
  int IsSystemSoundsSession();
}

[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumerator {
  int GetCount(out int SessionCount);
  int GetSession(int SessionIndex, out IAudioSessionControl2 Session);
}

[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2 {
  int GetAudioSessionControl(IntPtr AudioSessionGuid, uint StreamFlags, out IntPtr SessionControl);
  int GetSimpleAudioVolume(IntPtr AudioSessionGuid, uint StreamFlags, out IntPtr AudioVolume);
  int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
}

[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT {
  public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
}
[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT {
  public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
}
[StructLayout(LayoutKind.Explicit)]
public struct INPUTUNION {
  [FieldOffset(0)] public MOUSEINPUT mi;
  [FieldOffset(0)] public KEYBDINPUT ki;
}
[StructLayout(LayoutKind.Sequential)]
public struct INPUT {
  public uint type;
  public INPUTUNION u;
}

public static class WinBridgeNative {
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr hDesktop);
  [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumProc lpfn, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool LockWorkStation();

  const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint KEYEVENTF_EXTENDED = 0x0001;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;

  static IAudioEndpointVolume GetAudioEp() {
    var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDevice dev; en.GetDefaultAudioEndpoint(0, 1, out dev);
    Guid g = typeof(IAudioEndpointVolume).GUID;
    object obj; dev.Activate(ref g, 23, IntPtr.Zero, out obj);
    return (IAudioEndpointVolume)obj;
  }

  public static bool GetMute() {
    try { bool m; GetAudioEp().GetMute(out m); return m; } catch { return false; }
  }

  public static bool SetMute(bool mute) {
    try {
      var ep = GetAudioEp();
      bool was; ep.GetMute(out was);
      if (was != mute) ep.SetMute(mute, Guid.Empty);
      return was;
    } catch { return false; }
  }

  public static int GetVolPct() {
    try {
      float lvl; GetAudioEp().GetMasterVolumeLevelScalar(out lvl);
      return (int)Math.Round(Math.Max(0f, Math.Min(1f, lvl)) * 100f);
    } catch { return -1; }
  }

  public static int SetVolPct(int pct) {
    try {
      var ep = GetAudioEp();
      float clamped = Math.Max(0f, Math.Min(1f, pct / 100f));
      ep.SetMasterVolumeLevelScalar(clamped, Guid.Empty);
      if (pct > 0) {
        bool was; ep.GetMute(out was);
        if (was) ep.SetMute(false, Guid.Empty);
      }
      return pct;
    } catch { return -1; }
  }

  public static List<object> ListAudioOutputs() {
    var res = new List<object>();
    try {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice defDev = null; string defId = "";
      try { en.GetDefaultAudioEndpoint(0, 1, out defDev); if (defDev != null) defDev.GetId(out defId); } catch {}
      IMMDeviceCollection col; en.EnumAudioEndpoints(0, 1, out col);
      uint cnt; col.GetCount(out cnt);
      var pk = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
      for (uint i = 0; i < cnt; i++) {
        IMMDevice d; col.Item(i, out d);
        string id; d.GetId(out id);
        IPropertyStore ps; d.OpenPropertyStore(0, out ps);
        PROPVARIANT pv; ps.GetValue(ref pk, out pv);
        string name = (pv.vt == 31 && pv.p != IntPtr.Zero) ? Marshal.PtrToStringUni(pv.p) : id;
        res.Add(new { id = id, name = name, isDefault = (id == defId) });
      }
    } catch {}
    return res;
  }

  public static bool SetDefaultAudioOutput(string deviceId) {
    try {
      var pc = (IPolicyConfig)new PolicyConfigClient();
      pc.SetDefaultEndpoint(deviceId, 0);
      pc.SetDefaultEndpoint(deviceId, 1);
      pc.SetDefaultEndpoint(deviceId, 2);
      return true;
    } catch { return false; }
  }

  public static List<object> ListAudioSessions() {
    var grouped = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
    try {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice defDev; en.GetDefaultAudioEndpoint(0, 1, out defDev);
      Guid gMgr = typeof(IAudioSessionManager2).GUID;
      object oMgr; defDev.Activate(ref gMgr, 23, IntPtr.Zero, out oMgr);
      var mgr = (IAudioSessionManager2)oMgr;
      IAudioSessionEnumerator sesEnum; mgr.GetSessionEnumerator(out sesEnum);
      int cnt; sesEnum.GetCount(out cnt);
      for (int i = 0; i < cnt; i++) {
        IAudioSessionControl2 c2; sesEnum.GetSession(i, out c2);
        int st; c2.GetState(out st);
        if (st == 2) continue;
        uint pid; c2.GetProcessId(out pid);
        bool isSys = (c2.IsSystemSoundsSession() == 0);
        string proc = "System Sounds";
        if (!isSys && pid > 0) {
          try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { continue; }
        }
        var sv = (ISimpleAudioVolume)c2;
        float vol; sv.GetMasterVolume(out vol);
        bool muted; sv.GetMute(out muted);
        int volPct = (int)Math.Round(Math.Max(0f, Math.Min(1f, vol)) * 100f);
        string key = isSys ? "__system__" : proc.ToLowerInvariant();
        if (!grouped.ContainsKey(key)) {
          grouped[key] = new Dictionary<string, object> {
            { "key", key }, { "name", proc }, { "sys", isSys },
            { "vol", volPct }, { "muted", muted }, { "active", st == 1 }
          };
        } else if (st == 1) {
          grouped[key]["active"] = true;
          grouped[key]["vol"] = volPct;
          grouped[key]["muted"] = muted;
        }
      }
    } catch {}
    var list = new List<object>(grouped.Values);
    list.Sort((a, b) => {
      bool aSys = (bool)((Dictionary<string, object>)a)["sys"];
      bool bSys = (bool)((Dictionary<string, object>)b)["sys"];
      if (aSys != bSys) return aSys ? 1 : -1;
      bool aAct = (bool)((Dictionary<string, object>)a)["active"];
      bool bAct = (bool)((Dictionary<string, object>)b)["active"];
      if (aAct != bAct) return aAct ? -1 : 1;
      return string.Compare((string)((Dictionary<string, object>)a)["name"], (string)((Dictionary<string, object>)b)["name"], StringComparison.OrdinalIgnoreCase);
    });
    return list;
  }

  public static bool SetAppAudio(string targetKey, int volPct, int muteMode) {
    bool hit = false;
    try {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice defDev; en.GetDefaultAudioEndpoint(0, 1, out defDev);
      Guid gMgr = typeof(IAudioSessionManager2).GUID;
      object oMgr; defDev.Activate(ref gMgr, 23, IntPtr.Zero, out oMgr);
      var mgr = (IAudioSessionManager2)oMgr;
      IAudioSessionEnumerator sesEnum; mgr.GetSessionEnumerator(out sesEnum);
      int cnt; sesEnum.GetCount(out cnt);
      Guid ctx = Guid.Empty;
      for (int i = 0; i < cnt; i++) {
        IAudioSessionControl2 c2; sesEnum.GetSession(i, out c2);
        uint pid; c2.GetProcessId(out pid);
        bool isSys = (c2.IsSystemSoundsSession() == 0);
        string proc = "System Sounds";
        if (!isSys && pid > 0) {
          try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { continue; }
        }
        string key = isSys ? "__system__" : proc.ToLowerInvariant();
        if (!string.Equals(key, targetKey, StringComparison.OrdinalIgnoreCase)) continue;
        var sv = (ISimpleAudioVolume)c2;
        if (volPct >= 0) {
          sv.SetMasterVolume(Math.Max(0f, Math.Min(1f, volPct / 100f)), ref ctx);
        }
        if (muteMode >= 0) {
          sv.SetMute(muteMode == 1, ref ctx);
        }
        hit = true;
      }
    } catch {}
    return hit;
  }

  public static void MoveCursorBy(int dx, int dy) {
    var pt = System.Windows.Forms.Cursor.Position;
    var vs = System.Windows.Forms.SystemInformation.VirtualScreen;
    SetCursorPos(Math.Max(vs.Left, Math.Min(vs.Right - 1, pt.X + dx)), Math.Max(vs.Top, Math.Min(vs.Bottom - 1, pt.Y + dy)));
  }

  public static void MoveCursorNormalized(double rx, double ry) {
    var vs = System.Windows.Forms.SystemInformation.VirtualScreen;
    int nx = vs.Left + (int)Math.Round(Math.Max(0.0, Math.Min(1.0, rx)) * (vs.Width - 1));
    int ny = vs.Top + (int)Math.Round(Math.Max(0.0, Math.Min(1.0, ry)) * (vs.Height - 1));
    SetCursorPos(nx, ny);
  }

  public static void Click(string button) {
    if (button == "right") {
      mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, UIntPtr.Zero);
      mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, UIntPtr.Zero);
    } else if (button == "middle") {
      mouse_event(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, UIntPtr.Zero);
      mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, UIntPtr.Zero);
    } else if (button == "double") {
      mouse_event(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(55);
      mouse_event(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
    } else {
      mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
      mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
    }
  }

  public static void Scroll(int delta) {
    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, delta, UIntPtr.Zero);
  }

  public static void PressVk(byte vk, bool down, bool ext) {
    uint flags = (ext ? KEYEVENTF_EXTENDED : 0u) | (down ? 0u : KEYEVENTF_KEYUP);
    keybd_event(vk, 0, flags, UIntPtr.Zero);
  }

  public static void TapCombo(byte[] mods, byte mainVk, bool extMain) {
    foreach (byte m in mods) PressVk(m, true, false);
    PressVk(mainVk, true, extMain);
    System.Threading.Thread.Sleep(18);
    PressVk(mainVk, false, extMain);
    for (int i = mods.Length - 1; i >= 0; i--) PressVk(mods[i], false, false);
  }

  public static void TypeUnicode(string text) {
    if (string.IsNullOrEmpty(text)) return;
    foreach (char ch in text) {
      if (ch == '\r') continue;
      if (ch == '\n') { TapCombo(new byte[0], 0x0D, false); continue; }
      var down = new INPUT(); down.type = 1; down.u.ki = new KEYBDINPUT { wVk = 0, wScan = (ushort)ch, dwFlags = KEYEVENTF_UNICODE };
      var up = new INPUT(); up.type = 1; up.u.ki = new KEYBDINPUT { wVk = 0, wScan = (ushort)ch, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP };
      SendInput(2, new INPUT[] { down, up }, Marshal.SizeOf(typeof(INPUT)));
    }
  }

  public static List<object> ListDesktopWindows() {
    var list = new List<object>();
    IntPtr fg = GetForegroundWindow();
    IntPtr hd = OpenInputDesktop(0, false, 0x0001 | 0x0040);
    if (hd == IntPtr.Zero) return list;
    try {
      EnumDesktopWindows(hd, (h, l) => {
        if (!IsWindowVisible(h)) return true;
        var sb = new StringBuilder(256);
        if (GetWindowText(h, sb, 256) <= 0) return true;
        string t = sb.ToString().Trim();
        if (t.Length == 0 || t == "Program Manager" || t == "Windows Input Experience" || t == "Microsoft Text Input Application") return true;
        uint pid; GetWindowThreadProcessId(h, out pid);
        string pn = ""; try { pn = Process.GetProcessById((int)pid).ProcessName; } catch {}
        if (pn == "ApplicationFrameHost" && t == "Settings") return true;
        list.Add(new { hwnd = h.ToInt64(), pid = pid, proc = pn, title = t, active = (h == fg), minimized = IsIconic(h) });
        return true;
      }, IntPtr.Zero);
    } finally { CloseDesktop(hd); }
    return list;
  }

  public static void ControlWindow(long hwndVal, string action) {
    IntPtr h = new IntPtr(hwndVal);
    var wa = System.Windows.Forms.Screen.PrimaryScreen.WorkingArea;
    switch (action) {
      case "focus":
        if (IsIconic(h)) ShowWindowAsync(h, 9);
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        SetForegroundWindow(h);
        keybd_event(0x12, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        break;
      case "min": ShowWindowAsync(h, 6); break;
      case "max": ShowWindowAsync(h, 3); break;
      case "restore": ShowWindowAsync(h, 9); break;
      case "snap_left":
        ShowWindowAsync(h, 9);
        MoveWindow(h, wa.Left, wa.Top, wa.Width / 2, wa.Height, true);
        SetForegroundWindow(h);
        break;
      case "snap_right":
        ShowWindowAsync(h, 9);
        MoveWindow(h, wa.Left + wa.Width / 2, wa.Top, wa.Width / 2, wa.Height, true);
        SetForegroundWindow(h);
        break;
      case "close": PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); break;
    }
  }

  public static void ScreenOff() {
    PostMessage((IntPtr)0xFFFF, 0x0112, (IntPtr)0xF170, (IntPtr)2);
  }

  public static string CaptureJpegB64(int maxW, long quality, out int outW, out int outH) {
    var vs = System.Windows.Forms.SystemInformation.VirtualScreen;
    int targetW = Math.Min(vs.Width, Math.Max(320, maxW));
    int targetH = (int)Math.Max(180, Math.Round((double)vs.Height * targetW / vs.Width));
    outW = targetW; outH = targetH;
    using (var full = new Bitmap(vs.Width, vs.Height, PixelFormat.Format24bppRgb))
    using (var gFull = Graphics.FromImage(full)) {
      gFull.CopyFromScreen(vs.Left, vs.Top, 0, 0, vs.Size, CopyPixelOperation.SourceCopy);
      using (var scaled = new Bitmap(targetW, targetH))
      using (var gScaled = Graphics.FromImage(scaled)) {
        gScaled.InterpolationMode = InterpolationMode.Bilinear;
        gScaled.DrawImage(full, 0, 0, targetW, targetH);
        ImageCodecInfo jpegCodec = null;
        foreach (var c in ImageCodecInfo.GetImageEncoders()) {
          if (c.MimeType == "image/jpeg") { jpegCodec = c; break; }
        }
        using (var ms = new MemoryStream()) {
          if (jpegCodec != null) {
            var ep = new EncoderParameters(1);
            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
            scaled.Save(ms, jpegCodec, ep);
          } else { scaled.Save(ms, ImageFormat.Jpeg); }
          return Convert.ToBase64String(ms.ToArray());
        }
      }
    }
  }
}
"@ -ReferencedAssemblies System.Drawing, System.Windows.Forms

$asTaskMethod = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function AwaitWinRt($op, $resType) {
  $t = $asTaskMethod.MakeGenericMethod($resType).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  return $t.Result
}

function Get-BrightnessPct {
  try {
    $b = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness | Select-Object -First 1
    if ($null -eq $b -or $null -eq $b.CurrentBrightness) { return -1 }
    return [int]$b.CurrentBrightness
  } catch { return -1 }
}

function Set-BrightnessPct([int]$pct) {
  try {
    $clamped = [Math]::Max(0, [Math]::Min(100, $pct))
    $m = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods | Select-Object -First 1
    if ($m) { Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = $clamped } | Out-Null }
    return $clamped
  } catch { return -1 }
}

function Get-SmtcState {
  try {
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
    $mgr = AwaitWinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $cur = $mgr.GetCurrentSession()
    if (-not $cur) { return @{ active = $false } }
    $props = AwaitWinRt ($cur.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $pb = $cur.GetPlaybackInfo()
    $tl = $cur.GetTimelineProperties()
    $startSec = if ($tl) { $tl.StartTime.TotalSeconds } else { 0 }
    $endSec = if ($tl) { $tl.EndTime.TotalSeconds } else { 0 }
    $posSec = if ($tl) { $tl.Position.TotalSeconds } else { 0 }
    if ($pb -and ([string]$pb.PlaybackStatus -eq 'Playing') -and $tl -and $tl.LastUpdatedTime.Year -gt 2000) {
      $drift = ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalSeconds
      if ($drift -gt 0 -and $drift -lt 3600) { $posSec = $posSec + $drift }
    }
    $durSec = [Math]::Max(0, $endSec - $startSec)
    $relPos = [Math]::Max(0, [Math]::Min($durSec, $posSec - $startSec))
    $canSeek = ($durSec -gt 1) -and ($tl.MaxSeekTime -gt $tl.MinSeekTime)
    $hasThumb = ($null -ne $props.Thumbnail)
    $thumbKey = if ($hasThumb) { "$($cur.SourceAppUserModelId)|$($props.Title)|$($props.Artist)|$($props.AlbumTitle)" } else { "" }
    return @{
      active = $true
      playing = ([string]$pb.PlaybackStatus -eq 'Playing')
      status = [string]$pb.PlaybackStatus
      app = [string]$cur.SourceAppUserModelId
      title = [string]$props.Title
      artist = [string]$props.Artist
      album = [string]$props.AlbumTitle
      posSec = [Math]::Round($relPos, 1)
      durSec = [Math]::Round($durSec, 1)
      canSeek = [bool]$canSeek
      hasThumb = [bool]$hasThumb
      thumbKey = $thumbKey
    }
  } catch { return @{ active = $false } }
}

function Invoke-KeyName([string]$combo) {
  switch ($combo.ToLowerInvariant()) {
    'space'       { [WinBridgeNative]::TapCombo(@(), 0x20, $false) }
    'enter'       { [WinBridgeNative]::TapCombo(@(), 0x0D, $false) }
    'backspace'   { [WinBridgeNative]::TapCombo(@(), 0x08, $false) }
    'tab'         { [WinBridgeNative]::TapCombo(@(), 0x09, $false) }
    'esc'         { [WinBridgeNative]::TapCombo(@(), 0x1B, $false) }
    'left'        { [WinBridgeNative]::TapCombo(@(), 0x25, $true) }
    'up'          { [WinBridgeNative]::TapCombo(@(), 0x26, $true) }
    'right'       { [WinBridgeNative]::TapCombo(@(), 0x27, $true) }
    'down'        { [WinBridgeNative]::TapCombo(@(), 0x28, $true) }
    'alt+tab'     { [WinBridgeNative]::TapCombo(@(0x12), 0x09, $false) }
    'alt+f4'      { [WinBridgeNative]::TapCombo(@(0x12), 0x73, $false) }
    'win+d'       { [WinBridgeNative]::TapCombo(@(0x5B), 0x44, $false) }
    'ctrl+c'      { [WinBridgeNative]::TapCombo(@(0x11), 0x43, $false) }
    'ctrl+v'      { [WinBridgeNative]::TapCombo(@(0x11), 0x56, $false) }
    'ctrl+z'      { [WinBridgeNative]::TapCombo(@(0x11), 0x5A, $false) }
    'ctrl+w'      { [WinBridgeNative]::TapCombo(@(0x11), 0x57, $false) }
    'vol_mute'    { [WinBridgeNative]::TapCombo(@(), 0xAD, $true) }
    'vol_down'    { [WinBridgeNative]::TapCombo(@(), 0xAE, $true) }
    'vol_up'      { [WinBridgeNative]::TapCombo(@(), 0xAF, $true) }
    'media_next'  { [WinBridgeNative]::TapCombo(@(), 0xB0, $true) }
    'media_prev'  { [WinBridgeNative]::TapCombo(@(), 0xB1, $true) }
    'media_play'  { [WinBridgeNative]::TapCombo(@(), 0xB3, $true) }
  }
}

function Show-NativeToast([string]$title, [string]$body) {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $eT = [System.Security.SecurityElement]::Escape($title)
    $eB = [System.Security.SecurityElement]::Escape($body)
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$eT</text><text>$eB</text></binding></visual></toast>")
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
  } catch {}
}

function Launch-AppOrFocus($cmd) {
  $procMatch = [string]$cmd.proc
  $forceNew = [bool]$cmd.forceNew
  $appId = [string]$cmd.appId
  $uri = [string]$cmd.uri

  if ($procMatch -and -not $forceNew) {
    $wins = [WinBridgeNative]::ListDesktopWindows()
    $hit = $wins | Where-Object { $_.proc -ieq $procMatch } | Select-Object -First 1
    if ($hit) {
      [WinBridgeNative]::ControlWindow([long]$hit.hwnd, 'focus')
      return 'focused'
    }
  }
  if ($uri) {
    Start-Process $uri | Out-Null
    return 'launched_uri'
  }
  if ($appId) {
    Start-Process 'explorer.exe' -ArgumentList "shell:AppsFolder\$appId" | Out-Null
    return 'launched_app'
  }
  return 'noop'
}

Write-Output '{"ready":true}'
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $trimmed = $line.Trim()
  if (-not $trimmed) { continue }
  try {
    $cmd = $trimmed | ConvertFrom-Json
    $op = [string]$cmd.op
    $rid = [string]$cmd.id
    switch ($op) {
      'move'      { [WinBridgeNative]::MoveCursorBy([int]$cmd.dx, [int]$cmd.dy) }
      'click'     { [WinBridgeNative]::Click([string]($cmd.button)) }
      'abs_click' { [WinBridgeNative]::MoveCursorNormalized([double]$cmd.rx, [double]$cmd.ry); [WinBridgeNative]::Click([string]($cmd.button)) }
      'scroll'    { [WinBridgeNative]::Scroll([int]$cmd.dy) }
      'text'      { [WinBridgeNative]::TypeUnicode([string]$cmd.text) }
      'key'       { Invoke-KeyName ([string]$cmd.combo) }
      'set_clip'  {
        $txt = [string]$cmd.text
        if ($txt) { [System.Windows.Forms.Clipboard]::SetText($txt) }
      }
      'set_vol'   {
        $v = [WinBridgeNative]::SetVolPct([int]$cmd.pct)
        if ($rid) { Write-Output ((@{ id = $rid; op = 'set_vol'; vol = $v }) | ConvertTo-Json -Compress); [Console]::Out.Flush() }
      }
      'set_audio_output' {
        $ok = [WinBridgeNative]::SetDefaultAudioOutput([string]$cmd.deviceId)
        if ($rid) { Write-Output ((@{ id = $rid; op = 'set_audio_output'; ok = $ok }) | ConvertTo-Json -Compress); [Console]::Out.Flush() }
      }
      'set_app_audio' {
        $vp = if ($null -ne $cmd.vol) { [int]$cmd.vol } else { -1 }
        $mm = if ($null -ne $cmd.mute) { if ([bool]$cmd.mute) { 1 } else { 0 } } else { -1 }
        $ok = [WinBridgeNative]::SetAppAudio([string]$cmd.key, $vp, $mm)
        if ($rid) { Write-Output ((@{ id = $rid; op = 'set_app_audio'; ok = $ok }) | ConvertTo-Json -Compress); [Console]::Out.Flush() }
      }
      'set_bright' {
        $b = Set-BrightnessPct ([int]$cmd.pct)
        if ($rid) { Write-Output ((@{ id = $rid; op = 'set_bright'; bright = $b }) | ConvertTo-Json -Compress); [Console]::Out.Flush() }
      }
      'get_mute'  {
        Write-Output ((@{ id = $rid; op = 'get_mute'; muted = [WinBridgeNative]::GetMute() }) | ConvertTo-Json -Compress); [Console]::Out.Flush()
      }
      'set_mute'  {
        $m = [bool]$cmd.mute
        $was = [WinBridgeNative]::SetMute($m)
        Write-Output ((@{ id = $rid; op = 'set_mute'; wasMuted = $was; muted = $m }) | ConvertTo-Json -Compress); [Console]::Out.Flush()
      }
      'toggle_mute' {
        $cur = [WinBridgeNative]::GetMute()
        [WinBridgeNative]::SetMute(-not $cur) | Out-Null
        if ($rid) { Write-Output ((@{ id = $rid; op = 'toggle_mute'; muted = (-not $cur) }) | ConvertTo-Json -Compress); [Console]::Out.Flush() }
      }
      'seek_smtc' {
        $ok = $false
        try {
          [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
          $mgr = AwaitWinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
          $cur = $mgr.GetCurrentSession()
          if ($cur) {
            $tl = $cur.GetTimelineProperties()
            $reqSec = [Math]::Max(0.0, [double]$cmd.posSec)
            [int64]$ticks = $tl.StartTime.Ticks + [int64]([Math]::Round($reqSec * 10000000.0))
            if ($tl.MaxSeekTime.Ticks -gt $tl.MinSeekTime.Ticks) {
              if ($ticks -lt $tl.MinSeekTime.Ticks) { $ticks = $tl.MinSeekTime.Ticks }
              if ($ticks -gt $tl.MaxSeekTime.Ticks) { $ticks = $tl.MaxSeekTime.Ticks }
            }
            $ok = [bool](AwaitWinRt ($cur.TryChangePlaybackPositionAsync($ticks)) ([bool]))
          }
        } catch {}
        if ($rid) { Write-Output ((@{ id = $rid; op = 'seek_smtc'; ok = $ok }) | ConvertTo-Json -Compress); [Console]::Out.Flush() }
      }
      'get_smtc_art' {
        $b64 = ''
        $ctype = 'image/jpeg'
        try {
          [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
          [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
          $mgr = AwaitWinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
          $cur = $mgr.GetCurrentSession()
          if ($cur) {
            $props = AwaitWinRt ($cur.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            if ($props -and $props.Thumbnail) {
              $stream = AwaitWinRt ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
              try {
                $sz = [uint32][Math]::Min([uint64]2097152, $stream.Size)
                if ($sz -gt 0) {
                  $st = [string]$stream.ContentType
                  if ($st) { $ctype = $st }
                  $rdr = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
                  $loaded = AwaitWinRt ($rdr.LoadAsync($sz)) ([uint32])
                  $bytes = New-Object byte[] $loaded
                  $rdr.ReadBytes($bytes)
                  $b64 = [Convert]::ToBase64String($bytes)
                  $rdr.Dispose()
                }
              } finally {
                if ($stream) { $stream.Dispose() }
              }
            }
          }
        } catch {}
        if ($rid) { Write-Output ((@{ id = $rid; op = 'get_smtc_art'; b64 = $b64; contentType = $ctype }) | ConvertTo-Json -Compress); [Console]::Out.Flush() }
      }
      'win_act'   { [WinBridgeNative]::ControlWindow([long]$cmd.hwnd, [string]$cmd.act) }
      'launch_app' {
        $res = Launch-AppOrFocus $cmd
        if ($rid) { Write-Output ((@{ id = $rid; op = 'launch_app'; result = $res }) | ConvertTo-Json -Compress); [Console]::Out.Flush() }
      }
      'system_act' {
        switch ([string]$cmd.act) {
          'lock'       { [WinBridgeNative]::LockWorkStation() | Out-Null }
          'screen_off' { [WinBridgeNative]::ScreenOff() }
          'snip'       { Start-Process 'ms-screenclip:' | Out-Null }
          'taskmgr'    { Start-Process 'Taskmgr.exe' | Out-Null }
          'settings'   { Start-Process 'ms-settings:' | Out-Null }
          'files'      { Start-Process 'explorer.exe' | Out-Null }
          'terminal'   { Start-Process 'wt.exe' | Out-Null }
        }
      }
      'profile'   {
        switch ([string]$cmd.name) {
          'music'   { [WinBridgeNative]::SetVolPct(65) | Out-Null; Set-BrightnessPct 75 | Out-Null }
          'meeting' { [WinBridgeNative]::SetVolPct(60) | Out-Null; Set-BrightnessPct 80 | Out-Null }
          'night'   { [WinBridgeNative]::SetVolPct(35) | Out-Null; Set-BrightnessPct 25 | Out-Null }
          'coding'  { [WinBridgeNative]::SetVolPct(45) | Out-Null; Set-BrightnessPct 85 | Out-Null }
        }
      }
      'scan_apps' {
        $apps = @(Get-StartApps | Where-Object {
          $_.Name -and $_.AppID -and
          ($_.AppID -notmatch '^https?://') -and
          ($_.Name -notmatch 'Documentation|Release Notes|FAQs|Uninstall')
        } | Sort-Object Name | ForEach-Object { @{ name = [string]$_.Name; appId = [string]$_.AppID } })
        Write-Output ((@{ id = $rid; op = 'scan_apps'; apps = $apps }) | ConvertTo-Json -Compress); [Console]::Out.Flush()
      }
      'get_control_state' {
        $clip = ''
        try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { $clip = [System.Windows.Forms.Clipboard]::GetText() } } catch {}
        $out = @{
          id = $rid
          op = 'get_control_state'
          vol = [WinBridgeNative]::GetVolPct()
          muted = [WinBridgeNative]::GetMute()
          bright = Get-BrightnessPct
          outputs = [WinBridgeNative]::ListAudioOutputs()
          audioSessions = [WinBridgeNative]::ListAudioSessions()
          wins = [WinBridgeNative]::ListDesktopWindows()
          smtc = Get-SmtcState
          clip = if ($clip.Length -gt 4000) { $clip.Substring(0, 4000) } else { $clip }
        }
        Write-Output ($out | ConvertTo-Json -Compress -Depth 4); [Console]::Out.Flush()
      }
      'capture'   {
        $mw = if ($cmd.maxW) { [int]$cmd.maxW } else { 960 }
        $ql = if ($cmd.quality) { [long]$cmd.quality } else { 62L }
        $ow = 0; $oh = 0
        $b64 = [WinBridgeNative]::CaptureJpegB64($mw, $ql, [ref]$ow, [ref]$oh)
        Write-Output ((@{ id = $rid; op = 'capture'; w = $ow; h = $oh; b64 = $b64 }) | ConvertTo-Json -Compress); [Console]::Out.Flush()
      }
      'get_adapters' {
        $ad = @(Get-CimInstance Win32_VideoController | Where-Object { $_.Name } | ForEach-Object {
          @{ name = [string]$_.Name.Trim(); vramMb = if ([double]$_.AdapterRAM -gt 0) { [int][Math]::Round([double]$_.AdapterRAM / 1048576.0) } else { 0 } }
        })
        Write-Output ((@{ id = $rid; op = 'get_adapters'; adapters = $ad }) | ConvertTo-Json -Compress -Depth 3); [Console]::Out.Flush()
      }
      'get_net' {
        [long]$rx = 0; [long]$tx = 0
        foreach ($ni in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
          if ($ni.OperationalStatus -eq 'Up' -and $ni.NetworkInterfaceType -ne 'Loopback') {
            $st = $ni.GetIPStatistics()
            $rx += [long]$st.BytesReceived
            $tx += [long]$st.BytesSent
          }
        }
        Write-Output ((@{ id = $rid; op = 'get_net'; rx = $rx; tx = $tx }) | ConvertTo-Json -Compress); [Console]::Out.Flush()
      }
      'get_ping' {
        $avg = -1; $loss = 100; $sum = 0; $okCnt = 0
        try {
          $p = New-Object System.Net.NetworkInformation.Ping
          for ($k = 0; $k -lt 2; $k++) {
            $r = $p.Send('8.8.8.8', 750)
            if ($r.Status -eq 'Success') { $okCnt++; $sum += [int]$r.RoundtripTime }
          }
          $p.Dispose()
          if ($okCnt -gt 0) {
            $avg = [int][Math]::Round($sum / $okCnt)
            $loss = [int][Math]::Round(((2 - $okCnt) / 2.0) * 100)
          }
        } catch {}
        Write-Output ((@{ id = $rid; op = 'get_ping'; pingMs = $avg; lossPct = $loss }) | ConvertTo-Json -Compress); [Console]::Out.Flush()
      }
      'get_gpu' {
        $gpuObj = $null
        try {
          $psi = New-Object System.Diagnostics.ProcessStartInfo
          $psi.FileName = 'nvidia-smi'
          $psi.Arguments = '--query-gpu=name,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total --format=csv,noheader,nounits'
          $psi.UseShellExecute = $false
          $psi.CreateNoWindow = $true
          $psi.RedirectStandardOutput = $true
          $psi.RedirectStandardError = $true
          $pr = [System.Diagnostics.Process]::Start($psi)
          if ($pr -and $pr.WaitForExit(1400)) {
            $line = ($pr.StandardOutput.ReadToEnd() -split "`r?`n" | Select-Object -First 1).Trim()
            $parts = $line -split ','
            if ($parts.Length -ge 6) {
              $gpuObj = @{
                gpuName = $parts[0].Trim()
                gpuPct = [double]$parts[1].Trim()
                gpuTempC = [double]$parts[2].Trim()
                gpuPowerW = [double]$parts[3].Trim()
                vramUsedMb = [double]$parts[4].Trim()
                vramTotalMb = [double]$parts[5].Trim()
              }
            }
          }
        } catch {}
        Write-Output ((@{ id = $rid; op = 'get_gpu'; gpu = $gpuObj }) | ConvertTo-Json -Compress -Depth 3); [Console]::Out.Flush()
      }
      'get_processes' {
        if (-not $script:ProcMeta) { $script:ProcMeta = @{} }
        $out = New-Object System.Collections.Generic.List[object]
        foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
          $pn = $p.ProcessName
          if ($pn -eq 'Idle') { continue }
          if (-not $script:ProcMeta.ContainsKey($pn)) {
            $d = ''; $f = ''; $prot = $false
            try { $mm = $p.MainModule; if ($mm) { $f = [string]$mm.FileName; $d = [string]$mm.FileVersionInfo.FileDescription } } catch { $prot = $true }
            if ($p.SessionId -eq 0 -or $pn -in @('System','Registry','smss','csrss','wininit','services','lsass','svchost','Memory Compression')) { $prot = $true }
            $script:ProcMeta[$pn] = @($d, $f, $prot)
          }
          $m = $script:ProcMeta[$pn]
          $c = 0.0; try { $c = [double]$p.TotalProcessorTime.TotalSeconds } catch {}
          $out.Add([PSCustomObject]@{ i = $p.Id; n = $pn; d = $m[0]; f = $m[1]; p = [bool]$m[2]; r = [long]$p.WorkingSet64; c = $c })
        }
        Write-Output ((@{ id = $rid; op = 'get_processes'; items = $out }) | ConvertTo-Json -Compress -Depth 3); [Console]::Out.Flush()
      }
      'check_bt_presence' {
        $pat = [string]$cmd.name
        $hit = ''
        try {
          $devs = Get-PnpDevice -Class Bluetooth -Status OK -ErrorAction SilentlyContinue | Where-Object {
            $_.FriendlyName -and (-not $pat -or $_.FriendlyName -like "*$pat*") -and $_.InstanceId -match 'BTHENUM|DEV_'
          }
          foreach ($d in $devs) {
            $prop = Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName '{83DA6326-97A6-4088-9453-A1923F573B29} 15' -ErrorAction SilentlyContinue
            if ($prop -and $prop.Data -eq $true) { $hit = [string]$d.FriendlyName; break }
          }
        } catch {}
        Write-Output ((@{ id = $rid; op = 'check_bt_presence'; connected = ($hit -ne ''); matched = $hit }) | ConvertTo-Json -Compress); [Console]::Out.Flush()
      }
      'toast'     { Show-NativeToast ([string]$cmd.title) ([string]$cmd.body) }
    }
  } catch {}
}
