package com.santhu.phonebox

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import com.santhu.phonebox.server.ServerService
import com.santhu.phonebox.system.DeviceTelemetry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var serverPort: Int = 8765
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    private val requestPerms = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { }

    private val pickFileLauncher = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        fileChooserCallback?.onReceiveValue(if (uris.isNullOrEmpty()) null else uris.toTypedArray())
        fileChooserCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        serverPort = PhoneBoxApp.instance.db.getSetting("port", "8765").toIntOrNull() ?: 8765
        ServerService.start(this)
        ServerService.onSettingsUpdated = {
            runOnUiThread { applyScreenSettings() }
        }

        val needed = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add(Manifest.permission.ACTIVITY_RECOGNITION)
        }
        val hasTermux = runCatching { packageManager.getPackageInfo("com.termux", 0) }.isSuccess
        if (hasTermux &&
            ContextCompat.checkSelfPermission(this, "com.termux.permission.RUN_COMMAND") != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add("com.termux.permission.RUN_COMMAND")
        }
        if (needed.isNotEmpty()) {
            requestPerms.launch(needed.toTypedArray())
        }

        enableImmersiveFullscreen()
        applyScreenSettings()

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#090B10"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.setSupportZoom(false)
            settings.mediaPlaybackRequiresUserGesture = false
            overScrollMode = WebView.OVER_SCROLL_NEVER

            addJavascriptInterface(NativeBridge(), "PhoneBoxNative")

            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>,
                    fileChooserParams: FileChooserParams?
                ): Boolean {
                    fileChooserCallback?.onReceiveValue(null)
                    fileChooserCallback = filePathCallback
                    return runCatching {
                        pickFileLauncher.launch(arrayOf("*/*"))
                        true
                    }.getOrElse {
                        fileChooserCallback = null
                        false
                    }
                }
            }
            webViewClient = object : WebViewClient() {
                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError
                ) {
                    if (request.isForMainFrame) {
                        lifecycleScope.launch {
                            delay(500)
                            loadPanelWhenReady()
                        }
                    }
                }
            }
        }
        setContentView(webView)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript("window.pbHandleBack ? window.pbHandleBack() : false") { result ->
                    if (result != "true") {
                        moveTaskToBack(true)
                    }
                }
            }
        })

        loadPanelWhenReady()
    }

    override fun onResume() {
        super.onResume()
        enableImmersiveFullscreen()
        applyScreenSettings()
    }

    override fun onDestroy() {
        ServerService.onSettingsUpdated = null
        webView.destroy()
        super.onDestroy()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        return when (keyCode) {
            KeyEvent.KEYCODE_VOLUME_UP -> {
                webView.evaluateJavascript("window.pbStepPage && window.pbStepPage(-1);", null)
                true
            }
            KeyEvent.KEYCODE_VOLUME_DOWN -> {
                webView.evaluateJavascript("window.pbStepPage && window.pbStepPage(1);", null)
                true
            }
            else -> super.onKeyDown(keyCode, event)
        }
    }

    private fun applyScreenSettings() {
        val keepOn = PhoneBoxApp.instance.db.getSetting("keep_screen_on", "1") == "1"
        if (keepOn) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun enableImmersiveFullscreen() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    private fun loadPanelWhenReady() {
        lifecycleScope.launch {
            val url = "http://127.0.0.1:$serverPort/api/health"
            withContext(Dispatchers.IO) {
                repeat(25) {
                    val ok = runCatching {
                        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                            connectTimeout = 400
                            readTimeout = 400
                        }
                        conn.responseCode == 200
                    }.getOrDefault(false)
                    if (ok) return@withContext
                    delay(150)
                }
            }
            webView.loadUrl("http://127.0.0.1:$serverPort/panel/")
        }
    }

    inner class NativeBridge {
        @JavascriptInterface
        fun vibrate(ms: Long) {
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val vm = getSystemService(VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                    vm?.defaultVibrator?.vibrate(VibrationEffect.createOneShot(ms.coerceIn(10, 500), VibrationEffect.DEFAULT_AMPLITUDE))
                } else {
                    @Suppress("DEPRECATION")
                    val v = getSystemService(VIBRATOR_SERVICE) as? Vibrator
                    v?.vibrate(VibrationEffect.createOneShot(ms.coerceIn(10, 500), VibrationEffect.DEFAULT_AMPLITUDE))
                }
            }
        }

        @JavascriptInterface
        fun setKeepScreenOn(enabled: Boolean) {
            PhoneBoxApp.instance.db.putSettings(org.json.JSONObject().put("keep_screen_on", if (enabled) "1" else "0"))
            runOnUiThread { applyScreenSettings() }
        }

        @JavascriptInterface
        fun getAdminUrl(): String {
            return DeviceTelemetry.collect(this@MainActivity, serverPort, System.currentTimeMillis())
                .optString("adminUrl", "http://127.0.0.1:$serverPort/admin/")
        }

        @JavascriptInterface
        fun toast(message: String) {
            runOnUiThread { Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show() }
        }
    }
}
