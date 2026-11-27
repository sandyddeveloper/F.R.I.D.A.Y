package com.santhu.phonebox.server

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.santhu.phonebox.MainActivity
import com.santhu.phonebox.PhoneBoxApp
import com.santhu.phonebox.R
import com.santhu.phonebox.system.AppLog
import com.santhu.phonebox.system.DeviceTelemetry
import com.santhu.phonebox.system.FeedFetcher
import com.santhu.phonebox.system.NetworkTools
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

class ServerService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var server: EmbeddedServer? = null
    private var ruleEngine: RuleEngine? = null
    private var relayClient: RelayClient? = null
    private val startedAt = System.currentTimeMillis()
    private var port = 8765

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        val app = PhoneBoxApp.instance
        port = app.db.getSetting("port", "8765").toIntOrNull() ?: 8765
        app.hw.start()
        app.hw.onHardwareChanged = { server?.notifyChange("state") }

        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PhoneBoxServer::ServerWakeLock").apply {
            setReferenceCounted(false)
            acquire()
        }
        wakeLockHeld = wakeLock?.isHeld == true

        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        if (wm != null) {
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                @Suppress("DEPRECATION")
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            @Suppress("DEPRECATION")
            wifiLock = wm.createWifiLock(mode, "PhoneBoxServer::WifiLock").apply {
                setReferenceCounted(false)
                acquire()
            }
            wifiLockHeld = wifiLock?.isHeld == true
        }

        val notif = buildNotification("Starting server on port $port...")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notif)
        }

        val engine = RuleEngine(
            db = app.db,
            hw = app.hw,
            onGotoPage = { page -> server?.notifyChange("goto", JSONObject().put("page", page).toString()) },
            onToast = { t, b, l -> server?.notifyChange("toast", JSONObject().put("title", t).put("body", b).put("level", l).toString()) }
        )
        ruleEngine = engine

        val srv = EmbeddedServer(
            context = this,
            db = app.db,
            hw = app.hw,
            ruleEngine = engine,
            port = port,
            startedAt = startedAt,
            onRunMonitorsNow = { checkAllMonitors() },
            onRefreshNewsNow = { refreshNews() },
            onSettingsApplied = { notifyUiChanged() }
        )
        server = srv
        srv.start(scope)
        activeServer = srv

        val rc = RelayClient(app.db, port)
        relayClient = rc
        activeRelay = rc
        rc.startOrRestart(scope)

        NetworkWatchdogJobService.schedule(this)
        registerNetworkWatcher()
        startTelemetryLoop()
        startMonitorLoop()
        startNewsLoop()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        updateNotification()
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        activeServer = null
        activeRelay = null
        relayClient?.stop()
        relayClient = null
        server?.stop()
        server = null
        PhoneBoxApp.instance.hw.onHardwareChanged = null
        PhoneBoxApp.instance.hw.stop()
        runCatching {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            networkCallback?.let { cm?.unregisterNetworkCallback(it) }
        }
        networkCallback = null
        scope.cancel()
        runCatching {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        }
        runCatching {
            if (wifiLock?.isHeld == true) wifiLock?.release()
        }
        wakeLock = null
        wifiLock = null
        wakeLockHeld = false
        wifiLockHeld = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun registerNetworkWatcher() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val req = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scope.launch {
                    val t = DeviceTelemetry.collect(this@ServerService, port, startedAt)
                    updateNotification(t.optString("adminUrl", "http://127.0.0.1:$port/admin/"))
                    if (PhoneBoxApp.instance.db.getSetting("auto_keep_ssh", "1") == "1") {
                        ensureTermuxSsh(this@ServerService)
                    }
                    checkAllMonitors()
                    server?.notifyChange("state")
                }
            }

            override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
                scope.launch {
                    val t = DeviceTelemetry.collect(this@ServerService, port, startedAt)
                    updateNotification(t.optString("adminUrl", "http://127.0.0.1:$port/admin/"))
                    server?.notifyChange("state")
                }
            }

            override fun onLost(network: Network) {
                NetworkWatchdogJobService.scheduleOnConnect(this@ServerService)
                updateNotification("Waiting for network... :$port")
                server?.notifyChange("state")
            }
        }
        networkCallback = cb
        runCatching { cm.registerNetworkCallback(req, cb) }
    }

    private fun startTelemetryLoop() {
        scope.launch {
            var tick = 0
            while (isActive) {
                runCatching {
                    val app = PhoneBoxApp.instance
                    val t = DeviceTelemetry.collect(this@ServerService, port, startedAt)
                    val bat = t.optDouble("batteryPct", -1.0)
                    val cpu = t.optDouble("cpuPct", -1.0)
                    val ram = t.optDouble("ramPct", -1.0)
                    val rx = t.optDouble("netRxKbps", -1.0)
                    val tx = t.optDouble("netTxKbps", -1.0)
                    val socT = t.optDouble("socTempC", -1.0)
                    if (bat >= 0) app.db.recordMetric("batteryPct", bat)
                    if (cpu >= 0) app.db.recordMetric("cpuPct", cpu)
                    if (ram >= 0) app.db.recordMetric("ramPct", ram)
                    if (rx >= 0) app.db.recordMetric("netRxKbps", rx)
                    if (tx >= 0) app.db.recordMetric("netTxKbps", tx)
                    if (socT >= 0) app.db.recordMetric("socTempC", socT)
                    if (tick % 2 == 0) {
                        ruleEngine?.evaluate(t, scope)
                        updateNotification(t.optString("adminUrl", "http://127.0.0.1:$port/admin/"))
                    }
                    if (tick % 7 == 0 && app.db.getSetting("auto_keep_ssh", "1") == "1") {
                        ensureTermuxSsh(this@ServerService)
                    }
                    tick++
                }
                delay(4_000)
            }
        }
    }

    private fun startMonitorLoop() {
        scope.launch {
            delay(1500)
            while (isActive) {
                runCatching { checkAllMonitors() }
                delay(15_000)
            }
        }
    }

    private fun startNewsLoop() {
        scope.launch {
            delay(2500)
            while (isActive) {
                runCatching { refreshNews() }
                delay(10 * 60_000L)
            }
        }
    }

    private fun refreshNews() {
        val db = PhoneBoxApp.instance.db
        val feeds = db.getFeeds()
        val combined = JSONArray()
        var anyFeed = false
        for (i in 0 until feeds.length()) {
            val f = feeds.getJSONObject(i)
            if (!f.optBoolean("enabled", true)) continue
            anyFeed = true
            val items = FeedFetcher.fetchRssFeed(f.getString("name"), f.getString("url"), 6)
            for (j in 0 until items.length()) combined.put(items.getJSONObject(j))
        }
        if (!anyFeed || db.getSetting("news_mode", "hn") == "hn") {
            val hn = FeedFetcher.fetchHackerNews(8)
            for (j in 0 until hn.length()) combined.put(hn.getJSONObject(j))
        }
        cachedNews = combined
        server?.notifyChange("state")
    }

    private fun checkAllMonitors() {
        val db = PhoneBoxApp.instance.db
        val monitors = db.getMonitors()
        for (i in 0 until monitors.length()) {
            val m = monitors.getJSONObject(i)
            val id = m.getLong("id")
            val name = m.getString("name")
            val host = m.getString("host")
            val mPort = m.getInt("port")
            val prevUp = m.getInt("up")
            val res = NetworkTools.checkHost(host, mPort)
            db.updateMonitorStatus(id, res.up, res.latencyMs)
            if (res.latencyMs >= 0) {
                db.recordMetric("monitor:$id", res.latencyMs.toDouble())
            }
            if (prevUp != -1 && (prevUp == 1) != res.up) {
                val lvl = if (res.up) "ok" else "error"
                val msg = if (res.up) "$name ($host) is back online (${res.latencyMs}ms)" else "$name ($host) is unreachable"
                db.addNotification("Uptime Alert: $name", msg, lvl, "monitor")
                AppLog.add(lvl, "monitor", msg)
            }
        }
        server?.notifyChange("state")
    }

    private fun notifyUiChanged() {
        relayClient?.startOrRestart(scope)
        server?.notifyChange("state")
        onSettingsUpdated?.invoke()
    }

    private fun updateNotification(urlHint: String? = null) {
        val url = urlHint ?: DeviceTelemetry.collect(this, port, startedAt).optString("adminUrl")
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.notify(NOTIFICATION_ID, buildNotification("Studio: $url"))
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, PhoneBoxApp.CHANNEL_SERVER)
            .setSmallIcon(R.drawable.ic_stat_friday)
            .setContentTitle("F.R.I.D.A.Y. Server Running")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openIntent)
            .build()
    }

    companion object {
        const val NOTIFICATION_ID = 1001
        const val ACTION_STOP = "com.santhu.phonebox.STOP_SERVER"

        @Volatile
        var isRunning: Boolean = false
            private set

        @Volatile
        var wakeLockHeld: Boolean = false
            private set

        @Volatile
        var wifiLockHeld: Boolean = false
            private set

        @Volatile
        var activeServer: EmbeddedServer? = null
            private set

        @Volatile
        var activeRelay: RelayClient? = null
            private set

        @Volatile
        var cachedNews: JSONArray = JSONArray()

        @Volatile
        var onSettingsUpdated: (() -> Unit)? = null

        @Volatile
        private var lastSshEnsureAt: Long = 0L

        private val sshExec = Executors.newSingleThreadExecutor()

        fun start(context: Context) {
            val intent = Intent(context, ServerService::class.java)
            context.startForegroundService(intent)
        }

        fun ensureTermuxSshAsync(context: Context, force: Boolean = false) {
            val appCtx = context.applicationContext
            sshExec.execute { ensureTermuxSsh(appCtx, force) }
        }

        /**
         * Ensures Termux sshd is listening on port 8022; when down, starts it cleanly
         * in the background via Termux's RunCommandService (requires RUN_COMMAND grant
         * and allow-external-apps=true in ~/.termux/termux.properties).
         */
        fun ensureTermuxSsh(context: Context, force: Boolean = false): Boolean {
            if (NetworkTools.checkHost("127.0.0.1", 8022, 120).up) return true
            val hasTermux = runCatching { context.packageManager.getPackageInfo("com.termux", 0) }.isSuccess
            if (!hasTermux) return false
            if (context.checkSelfPermission("com.termux.permission.RUN_COMMAND") != PackageManager.PERMISSION_GRANTED) {
                return false
            }
            val now = System.currentTimeMillis()
            if (!force && now - lastSshEnsureAt < 20_000L) return false
            lastSshEnsureAt = now

            val intent = Intent("com.termux.RUN_COMMAND").apply {
                component = ComponentName("com.termux", "com.termux.app.RunCommandService")
                putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash")
                putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-lc", "termux-wake-lock; pgrep -x sshd >/dev/null || sshd"))
                putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
                putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0")
            }
            val started = runCatching {
                context.startService(intent)
                true
            }.getOrElse {
                runCatching {
                    context.startForegroundService(intent)
                    true
                }.getOrDefault(false)
            }
            AppLog.add(if (started) "ok" else "error", "ssh", "Auto-ensure Termux sshd via RUN_COMMAND -> $started")
            return started
        }
    }
}
