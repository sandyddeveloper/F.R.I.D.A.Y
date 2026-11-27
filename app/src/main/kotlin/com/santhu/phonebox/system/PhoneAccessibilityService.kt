package com.santhu.phonebox.system

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.Context
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject

class PhoneAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        instance = this
        AppLog.add("ok", "a11y", "Accessibility Remote Control connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val pkg = event?.packageName?.toString()
        if (!pkg.isNullOrBlank()) {
            currentForegroundPkg = pkg
        }
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        if (instance == this) instance = null
        super.onDestroy()
    }

    fun performGlobal(name: String): Boolean {
        val action = when (name.lowercase()) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
            "power" -> GLOBAL_ACTION_POWER_DIALOG
            "lock" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) GLOBAL_ACTION_LOCK_SCREEN else return false
            "screenshot" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) GLOBAL_ACTION_TAKE_SCREENSHOT else return false
            else -> return false
        }
        return performGlobalAction(action)
    }

    fun tap(x: Float, y: Float): Boolean {
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 50)
        return dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long = 320): Boolean {
        val path = Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs.coerceIn(60, 2000))
        return dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    fun inspectScreenNodes(limit: Int = 40): JSONObject {
        val root = rootInActiveWindow
        val items = JSONArray()
        if (root != null) {
            collectNodes(root, items, limit)
        }
        return JSONObject().apply {
            put("connected", true)
            put("foregroundPkg", currentForegroundPkg)
            put("nodes", items)
        }
    }

    private fun collectNodes(node: AccessibilityNodeInfo, out: JSONArray, limit: Int) {
        if (out.length() >= limit) return
        val txt = node.text?.toString()?.trim().orEmpty()
        val desc = node.contentDescription?.toString()?.trim().orEmpty()
        val clickable = node.isClickable
        val editable = node.isEditable
        if ((txt.isNotBlank() || desc.isNotBlank() || editable) && (clickable || editable || txt.length <= 60)) {
            val rect = Rect()
            node.getBoundsInScreen(rect)
            if (rect.width() > 0 && rect.height() > 0) {
                out.put(JSONObject().apply {
                    put("text", txt.ifBlank { desc })
                    put("cls", node.className?.toString()?.substringAfterLast('.') ?: "")
                    put("clickable", clickable)
                    put("editable", editable)
                    put("cx", rect.centerX())
                    put("cy", rect.centerY())
                })
            }
        }
        for (i in 0 until node.childCount) {
            val ch = node.getChild(i) ?: continue
            collectNodes(ch, out, limit)
            if (out.length() >= limit) break
        }
    }

    fun tapByText(query: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val matches = root.findAccessibilityNodeInfosByText(query)
        for (n in matches) {
            var cur: AccessibilityNodeInfo? = n
            while (cur != null) {
                if (cur.isClickable) {
                    return cur.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                }
                cur = cur.parent
            }
            val r = Rect()
            n.getBoundsInScreen(r)
            if (r.width() > 0 && r.height() > 0) {
                return tap(r.centerX().toFloat(), r.centerY().toFloat())
            }
        }
        return false
    }

    fun typeTextIntoFocused(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: findFirstEditable(root) ?: return false
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    private fun findFirstEditable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isEditable) return node
        for (i in 0 until node.childCount) {
            val c = node.getChild(i) ?: continue
            findFirstEditable(c)?.let { return it }
        }
        return null
    }

    companion object {
        @Volatile
        var instance: PhoneAccessibilityService? = null
            private set

        @Volatile
        var currentForegroundPkg: String = ""
            private set

        fun isEnabled(context: Context): Boolean {
            val flat = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            return flat.contains(ComponentName(context, PhoneAccessibilityService::class.java).flattenToString())
        }

        suspend fun runMacroSteps(steps: JSONArray, hw: HardwareController): Pair<Boolean, String> {
            for (i in 0 until steps.length()) {
                val st = steps.optJSONObject(i) ?: continue
                val op = st.optString("op", "")
                when (op) {
                    "launch" -> hw.launchApp(st.optString("value", ""))
                    "url" -> hw.openUri(st.optString("value", ""))
                    "wait" -> delay(st.optLong("ms", 800).coerceIn(50, 15000))
                    "global" -> instance?.performGlobal(st.optString("value", "home"))
                    "tap_text" -> instance?.tapByText(st.optString("value", ""))
                    "tap_xy" -> {
                        val x = st.optDouble("x", 540.0).toFloat()
                        val y = st.optDouble("y", 1200.0).toFloat()
                        instance?.tap(x, y)
                    }
                    "swipe" -> {
                        instance?.swipe(
                            st.optDouble("x1", 540.0).toFloat(),
                            st.optDouble("y1", 1600.0).toFloat(),
                            st.optDouble("x2", 540.0).toFloat(),
                            st.optDouble("y2", 600.0).toFloat(),
                            st.optLong("ms", 320)
                        )
                    }
                    "type" -> instance?.typeTextIntoFocused(st.optString("value", ""))
                    "media" -> hw.sendMediaKey(st.optString("value", "play_pause"))
                    "torch" -> hw.setTorch(st.optBoolean("on", true))
                    "tts" -> hw.speak(st.optString("value", ""))
                }
            }
            return true to "Executed ${steps.length()} step(s)"
        }
    }
}
