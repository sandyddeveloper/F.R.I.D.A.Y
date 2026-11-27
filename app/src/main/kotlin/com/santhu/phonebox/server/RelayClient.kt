package com.santhu.phonebox.server

import android.util.Base64
import com.santhu.phonebox.db.PhoneDb
import com.santhu.phonebox.system.AppLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Maintains an outbound HTTP long-poll tunnel to a user-hosted PhoneBox Relay
 * so paired laptops can reach the phone anytime, anywhere behind CGNAT/NAT.
 */
class RelayClient(
    private val db: PhoneDb,
    private val localPort: Int
) {
    private var job: Job? = null
    private var activeSig: String = ""
    @Volatile var connected: Boolean = false
        private set
    @Volatile var lastError: String = ""
        private set

    fun startOrRestart(scope: CoroutineScope) {
        val enabled = db.getSetting("relay_enabled", "0") == "1"
        val rawUrl = db.getSetting("relay_url", "").trim().trimEnd('/')
        val room = db.getSetting("relay_room", "").trim()
        val secret = db.getSetting("relay_secret", "").trim()
        val sig = "$enabled|$rawUrl|$room|$secret"
        if (sig == activeSig && job?.isActive == true) return
        stop()
        activeSig = sig
        if (!enabled || rawUrl.isEmpty()) {
            connected = false
            lastError = ""
            return
        }
        if (room.isEmpty() || secret.isEmpty()) {
            connected = false
            lastError = "Missing relay room/secret"
            return
        }

        job = scope.launch(Dispatchers.IO) {
            AppLog.add("info", "relay", "Relay tunnel active -> $rawUrl/r/$room")
            while (isActive) {
                if (db.getSetting("relay_enabled", "0") != "1") break
                val ok = runCatching {
                    val qRoom = URLEncoder.encode(room, "UTF-8")
                    val qSec = URLEncoder.encode(secret, "UTF-8")
                    val conn = (URL("$rawUrl/_phone/pull?room=$qRoom&secret=$qSec").openConnection() as HttpURLConnection).apply {
                        requestMethod = "GET"
                        connectTimeout = 6000
                        readTimeout = 32000
                        setRequestProperty("Accept", "application/json")
                    }
                    val code = conn.responseCode
                    if (code == 204) {
                        connected = true
                        lastError = ""
                        conn.disconnect()
                        return@runCatching true
                    }
                    if (code !in 200..299) {
                        connected = false
                        lastError = "HTTP $code"
                        conn.disconnect()
                        return@runCatching false
                    }
                    val txt = conn.inputStream.bufferedReader().use { it.readText() }
                    conn.disconnect()
                    connected = true
                    lastError = ""
                    if (txt.isNotBlank()) {
                        val reqObj = JSONObject(txt)
                        launch { forwardAndReply(rawUrl, qRoom, qSec, reqObj) }
                    }
                    true
                }.getOrElse { err ->
                    connected = false
                    lastError = err.message ?: "Connection failed"
                    false
                }
                if (!ok) delay(2500) else delay(20)
            }
            connected = false
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        activeSig = ""
        connected = false
    }

    private fun forwardAndReply(relayBase: String, qRoom: String, qSec: String, req: JSONObject) {
        val id = req.optString("id", "")
        if (id.isEmpty()) return
        val method = req.optString("method", "GET").uppercase()
        val reqPath = req.optString("path", "/api/health").let { if (it.startsWith("/")) it else "/$it" }
        val inHeaders = req.optJSONObject("headers") ?: JSONObject()
        val bodyB64 = req.optString("bodyB64", "")

        var status = 502
        var respCt = "application/json"
        var respBytes = """{"error":"Local forward failed"}""".toByteArray(Charsets.UTF_8)

        runCatching {
            val local = (URL("http://127.0.0.1:$localPort$reqPath").openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 4000
                readTimeout = 20000
                instanceFollowRedirects = false
                setRequestProperty("X-PhoneBox-Forwarded", "1")
                listOf("content-type", "authorization", "x-phonebox-token", "x-phonebox-pin", "accept").forEach { key ->
                    val v = inHeaders.optString(key, "")
                    if (v.isNotEmpty()) setRequestProperty(key, v)
                }
            }
            if (bodyB64.isNotEmpty() && method in listOf("POST", "PUT", "PATCH", "DELETE")) {
                val rawBody = Base64.decode(bodyB64, Base64.DEFAULT)
                local.doOutput = true
                local.setRequestProperty("Content-Length", rawBody.size.toString())
                local.outputStream.use { it.write(rawBody) }
            }
            status = local.responseCode
            respCt = local.contentType ?: "application/json"
            val stream = if (status in 200..399) local.inputStream else (local.errorStream ?: local.inputStream)
            val baos = ByteArrayOutputStream()
            stream?.use { s ->
                val buf = ByteArray(8192)
                var n: Int
                while (s.read(buf).also { n = it } != -1 && baos.size() < 4 * 1024 * 1024) {
                    baos.write(buf, 0, n)
                }
            }
            respBytes = baos.toByteArray()
            local.disconnect()
        }

        runCatching {
            val qId = URLEncoder.encode(id, "UTF-8")
            val payload = JSONObject().apply {
                put("status", status)
                put("contentType", respCt)
                put("bodyB64", Base64.encodeToString(respBytes, Base64.NO_WRAP))
            }.toString().toByteArray(Charsets.UTF_8)

            val up = (URL("$relayBase/_phone/reply?room=$qRoom&secret=$qSec&id=$qId").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 5000
                readTimeout = 10000
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Content-Length", payload.size.toString())
            }
            up.outputStream.use { it.write(payload) }
            up.responseCode
            up.disconnect()
        }
    }
}
