package com.santhu.phonebox

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.santhu.phonebox.server.NetworkWatchdogJobService
import com.santhu.phonebox.server.ServerService
import com.santhu.phonebox.system.AppLog

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val act = intent.action ?: return
        if (act == Intent.ACTION_BOOT_COMPLETED ||
            act == Intent.ACTION_MY_PACKAGE_REPLACED ||
            act == "android.intent.action.QUICKBOOT_POWERON" ||
            act == "com.htc.intent.action.QUICKBOOT_POWERON"
        ) {
            AppLog.add("ok", "boot", "Receiver triggered ($act); starting server & watchdog")
            runCatching { ServerService.start(context) }
            runCatching { NetworkWatchdogJobService.schedule(context) }
        }
    }
}
