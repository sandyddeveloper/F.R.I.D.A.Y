package com.santhu.phonebox.system

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.TrafficStats
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.Looper
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import com.santhu.phonebox.PhoneBoxApp
import com.santhu.phonebox.server.NetworkWatchdogJobService
import com.santhu.phonebox.server.ServerService
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import kotlin.math.roundToInt

object DeviceTelemetry {
    private var prevRxBytes = -1L
    private var prevTxBytes = -1L
    private var prevTrafficTs = 0L
    @Volatile private var cachedRxKbps = 0.0
    @Volatile private var cachedTxKbps = 0.0
    @Volatile private var lastSshProbeTs = 0L
    @Volatile private var lastSshListening = false

    fun collect(context: Context, port: Int, serverStartedAt: Long): JSONObject {
        val batIntent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = batIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = batIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val batteryPct = if (level >= 0 && scale > 0) ((level * 100f) / scale).roundToInt() else -1
        val plugged = batIntent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val status = batIntent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val tempTenths = batIntent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1) ?: -1
        val voltageMv = batIntent?.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1) ?: -1

        val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        val currentUa = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW) ?: Int.MIN_VALUE
        val currentMa = if (currentUa != Int.MIN_VALUE) (currentUa / 1000) else 0
        val powerW = if (voltageMv > 0 && currentUa != Int.MIN_VALUE) {
            (kotlin.math.abs((voltageMv / 1000.0) * (currentMa / 1000.0)) * 100.0).roundToInt() / 100.0
        } else -1.0

        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        val totalRamMb = (memInfo.totalMem / (1024 * 1024)).toInt()
        val availRamMb = (memInfo.availMem / (1024 * 1024)).toInt()
        val usedRamMb = (totalRamMb - availRamMb).coerceAtLeast(0)
        val ramPct = if (totalRamMb > 0) ((usedRamMb * 100f) / totalRamMb).roundToInt() else -1

        val statFs = StatFs(Environment.getDataDirectory().path)
        val totalStorageGb = statFs.totalBytes / (1024.0 * 1024 * 1024)
        val freeStorageGb = statFs.availableBytes / (1024.0 * 1024 * 1024)
        val usedStorageGb = (totalStorageGb - freeStorageGb).coerceAtLeast(0.0)
        val storagePct = if (totalStorageGb > 0) ((usedStorageGb * 100.0) / totalStorageGb).roundToInt() else -1

        val ips = getLocalIpv4Addresses()
        val primaryIp = ips.firstOrNull { !it.startsWith("127.") } ?: "127.0.0.1"
        val wifiInfo = readWifiSummary(context)
        val cpuStats = readRealCpuFreqPercent()
        val socTemp = readThermalTempC()
        val netSpeed = readNetworkSpeedKbps()
        val socName = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            Build.SOC_MODEL.isNotBlank() &&
            !Build.SOC_MODEL.equals("unknown", ignoreCase = true)
        ) Build.SOC_MODEL else Build.HARDWARE

        return JSONObject().apply {
            put("deviceName", "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}")
            put("socName", socName)
            put("board", Build.BOARD)
            put("androidVersion", Build.VERSION.RELEASE)
            put("sdk", Build.VERSION.SDK_INT)
            put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a")
            put("batteryPct", batteryPct)
            put("charging", plugged > 0 || status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
            put("chargeSource", when (plugged) {
                BatteryManager.BATTERY_PLUGGED_AC -> "AC"
                BatteryManager.BATTERY_PLUGGED_USB -> "USB"
                BatteryManager.BATTERY_PLUGGED_WIRELESS -> "Wireless"
                else -> "Battery"
            })
            put("tempC", if (tempTenths >= 0) (tempTenths / 10.0) else -1.0)
            put("socTempC", socTemp)
            put("voltageMv", voltageMv)
            put("currentMa", currentMa)
            put("powerW", powerW)
            put("cpuPct", cpuStats.first)
            put("cpuFreqMhz", cpuStats.second)
            put("cpuCores", Runtime.getRuntime().availableProcessors())
            put("ramTotalMb", totalRamMb)
            put("ramUsedMb", usedRamMb)
            put("ramPct", ramPct)
            put("storageTotalGb", (totalStorageGb * 10).roundToInt() / 10.0)
            put("storageUsedGb", (usedStorageGb * 10).roundToInt() / 10.0)
            put("storageFreeGb", (freeStorageGb * 10).roundToInt() / 10.0)
            put("storagePct", storagePct)
            put("ip", primaryIp)
            put("allIps", JSONArray(ips))
            put("port", port)
            put("url", "http://$primaryIp:$port")
            put("adminUrl", "http://$primaryIp:$port/admin/")
            put("panelUrl", "http://$primaryIp:$port/panel/")
            put("wifiConnected", wifiInfo.first)
            put("wifiRssi", wifiInfo.second)
            put("netRxKbps", netSpeed.first)
            put("netTxKbps", netSpeed.second)
            put("deviceUptimeSec", SystemClock.elapsedRealtime() / 1000)
            put("serverUptimeSec", ((System.currentTimeMillis() - serverStartedAt) / 1000).coerceAtLeast(0))
            put("serverHealth", readServerAndSshHealth(context, primaryIp))
        }
    }

    /**
     * Collects always-on server lock status and probes Termux/SSH availability on localhost:8022.
     */
    private fun readServerAndSshHealth(context: Context, primaryIp: String): JSONObject {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val batteryExempt = pm?.isIgnoringBatteryOptimizations(context.packageName) == true
        val termuxInfo = runCatching { context.packageManager.getApplicationInfo("com.termux", 0) }.getOrNull()
        val termuxBootInstalled = runCatching { context.packageManager.getPackageInfo("com.termux.boot", 0) }.isSuccess
        val termuxUser = if (termuxInfo != null) {
            val appId = termuxInfo.uid % 100000
            if (appId >= 10000) "u0_a${appId - 10000}" else ""
        } else ""
        val sshPort = 8022
        val sshListening = isSshPortListening(sshPort)
        val sshCmd = if (termuxUser.isNotEmpty() && primaryIp != "127.0.0.1") {
            "ssh -p $sshPort $termuxUser@$primaryIp"
        } else ""

        val runCmdPermGranted = context.checkSelfPermission("com.termux.permission.RUN_COMMAND") ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        val networkJobScheduled = runCatching { NetworkWatchdogJobService.isScheduled(context) }.getOrDefault(false)
        val autoKeepSsh = runCatching { PhoneBoxApp.instance.db.getSetting("auto_keep_ssh", "1") == "1" }.getOrDefault(true)

        return JSONObject().apply {
            put("wakeLock", ServerService.wakeLockHeld)
            put("wifiLock", ServerService.wifiLockHeld)
            put("batteryExempt", batteryExempt)
            put("termuxInstalled", termuxInfo != null)
            put("termuxBootInstalled", termuxBootInstalled)
            put("termuxUser", termuxUser)
            put("sshPort", sshPort)
            put("sshListening", sshListening)
            put("sshCmd", sshCmd)
            put("runCmdPermGranted", runCmdPermGranted)
            put("networkJobScheduled", networkJobScheduled)
            put("autoKeepSsh", autoKeepSsh)
        }
    }

    /**
     * Checks whether port [port] is accepting local TCP connections, cached for 20s
     * to avoid spawning sshd-session preauth entries on every 3s SSE tick.
     */
    private fun isSshPortListening(port: Int): Boolean {
        if (Looper.myLooper() == Looper.getMainLooper()) return lastSshListening
        val now = System.currentTimeMillis()
        if (lastSshProbeTs > 0L && now - lastSshProbeTs < 20_000L) return lastSshListening
        lastSshProbeTs = now
        lastSshListening = runCatching {
            Socket().use { sock ->
                sock.connect(InetSocketAddress("127.0.0.1", port), 120)
                true
            }
        }.getOrDefault(false)
        return lastSshListening
    }

    /**
     * Reads real CPU frequency utilization across online CPU cores via sysfs cpufreq.
     * Never falls back to RAM %; returns (-1, -1) if sysfs is inaccessible.
     */
    private fun readRealCpuFreqPercent(): Pair<Int, Int> {
        val cores = Runtime.getRuntime().availableProcessors().coerceIn(1, 16)
        var sumRatio = 0.0
        var sumCurKhz = 0L
        var valid = 0
        for (i in 0 until cores) {
            val cur = readLongFile("/sys/devices/system/cpu/cpu$i/cpufreq/scaling_cur_freq") ?: continue
            val max = readLongFile("/sys/devices/system/cpu/cpu$i/cpufreq/cpuinfo_max_freq") ?: continue
            if (max > 0 && cur >= 0) {
                sumRatio += (cur.toDouble() / max.toDouble()).coerceIn(0.0, 1.0)
                sumCurKhz += cur
                valid++
            }
        }
        if (valid == 0) return -1 to -1
        val avgPct = ((sumRatio / valid) * 100.0).roundToInt().coerceIn(0, 100)
        val avgMhz = ((sumCurKhz / valid) / 1000L).toInt()
        return avgPct to avgMhz
    }

    private fun readThermalTempC(): Double {
        val raw = readLongFile("/sys/class/thermal/thermal_zone0/temp") ?: return -1.0
        val c = if (raw > 1000) raw / 1000.0 else raw.toDouble()
        return (c * 10.0).roundToInt() / 10.0
    }

    private fun readLongFile(path: String): Long? {
        return runCatching {
            val f = File(path)
            if (!f.canRead()) return null
            f.readText().trim().toLongOrNull()
        }.getOrNull()
    }

    @Synchronized
    private fun readNetworkSpeedKbps(): Pair<Double, Double> {
        val rx = TrafficStats.getTotalRxBytes()
        val tx = TrafficStats.getTotalTxBytes()
        val now = System.currentTimeMillis()
        if (rx == TrafficStats.UNSUPPORTED.toLong() || tx == TrafficStats.UNSUPPORTED.toLong()) {
            return -1.0 to -1.0
        }
        if (prevTrafficTs <= 0L || now <= prevTrafficTs) {
            prevRxBytes = rx
            prevTxBytes = tx
            prevTrafficTs = now
            return 0.0 to 0.0
        }
        val dtMs = now - prevTrafficTs
        if (dtMs < 1500L) {
            return cachedRxKbps to cachedTxKbps
        }
        val dtSec = dtMs / 1000.0
        val rxKbps = (((rx - prevRxBytes).coerceAtLeast(0) / 1024.0) / dtSec * 10.0).roundToInt() / 10.0
        val txKbps = (((tx - prevTxBytes).coerceAtLeast(0) / 1024.0) / dtSec * 10.0).roundToInt() / 10.0
        prevRxBytes = rx
        prevTxBytes = tx
        prevTrafficTs = now
        cachedRxKbps = rxKbps
        cachedTxKbps = txKbps
        return rxKbps to txKbps
    }

    private fun readWifiSummary(context: Context): Pair<Boolean, Int> {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val net = cm.activeNetwork
        val caps = if (net != null) cm.getNetworkCapabilities(net) else null
        val onWifi = caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        var rssi = -1
        if (onWifi) {
            @Suppress("DEPRECATION")
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            @Suppress("DEPRECATION")
            rssi = wm?.connectionInfo?.rssi ?: -1
        }
        return onWifi to rssi
    }

    fun getLocalIpv4Addresses(): List<String> {
        val list = mutableListOf<String>()
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return list
            for (intf in interfaces) {
                if (!intf.isUp || intf.isLoopback) continue
                for (addr in intf.inetAddresses) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        addr.hostAddress?.let { list.add(it) }
                    }
                }
            }
        } catch (_: Throwable) {
        }
        return list
    }
}
