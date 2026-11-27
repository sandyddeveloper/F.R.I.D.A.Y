package com.santhu.phonebox

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.santhu.phonebox.db.PhoneDb
import com.santhu.phonebox.server.NetworkWatchdogJobService
import com.santhu.phonebox.system.HardwareController
import java.io.File

class PhoneBoxApp : Application() {
    lateinit var db: PhoneDb
        private set

    lateinit var dropDir: File
        private set

    lateinit var hw: HardwareController
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        dropDir = File(filesDir, "drops").apply { mkdirs() }
        db = PhoneDb(this)
        hw = HardwareController(this)
        createNotificationChannels()
        runCatching { NetworkWatchdogJobService.schedule(this) }
    }

    private fun createNotificationChannels() {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val serverChannel = NotificationChannel(
            CHANNEL_SERVER,
            getString(R.string.channel_server),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Keeps the local web server and SQLite database running"
            setShowBadge(false)
        }
        val alertChannel = NotificationChannel(
            CHANNEL_ALERTS,
            getString(R.string.channel_alerts),
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Webhook notifications and uptime alerts"
        }
        val urgentChannel = NotificationChannel(
            CHANNEL_URGENT,
            "Urgent Job & Laptop Alerts",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "High-priority job completion and system alerts"
            enableVibration(true)
        }
        nm.createNotificationChannel(serverChannel)
        nm.createNotificationChannel(alertChannel)
        nm.createNotificationChannel(urgentChannel)
    }

    companion object {
        const val CHANNEL_SERVER = "phonebox_server"
        const val CHANNEL_ALERTS = "phonebox_alerts"
        const val CHANNEL_URGENT = "phonebox_urgent"

        @Volatile
        lateinit var instance: PhoneBoxApp
            private set
    }
}
