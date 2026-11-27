package com.santhu.phonebox.server

import com.santhu.phonebox.db.PhoneDb
import com.santhu.phonebox.system.AppLog
import com.santhu.phonebox.system.HardwareController
import com.santhu.phonebox.system.PhoneAccessibilityService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.Calendar

class RuleEngine(
    private val db: PhoneDb,
    private val hw: HardwareController,
    private val onGotoPage: (String) -> Unit,
    private val onToast: (String, String, String) -> Unit
) {

    fun evaluate(telemetry: JSONObject, scope: CoroutineScope) {
        if (db.getSetting("rules_paused", "0") == "1") return
        val rules = db.getRules()
        val now = System.currentTimeMillis()

        for (i in 0 until rules.length()) {
            val r = rules.getJSONObject(i)
            if (!r.optBoolean("enabled", false)) continue
            val id = r.getLong("id")
            val cooldownMs = r.optInt("cooldownSec", 300) * 1000L
            val lastFired = r.optLong("lastFiredAt", 0L)
            if (now - lastFired < cooldownMs) continue

            val trigType = r.optString("triggerType", "")
            val trigVal = r.optString("triggerValue", "")
            if (matchesTrigger(trigType, trigVal, telemetry)) {
                db.markRuleFired(id)
                executeAction(r.optString("name", "Rule"), r.optString("actionType", ""), r.optString("actionValue", ""), scope)
            }
        }
    }

    fun runRuleById(id: Long, scope: CoroutineScope): Boolean {
        val rules = db.getRules()
        for (i in 0 until rules.length()) {
            val r = rules.getJSONObject(i)
            if (r.getLong("id") == id) {
                db.markRuleFired(id)
                executeAction(r.optString("name", "Rule"), r.optString("actionType", ""), r.optString("actionValue", ""), scope)
                return true
            }
        }
        return false
    }

    private fun matchesTrigger(type: String, value: String, telemetry: JSONObject): Boolean {
        return when (type) {
            "battery_below" -> {
                val threshold = value.toIntOrNull() ?: 20
                val bat = telemetry.optInt("batteryPct", 100)
                val charging = telemetry.optBoolean("charging", false)
                !charging && bat in 1..threshold
            }
            "battery_above" -> {
                val threshold = value.toIntOrNull() ?: 90
                telemetry.optInt("batteryPct", 0) >= threshold
            }
            "light_below" -> {
                val threshold = value.toDoubleOrNull() ?: 5.0
                val lux = hw.luxValue
                lux >= 0f && lux <= threshold
            }
            "monitor_down" -> {
                val mons = db.getMonitors()
                (0 until mons.length()).any { mons.getJSONObject(it).optInt("up", -1) == 0 }
            }
            "time_window" -> isWithinTimeWindow(value)
            "webhook_eq" -> {
                val parts = value.split("=", limit = 2)
                if (parts.size != 2) false else {
                    val v = db.getPushedMap().optJSONObject(parts[0].trim())?.optString("value", "")
                    v.equals(parts[1].trim(), ignoreCase = true)
                }
            }
            else -> false
        }
    }

    private fun executeAction(ruleName: String, type: String, value: String, scope: CoroutineScope) {
        AppLog.add("info", "rule", "Fired '$ruleName' -> $type($value)")
        when (type) {
            "notify" -> {
                val msg = value.ifBlank { "Rule '$ruleName' triggered" }
                db.addNotification(ruleName, msg, "warn", "rule")
                onToast(ruleName, msg, "warn")
            }
            "goto_page" -> {
                if (value.isNotBlank()) onGotoPage(value)
            }
            "torch_on" -> hw.setTorch(true)
            "torch_off" -> hw.setTorch(false)
            "beep" -> hw.beepFindPhone()
            "speak_tts" -> hw.speak(value.ifBlank { ruleName })
            "launch_app" -> if (value.isNotBlank()) hw.launchApp(value)
            "run_macro" -> {
                val id = value.toLongOrNull() ?: return
                val steps = db.findMacroSteps(id) ?: return
                scope.launch(Dispatchers.IO) {
                    PhoneAccessibilityService.runMacroSteps(steps, hw)
                }
            }
        }
    }

    private fun isWithinTimeWindow(spec: String): Boolean {
        val parts = spec.split("-")
        if (parts.size != 2) return false
        val start = parseMinutes(parts[0].trim()) ?: return false
        val end = parseMinutes(parts[1].trim()) ?: return false
        val cal = Calendar.getInstance()
        val now = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE)
        return if (start <= end) now in start..end else (now >= start || now <= end)
    }

    private fun parseMinutes(hhmm: String): Int? {
        val p = hhmm.split(":")
        if (p.size != 2) return null
        val h = p[0].toIntOrNull() ?: return null
        val m = p[1].toIntOrNull() ?: return null
        return h * 60 + m
    }
}
