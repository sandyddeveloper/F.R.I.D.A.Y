package com.santhu.phonebox.system

import android.app.Notification
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Bundle
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.santhu.phonebox.PhoneBoxApp
import com.santhu.phonebox.server.ServerService
import org.json.JSONArray
import org.json.JSONObject

class PhoneNotificationService : NotificationListenerService() {

    override fun onListenerConnected() {
        instance = this
        AppLog.add("ok", "bridge", "Notification & Media Listener connected")
        ServerService.activeServer?.notifyChange("state")
    }

    override fun onListenerDisconnected() {
        if (instance == this) instance = null
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName == packageName) return
        val item = sbnToJson(this, sbn) ?: return
        val appLabel = item.optString("app")
        val title = item.optString("title")
        val text = item.optString("text")

        PhoneBoxApp.instance.db.addNotification(
            title = if (title.isNotBlank()) "$appLabel: $title" else appLabel,
            body = item.optString("bigText").ifBlank { text },
            level = if (item.optString("category") == Notification.CATEGORY_CALL) "warn" else "info",
            source = sbn.packageName
        )
        ServerService.activeServer?.notifyChange("phone_notif", item.toString())
        ServerService.activeServer?.notifyChange("state")
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        ServerService.activeServer?.notifyChange("state")
    }

    companion object {
        @Volatile
        var instance: PhoneNotificationService? = null
            private set

        fun isEnabled(context: Context): Boolean {
            val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: return false
            return flat.contains(ComponentName(context, PhoneNotificationService::class.java).flattenToString())
        }

        fun getActiveMedia(context: Context): JSONObject {
            val svc = instance
            if (svc == null) {
                return JSONObject().put("connected", false).put("playing", false)
            }
            return runCatching {
                val msm = context.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
                val controllers = msm.getActiveSessions(ComponentName(context, PhoneNotificationService::class.java))
                val best = pickBestController(controllers)
                if (best == null) {
                    JSONObject().put("connected", true).put("playing", false)
                } else {
                    val meta = best.metadata
                    val pb = best.playbackState
                    val stateInt = pb?.state ?: PlaybackState.STATE_NONE
                    val playing = stateInt == PlaybackState.STATE_PLAYING
                    val pkg = best.packageName
                    val appName = runCatching {
                        val ai = context.packageManager.getApplicationInfo(pkg, 0)
                        context.packageManager.getApplicationLabel(ai).toString()
                    }.getOrDefault(pkg)
                    JSONObject().apply {
                        put("connected", true)
                        put("playing", playing)
                        put("state", stateInt)
                        put("pkg", pkg)
                        put("app", appName)
                        put("title", meta?.getString(MediaMetadata.METADATA_KEY_TITLE) ?: "")
                        put("artist", meta?.getString(MediaMetadata.METADATA_KEY_ARTIST) ?: "")
                        put("album", meta?.getString(MediaMetadata.METADATA_KEY_ALBUM) ?: "")
                        put("durationMs", meta?.getLong(MediaMetadata.METADATA_KEY_DURATION) ?: 0L)
                        put("positionMs", pb?.position ?: 0L)
                    }
                }
            }.getOrElse {
                JSONObject().put("connected", false).put("playing", false)
            }
        }

        fun dispatchMediaAction(action: String): Boolean {
            val svc = instance ?: return false
            return runCatching {
                val msm = svc.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
                val controllers = msm.getActiveSessions(ComponentName(svc, PhoneNotificationService::class.java))
                val c = pickBestController(controllers) ?: return false
                val tc = c.transportControls
                when (action) {
                    "play" -> tc.play()
                    "pause" -> tc.pause()
                    "play_pause" -> {
                        if (c.playbackState?.state == PlaybackState.STATE_PLAYING) tc.pause() else tc.play()
                    }
                    "next" -> tc.skipToNext()
                    "prev" -> tc.skipToPrevious()
                    "stop" -> tc.stop()
                    else -> return false
                }
                true
            }.getOrDefault(false)
        }

        private fun sbnToJson(context: Context, sbn: StatusBarNotification): JSONObject? {
            val n = sbn.notification
            if ((n.flags and Notification.FLAG_GROUP_SUMMARY) != 0) return null
            val extras = n.extras
            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim() ?: ""
            val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim() ?: ""
            val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim() ?: ""
            if (title.isBlank() && text.isBlank() && bigText.isBlank()) return null

            val appName = runCatching {
                val ai = context.packageManager.getApplicationInfo(sbn.packageName, 0)
                context.packageManager.getApplicationLabel(ai).toString()
            }.getOrDefault(sbn.packageName)

            val actionsArr = JSONArray()
            n.actions?.forEachIndexed { idx, act ->
                val hasReply = act.remoteInputs?.isNotEmpty() == true
                actionsArr.put(JSONObject().apply {
                    put("index", idx)
                    put("title", act.title?.toString() ?: "")
                    put("canReply", hasReply)
                })
            }

            return JSONObject().apply {
                put("key", sbn.key)
                put("pkg", sbn.packageName)
                put("app", appName)
                put("title", title)
                put("text", text)
                put("bigText", bigText)
                put("category", n.category ?: "")
                put("isOngoing", (n.flags and Notification.FLAG_ONGOING_EVENT) != 0)
                put("postTime", sbn.postTime)
                put("actions", actionsArr)
            }
        }

        fun getActiveNotifications(context: Context): JSONArray {
            val arr = JSONArray()
            val svc = instance ?: return arr
            runCatching {
                val sbns = svc.activeNotifications ?: return arr
                for (sbn in sbns) {
                    if (sbn.packageName == context.packageName) continue
                    sbnToJson(context, sbn)?.let { arr.put(it) }
                }
            }
            return arr
        }

        fun getCallState(context: Context): JSONObject {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            val mode = am?.mode ?: AudioManager.MODE_NORMAL
            var callTitle = ""
            var hasCallNotif = false
            runCatching {
                val sbns = instance?.activeNotifications ?: emptyArray()
                for (sbn in sbns) {
                    if (sbn.packageName == context.packageName) continue
                    val n = sbn.notification
                    if ((n.flags and Notification.FLAG_GROUP_SUMMARY) != 0) continue
                    if (n.category == Notification.CATEGORY_CALL) {
                        hasCallNotif = true
                        callTitle = n.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim() ?: ""
                        break
                    }
                }
            }
            val stateStr = when {
                mode == AudioManager.MODE_RINGTONE -> "ringing"
                mode == AudioManager.MODE_IN_CALL -> "in_call"
                mode == AudioManager.MODE_IN_COMMUNICATION && hasCallNotif -> "in_call"
                hasCallNotif -> "ringing"
                else -> "idle"
            }
            return JSONObject().apply {
                put("active", stateStr != "idle")
                put("mode", stateStr)
                put("caller", callTitle)
            }
        }

        fun dismissNotification(key: String): Boolean {
            val svc = instance ?: return false
            return runCatching {
                svc.cancelNotification(key)
                true
            }.getOrDefault(false)
        }

        fun replyToNotification(key: String, actionIdx: Int, replyText: String): Boolean {
            val svc = instance ?: return false
            return runCatching {
                val sbn = svc.activeNotifications?.firstOrNull { it.key == key } ?: return false
                val act = sbn.notification.actions?.getOrNull(actionIdx) ?: return false
                val inputs = act.remoteInputs
                if (inputs != null && inputs.isNotEmpty()) {
                    val intent = Intent()
                    val bundle = Bundle()
                    for (ri in inputs) {
                        bundle.putCharSequence(ri.resultKey, replyText)
                    }
                    RemoteInput.addResultsToIntent(inputs, intent, bundle)
                    act.actionIntent.send(svc, 0, intent)
                } else {
                    act.actionIntent.send()
                }
                true
            }.getOrDefault(false)
        }

        private fun pickBestController(list: List<MediaController>): MediaController? {
            if (list.isEmpty()) return null
            return list.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING }
                ?: list.firstOrNull { it.metadata != null }
                ?: list.first()
        }
    }
}
