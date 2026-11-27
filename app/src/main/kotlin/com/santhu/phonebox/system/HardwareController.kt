package com.santhu.phonebox.system

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.view.KeyEvent
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.roundToInt
import kotlin.math.sqrt

class HardwareController(private val context: Context) : SensorEventListener {

    private val mainHandler = Handler(Looper.getMainLooper())
    private val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    private val iconCache = ConcurrentHashMap<String, ByteArray>()
    private var torchCameraId: String? = null
    @Volatile var torchOn: Boolean = false
        private set

    @Volatile var luxValue: Float = -1f
        private set
    @Volatile var stepsValue: Float = -1f
        private set
    @Volatile var motionValue: Float = 0f
        private set

    private var tts: TextToSpeech? = null
    @Volatile private var ttsReady = false

    private val torchCallback = object : CameraManager.TorchCallback() {
        override fun onTorchModeChanged(cameraId: String, enabled: Boolean) {
            if (cameraId == torchCameraId) {
                torchOn = enabled
                onHardwareChanged?.invoke()
            }
        }
    }

    var onHardwareChanged: (() -> Unit)? = null

    fun start() {
        runCatching {
            torchCameraId = cameraManager.cameraIdList.firstOrNull { id ->
                cameraManager.getCameraCharacteristics(id).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
            }
            if (torchCameraId != null) {
                cameraManager.registerTorchCallback(torchCallback, mainHandler)
            }
        }

        runCatching {
            sensorManager.getDefaultSensor(Sensor.TYPE_LIGHT)?.let {
                sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
            }
            sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)?.let {
                sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
            }
            sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let {
                sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_UI)
            }
        }

        mainHandler.post {
            tts = TextToSpeech(context.applicationContext) { status ->
                ttsReady = (status == TextToSpeech.SUCCESS)
                if (ttsReady) tts?.language = Locale.getDefault()
            }
        }
    }

    fun stop() {
        runCatching { cameraManager.unregisterTorchCallback(torchCallback) }
        runCatching { sensorManager.unregisterListener(this) }
        runCatching { tts?.stop(); tts?.shutdown() }
        tts = null
    }

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_LIGHT -> luxValue = event.values.firstOrNull() ?: -1f
            Sensor.TYPE_STEP_COUNTER -> stepsValue = event.values.firstOrNull() ?: -1f
            Sensor.TYPE_ACCELEROMETER -> {
                if (event.values.size >= 3) {
                    val x = event.values[0]
                    val y = event.values[1]
                    val z = event.values[2]
                    motionValue = sqrt(x * x + y * y + z * z)
                }
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    fun setTorch(enable: Boolean): Boolean {
        val id = torchCameraId ?: return false
        return runCatching {
            cameraManager.setTorchMode(id, enable)
            torchOn = enable
            true
        }.getOrDefault(false)
    }

    fun toggleTorch(): Boolean = setTorch(!torchOn)

    fun getAudioState(): JSONObject {
        val cur = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
        val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        val ringCur = audioManager.getStreamVolume(AudioManager.STREAM_RING)
        val ringMax = audioManager.getStreamMaxVolume(AudioManager.STREAM_RING).coerceAtLeast(1)
        return JSONObject().apply {
            put("mediaVol", ((cur * 100f) / max).roundToInt())
            put("mediaMuted", audioManager.isStreamMute(AudioManager.STREAM_MUSIC))
            put("ringVol", ((ringCur * 100f) / ringMax).roundToInt())
            put("ringerMode", audioManager.ringerMode)
            put("musicActive", audioManager.isMusicActive)
        }
    }

    fun setMediaVolumePercent(pct: Int) {
        val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        val target = ((pct.coerceIn(0, 100) / 100f) * max).roundToInt()
        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
    }

    fun toggleMuteMedia(): Boolean {
        val muted = audioManager.isStreamMute(AudioManager.STREAM_MUSIC)
        audioManager.adjustStreamVolume(
            AudioManager.STREAM_MUSIC,
            if (muted) AudioManager.ADJUST_UNMUTE else AudioManager.ADJUST_MUTE,
            0
        )
        return !muted
    }

    fun sendMediaKey(action: String) {
        val controllerHandled = PhoneNotificationService.dispatchMediaAction(action)
        if (controllerHandled) return
        val code = when (action) {
            "play_pause" -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
            "play" -> KeyEvent.KEYCODE_MEDIA_PLAY
            "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE
            "next" -> KeyEvent.KEYCODE_MEDIA_NEXT
            "prev" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
            "stop" -> KeyEvent.KEYCODE_MEDIA_STOP
            else -> return
        }
        audioManager.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
        audioManager.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
    }

    fun beepFindPhone() {
        runCatching {
            val tg = ToneGenerator(AudioManager.STREAM_ALARM, 95)
            tg.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 900)
            mainHandler.postDelayed({ runCatching { tg.release() } }, 1100)
        }
    }

    fun speak(text: String): Boolean {
        if (!ttsReady || text.isBlank()) return false
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "pb_${System.currentTimeMillis()}")
        return true
    }

    fun getClipboardText(): String {
        var result = ""
        val latch = java.util.concurrent.CountDownLatch(1)
        mainHandler.post {
            runCatching {
                val clip = clipboard.primaryClip
                if (clip != null && clip.itemCount > 0) {
                    result = clip.getItemAt(0).coerceToText(context)?.toString() ?: ""
                }
            }
            latch.countDown()
        }
        runCatching { latch.await(800, java.util.concurrent.TimeUnit.MILLISECONDS) }
        return result
    }

    fun setClipboardText(text: String) {
        mainHandler.post {
            runCatching {
                clipboard.setPrimaryClip(ClipData.newPlainText("F.R.I.D.A.Y.", text))
            }
        }
    }

    fun listInstalledApps(): JSONArray {
        val pm = context.packageManager
        val intent = Intent(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_LAUNCHER) }
        val resolved = pm.queryIntentActivities(intent, PackageManager.MATCH_ALL)
        val seen = HashSet<String>()
        val list = mutableListOf<Triple<String, String, Boolean>>()
        for (ri in resolved) {
            val pkg = ri.activityInfo?.packageName ?: continue
            if (pkg == context.packageName || !seen.add(pkg)) continue
            val label = ri.loadLabel(pm)?.toString()?.trim().orEmpty().ifBlank { pkg }
            val isSys = (ri.activityInfo.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0
            list.add(Triple(pkg, label, isSys))
        }
        list.sortWith(compareBy<Triple<String, String, Boolean>> { it.third }.thenBy { it.second.lowercase() })
        val arr = JSONArray()
        for ((pkg, label, isSys) in list) {
            arr.put(JSONObject().apply {
                put("pkg", pkg)
                put("label", label)
                put("system", isSys)
                put("iconUrl", "/api/apps/icon?pkg=$pkg")
            })
        }
        return arr
    }

    fun getAppIconPng(pkg: String): ByteArray? {
        iconCache[pkg]?.let { return it }
        return runCatching {
            val drawable = context.packageManager.getApplicationIcon(pkg)
            val bmp = drawableToBitmap(drawable, 72)
            val baos = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.PNG, 90, baos)
            val bytes = baos.toByteArray()
            iconCache[pkg] = bytes
            bytes
        }.getOrNull()
    }

    fun launchApp(pkg: String): Boolean {
        val launch = context.packageManager.getLaunchIntentForPackage(pkg) ?: return false
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        return runCatching {
            context.startActivity(launch)
            true
        }.getOrDefault(false)
    }

    fun openUri(uriStr: String): Boolean {
        return runCatching {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uriStr)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            true
        }.getOrDefault(false)
    }

    fun openAndroidSettings(kind: String): Boolean {
        val action = when (kind) {
            "accessibility" -> Settings.ACTION_ACCESSIBILITY_SETTINGS
            "notifications" -> Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS
            "battery_exempt" -> Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS
            "wifi" -> Settings.ACTION_WIFI_SETTINGS
            "app_info", "termux_info" -> Settings.ACTION_APPLICATION_DETAILS_SETTINGS
            else -> Settings.ACTION_SETTINGS
        }
        val intent = Intent(action).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            when (kind) {
                "app_info" -> data = Uri.parse("package:${context.packageName}")
                "termux_info" -> data = Uri.parse("package:com.termux")
            }
        }
        return runCatching {
            context.startActivity(intent)
            true
        }.getOrDefault(false)
    }

    fun getSensorsSnapshot(): JSONObject {
        return JSONObject().apply {
            put("torchOn", torchOn)
            put("hasTorch", torchCameraId != null)
            put("lightLux", if (luxValue >= 0f) (luxValue * 10f).roundToInt() / 10.0 else -1)
            put("steps", if (stepsValue >= 0f) stepsValue.toInt() else -1)
            put("motionG", (motionValue * 100f).roundToInt() / 100.0)
        }
    }

    private fun drawableToBitmap(drawable: Drawable, size: Int): Bitmap {
        if (drawable is BitmapDrawable && drawable.bitmap != null) {
            return Bitmap.createScaledBitmap(drawable.bitmap, size, size, true)
        }
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        drawable.setBounds(0, 0, canvas.width, canvas.height)
        drawable.draw(canvas)
        return bitmap
    }
}
