package com.santhu.phonebox.server

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import com.santhu.phonebox.PhoneBoxApp
import com.santhu.phonebox.system.AppLog

class NetworkWatchdogJobService : JobService() {

    override fun onStartJob(params: JobParameters): Boolean {
        val ctx = applicationContext
        AppLog.add("info", "watchdog", "Network trigger (job=${params.jobId}) ensuring server & SSH")
        if (!ServerService.isRunning) {
            runCatching { ServerService.start(ctx) }
        }
        val autoKeep = runCatching { PhoneBoxApp.instance.db.getSetting("auto_keep_ssh", "1") == "1" }.getOrDefault(true)
        if (autoKeep) {
            ServerService.ensureTermuxSshAsync(ctx)
        }
        if (params.jobId == JOB_ON_NET_CONNECT) {
            schedulePeriodic(ctx)
        }
        jobFinished(params, false)
        return false
    }

    override fun onStopJob(params: JobParameters): Boolean = false

    companion object {
        const val JOB_ON_NET_CONNECT = 2001
        const val JOB_PERIODIC_NET = 2002

        fun schedule(context: Context) {
            scheduleOnConnect(context)
            schedulePeriodic(context)
        }

        fun scheduleOnConnect(context: Context) {
            val js = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return
            if (js.getPendingJob(JOB_ON_NET_CONNECT) != null) return
            val info = JobInfo.Builder(
                JOB_ON_NET_CONNECT,
                ComponentName(context, NetworkWatchdogJobService::class.java)
            )
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build()
            js.schedule(info)
        }

        fun schedulePeriodic(context: Context) {
            val js = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return
            if (js.getPendingJob(JOB_PERIODIC_NET) != null) return
            val info = JobInfo.Builder(
                JOB_PERIODIC_NET,
                ComponentName(context, NetworkWatchdogJobService::class.java)
            )
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60_000L)
                .setPersisted(true)
                .build()
            js.schedule(info)
        }

        fun isScheduled(context: Context): Boolean {
            val js = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return false
            return js.getPendingJob(JOB_PERIODIC_NET) != null || js.getPendingJob(JOB_ON_NET_CONNECT) != null
        }
    }
}
