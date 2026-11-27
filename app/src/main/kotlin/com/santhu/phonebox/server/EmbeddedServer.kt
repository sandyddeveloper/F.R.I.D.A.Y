package com.santhu.phonebox.server

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.santhu.phonebox.PhoneBoxApp
import com.santhu.phonebox.R
import com.santhu.phonebox.db.PhoneDb
import com.santhu.phonebox.system.AppLog
import com.santhu.phonebox.system.DeviceTelemetry
import com.santhu.phonebox.system.HardwareController
import com.santhu.phonebox.system.NetworkTools
import com.santhu.phonebox.system.PhoneAccessibilityService
import com.santhu.phonebox.system.PhoneNotificationService
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.PartData
import io.ktor.http.content.forEachPart
import io.ktor.server.cio.CIO
import io.ktor.server.cio.CIOApplicationEngine
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.engine.embeddedServer
import io.ktor.server.request.receiveChannel
import io.ktor.server.request.receiveMultipart
import io.ktor.server.request.receiveText
import io.ktor.server.response.header
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondBytesWriter
import io.ktor.server.response.respondFile
import io.ktor.server.response.respondRedirect
import io.ktor.server.response.respondText
import io.ktor.server.routing.RoutingCall
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import io.ktor.server.routing.routing
import io.ktor.utils.io.readAvailable
import io.ktor.utils.io.writeFully
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue

class EmbeddedServer(
    private val context: Context,
    private val db: PhoneDb,
    private val hw: HardwareController,
    private val ruleEngine: RuleEngine,
    private val port: Int,
    private val startedAt: Long,
    private val onRunMonitorsNow: suspend () -> Unit,
    private val onRefreshNewsNow: suspend () -> Unit,
    private val onSettingsApplied: () -> Unit
) {
    private var engine: EmbeddedServer<CIOApplicationEngine, CIOApplicationEngine.Configuration>? = null
    private val events = MutableSharedFlow<Pair<String, String>>(
        replay = 0,
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST
    )
    private val laptopInputQueue = ConcurrentLinkedQueue<JSONObject>()
    private val laptopInputSignal = MutableSharedFlow<Unit>(
        replay = 0,
        extraBufferCapacity = 32,
        onBufferOverflow = BufferOverflow.DROP_OLDEST
    )
    @Volatile private var laptopScreenBytes: ByteArray? = null
    @Volatile private var laptopScreenMeta = JSONObject().put("ts", 0L).put("w", 0).put("h", 0)
    @Volatile private var smtcArtBytes: ByteArray? = null
    @Volatile private var smtcArtMime: String = "image/jpeg"
    @Volatile private var smtcArtMeta = JSONObject().put("ts", 0L).put("key", "")

    private data class PendingPairRequest(
        val id: String,
        val deviceName: String,
        val platform: String,
        val remoteIp: String,
        val code: String,
        val createdAt: Long,
        val expiresAt: Long,
        @Volatile var approved: Boolean = false,
        @Volatile var status: String = "pending",
        @Volatile var attempts: Int = 0
    )

    private val pendingPairs = ConcurrentHashMap<String, PendingPairRequest>()
    private val pairRng = SecureRandom()

    private fun cleanExpiredPairs() {
        val now = System.currentTimeMillis()
        pendingPairs.entries.removeIf { it.value.expiresAt < now || it.value.status == "denied" }
    }

    private fun buildPendingPairsJson(includeSecrets: Boolean): JSONArray {
        cleanExpiredPairs()
        val arr = JSONArray()
        pendingPairs.values.sortedByDescending { it.createdAt }.forEach { req ->
            arr.put(JSONObject().apply {
                put("id", req.id)
                put("deviceName", req.deviceName)
                put("platform", req.platform)
                put("remoteIp", req.remoteIp)
                put("approved", req.approved)
                put("status", req.status)
                put("createdAt", req.createdAt)
                put("expiresAt", req.expiresAt)
                if (includeSecrets && req.approved) {
                    put("code", req.code)
                }
            })
        }
        return arr
    }

    fun notifyChange(event: String = "state", payload: String = "{}") {
        events.tryEmit(event to payload)
    }

    fun start(scope: CoroutineScope) {
        if (engine != null) return
        engine = embeddedServer(CIO, port = port, host = "0.0.0.0") {
            routing {
                get("/") {
                    call.respondRedirect(if (isLocalClient(call)) "/panel/" else "/admin/")
                }

                get("/panel") {
                    if (!isLocalClient(call)) {
                        call.respondText("Mobile UI is available on the phone screen only. Use /admin/ for setup.", ContentType.Text.Plain, HttpStatusCode.Forbidden)
                        return@get
                    }
                    call.respondRedirect("/panel/")
                }
                get("/admin") { call.respondRedirect("/admin/") }

                get("/panel/") {
                    if (!isLocalClient(call)) {
                        call.respondText("Mobile UI is available on the phone screen only. Use /admin/ for setup.", ContentType.Text.Plain, HttpStatusCode.Forbidden)
                        return@get
                    }
                    serveAsset(call, "www/panel/index.html")
                }
                get("/panel/{file...}") {
                    if (!isLocalClient(call)) {
                        call.respondText("Mobile UI is available on the phone screen only. Use /admin/ for setup.", ContentType.Text.Plain, HttpStatusCode.Forbidden)
                        return@get
                    }
                    val path = call.parameters.getAll("file")?.joinToString("/") ?: "index.html"
                    serveAsset(call, "www/panel/$path")
                }

                get("/admin/") { serveAsset(call, "www/admin/index.html") }
                get("/admin/{file...}") {
                    val path = call.parameters.getAll("file")?.joinToString("/") ?: "index.html"
                    serveAsset(call, "www/admin/$path")
                }

                get("/shared/{file...}") {
                    val path = call.parameters.getAll("file")?.joinToString("/") ?: ""
                    serveAsset(call, "www/shared/$path")
                }

                get("/api/catalog") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, JSONObject().put("widgets", buildWidgetCatalog()))
                }

                get("/api/health") {
                    val authed = isLocalClient(call) || hasValidAuth(call)
                    val t = DeviceTelemetry.collect(context, port, startedAt)
                    val out = JSONObject().apply {
                        put("ok", true)
                        put("app", "F.R.I.D.A.Y.")
                        put("service", "friday-server")
                        put("version", "2.0.0")
                        put("deviceName", t.optString("deviceName", "F.R.I.D.A.Y."))
                        put("port", port)
                        put("requiresPairing", db.getSetting("require_pairing", "1") == "1")
                        put("pairedCount", db.getPairedCount())
                        if (authed) {
                            put("telemetry", t)
                            put("db", db.getDbSummary())
                        }
                    }
                    respondJson(call, out)
                }

                post("/api/auth/check") {
                    val body = runCatching { JSONObject(call.receiveText()) }.getOrNull() ?: JSONObject()
                    val pin = body.optString("pin", "")
                    val tok = body.optString("token", "")
                    val ip = call.request.local.remoteAddress
                    val pinEnabled = db.getSetting("pin_enabled", "0") == "1"
                    val pairReq = db.getSetting("require_pairing", "1") == "1"
                    val expected = db.getSetting("pin", "1234")
                    val validTok = tok.isNotBlank() && db.verifyPairedToken(tok, ip)
                    val validPin = pin.isNotBlank() && pin == expected
                    val valid = isLocalClient(call) || validTok || (pinEnabled && validPin) || (!pairReq && !pinEnabled)
                    respondJson(call, JSONObject()
                        .put("ok", valid)
                        .put("pinRequired", pinEnabled)
                        .put("pairRequired", pairReq))
                }

                // --- 6-Digit Mutual Pairing Permission Gate ---
                post("/api/pair/request") {
                    cleanExpiredPairs()
                    if (pendingPairs.size >= 10) {
                        call.respondText("""{"error":"Too many pending pairing requests"}""", ContentType.Application.Json, HttpStatusCode.TooManyRequests)
                        return@post
                    }
                    val obj = runCatching { JSONObject(call.receiveText()) }.getOrNull() ?: JSONObject()
                    val deviceName = obj.optString("deviceName", "Laptop").trim().take(80).ifBlank { "Laptop" }
                    val platform = obj.optString("platform", "windows").trim().take(32).ifBlank { "windows" }
                    val ip = call.request.local.remoteAddress
                    val now = System.currentTimeMillis()
                    val id = UUID.randomUUID().toString().replace("-", "").take(16)
                    val code = String.format("%06d", pairRng.nextInt(900_000) + 100_000)
                    val req = PendingPairRequest(
                        id = id,
                        deviceName = deviceName,
                        platform = platform,
                        remoteIp = ip,
                        code = code,
                        createdAt = now,
                        expiresAt = now + 300_000L
                    )
                    pendingPairs[id] = req
                    vibratePhone(180L)
                    postUrgentAndroidNotification(
                        "Pairing Request: $deviceName",
                        "Open F.R.I.D.A.Y. to confirm permission with a 6-digit code"
                    )
                    notifyChange("pair_request", JSONObject().put("id", id).put("deviceName", deviceName).put("platform", platform).toString())
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("requestId", id).put("expiresAt", req.expiresAt))
                }

                get("/api/pair/status/{id}") {
                    val id = call.parameters["id"] ?: ""
                    val req = pendingPairs[id]
                    if (req == null) {
                        respondJson(call, JSONObject().put("ok", false).put("status", "missing"))
                        return@get
                    }
                    if (System.currentTimeMillis() > req.expiresAt) {
                        pendingPairs.remove(id)
                        respondJson(call, JSONObject().put("ok", false).put("status", "expired"))
                        return@get
                    }
                    respondJson(call, JSONObject()
                        .put("ok", true)
                        .put("id", req.id)
                        .put("status", req.status)
                        .put("approved", req.approved)
                        .put("expiresAt", req.expiresAt))
                }

                post("/api/pair/approve/{id}") {
                    if (!isLocalClient(call)) {
                        call.respondText("""{"error":"Must approve on phone screen"}""", ContentType.Application.Json, HttpStatusCode.Forbidden)
                        return@post
                    }
                    val id = call.parameters["id"] ?: ""
                    val req = pendingPairs[id]
                    if (req == null || System.currentTimeMillis() > req.expiresAt) {
                        pendingPairs.remove(id)
                        call.respondText("""{"error":"Request expired"}""", ContentType.Application.Json, HttpStatusCode.NotFound)
                        return@post
                    }
                    req.approved = true
                    req.status = "approved"
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("id", req.id).put("code", req.code).put("expiresAt", req.expiresAt))
                }

                post("/api/pair/deny/{id}") {
                    if (!isLocalClient(call)) {
                        call.respondText("""{"error":"Must deny on phone screen"}""", ContentType.Application.Json, HttpStatusCode.Forbidden)
                        return@post
                    }
                    val id = call.parameters["id"] ?: ""
                    pendingPairs.remove(id)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                post("/api/pair/confirm") {
                    val obj = runCatching { JSONObject(call.receiveText()) }.getOrNull() ?: JSONObject()
                    val id = obj.optString("requestId", "")
                    val code = obj.optString("code", "").replace(Regex("[^0-9]"), "")
                    val req = pendingPairs[id]
                    if (req == null || System.currentTimeMillis() > req.expiresAt) {
                        pendingPairs.remove(id)
                        call.respondText("""{"error":"Pairing request expired or not found"}""", ContentType.Application.Json, HttpStatusCode.NotFound)
                        return@post
                    }
                    if (!req.approved) {
                        call.respondText("""{"error":"Waiting for approval on phone screen"}""", ContentType.Application.Json, HttpStatusCode.Forbidden)
                        return@post
                    }
                    req.attempts++
                    if (req.attempts > 5) {
                        pendingPairs.remove(id)
                        notifyChange("state")
                        call.respondText("""{"error":"Too many incorrect attempts"}""", ContentType.Application.Json, HttpStatusCode.TooManyRequests)
                        return@post
                    }
                    val ok = MessageDigest.isEqual(req.code.toByteArray(Charsets.UTF_8), code.toByteArray(Charsets.UTF_8))
                    if (!ok) {
                        call.respondText("""{"error":"Invalid 6-digit code","attemptsLeft":${5 - req.attempts}}""", ContentType.Application.Json, HttpStatusCode.Unauthorized)
                        return@post
                    }
                    val ip = call.request.local.remoteAddress
                    val created = db.addPairedDevice(req.deviceName, req.platform, ip)
                    pendingPairs.remove(id)
                    val phoneName = DeviceTelemetry.collect(context, port, startedAt).optString("deviceName", "F.R.I.D.A.Y.")
                    notifyChange("toast", JSONObject().put("title", "Device Paired").put("body", "${req.deviceName} confirmed & connected").put("level", "ok").toString())
                    notifyChange("state")
                    respondJson(call, JSONObject()
                        .put("ok", true)
                        .put("token", created.getString("token"))
                        .put("deviceId", created.getString("id"))
                        .put("deviceName", req.deviceName)
                        .put("phoneName", phoneName))
                }

                get("/api/pair/devices") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, JSONObject().put("devices", db.getPairedDevices()))
                }

                delete("/api/pair/devices/{id}") {
                    if (!checkAuth(call)) return@delete
                    val id = call.parameters["id"] ?: ""
                    val ok = db.revokePairedDevice(id)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", ok).put("devices", db.getPairedDevices()))
                }

                get("/api/qr.svg") {
                    val text = call.request.queryParameters["text"] ?: DeviceTelemetry.collect(context, port, startedAt).optString("adminUrl")
                    call.respondText(buildQrSvg(text), ContentType.Image.SVG)
                }

                get("/api/state") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, buildFullState(isLocalClient(call)))
                }

                get("/api/stream") {
                    if (!checkAuth(call)) return@get
                    val localStream = isLocalClient(call)
                    call.response.header(HttpHeaders.CacheControl, "no-cache")
                    call.response.header("X-Accel-Buffering", "no")
                    call.respondBytesWriter(contentType = ContentType.Text.EventStream) {
                        suspend fun writeEvent(name: String, data: String) {
                            val frame = "event: $name\ndata: $data\n\n"
                            writeFully(frame.toByteArray(Charsets.UTF_8))
                            flush()
                        }
                        try {
                            writeEvent("state", buildFullState(localStream).toString())
                            val collector = scope.launch {
                                events.collect { (ev, payload) ->
                                    runCatching {
                                        val data = if (ev == "state") buildFullState(localStream).toString() else payload
                                        writeEvent(ev, data)
                                    }
                                }
                            }
                            while (coroutineContext.isActive) {
                                delay(3000)
                                writeEvent("state", buildFullState(localStream).toString())
                            }
                            collector.cancel()
                        } catch (_: CancellationException) {
                        } catch (_: Throwable) {
                        }
                    }
                }

                get("/api/pages") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, JSONObject().put("pages", db.getPages()))
                }

                put("/api/pages") {
                    if (!checkAuth(call)) return@put
                    val obj = JSONObject(call.receiveText())
                    val pages = obj.optJSONArray("pages") ?: JSONArray()
                    db.replacePages(pages)
                    AppLog.add("info", "pages", "Saved ${pages.length()} layout pages")
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("pages", db.getPages()))
                }

                post("/api/goto/{page}") {
                    if (!checkAuth(call)) return@post
                    val target = call.parameters["page"] ?: "home"
                    notifyChange("goto", JSONObject().put("page", target).toString())
                    respondJson(call, JSONObject().put("ok", true).put("page", target))
                }

                get("/api/push") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, db.getPushedMap())
                }

                post("/api/push/{key}") {
                    if (!checkAuth(call)) return@post
                    val key = call.parameters["key"]?.take(64)?.ifBlank { "default" } ?: "default"
                    val ttl = call.request.queryParameters["ttl"]?.toLongOrNull() ?: 0L
                    val raw = call.receiveText().trim()
                    val obj = try {
                        if (raw.startsWith("{")) JSONObject(raw) else JSONObject().put("value", raw.toDoubleOrNull() ?: raw)
                    } catch (_: Throwable) {
                        JSONObject().put("value", raw)
                    }
                    val finalTtl = obj.optLong("ttl", ttl)
                    db.putPush(key, obj, finalTtl)
                    AppLog.add("info", "webhook", "Push '$key' = ${obj.opt("value")}")
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("key", key))
                }

                delete("/api/push/{key}") {
                    if (!checkAuth(call)) return@delete
                    db.deletePush(call.parameters["key"] ?: "")
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                post("/api/notify") {
                    if (!checkAuth(call)) return@post
                    val raw = call.receiveText().trim()
                    val obj = try {
                        if (raw.startsWith("{")) JSONObject(raw) else JSONObject().put("title", "Webhook").put("body", raw)
                    } catch (_: Throwable) {
                        JSONObject().put("title", "Webhook").put("body", raw)
                    }
                    val title = obj.optString("title", "Notification").ifBlank { "Notification" }
                    val body = obj.optString("body", obj.optString("text", ""))
                    val level = obj.optString("level", "info")
                    val page = obj.optString("page", "")
                    val vibrate = obj.optBoolean("vibrate", true)
                    val highPriority = obj.optBoolean("highPriority", false)
                    db.addNotification(title, body, level, "webhook")
                    AppLog.add(level, "notify", "$title: $body")
                    if (vibrate) vibratePhone(if (highPriority) 450L else 120L)
                    if (highPriority) postUrgentAndroidNotification(title, body)
                    notifyChange("toast", JSONObject().put("title", title).put("body", body).put("level", level).toString())
                    if (page.isNotBlank()) notifyChange("goto", JSONObject().put("page", page).toString())
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                delete("/api/notifications") {
                    if (!checkAuth(call)) return@delete
                    db.clearNotifications()
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                get("/api/metrics/{key}") {
                    if (!checkAuth(call)) return@get
                    val key = call.parameters["key"] ?: "batteryPct"
                    val limit = call.request.queryParameters["limit"]?.toIntOrNull()?.coerceIn(10, 500) ?: 60
                    respondJson(call, JSONObject().put("key", key).put("points", db.getMetricsHistory(key, limit)))
                }

                get("/api/notes") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, JSONObject().put("notes", db.getNotes()))
                }

                post("/api/notes") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val id = if (obj.has("id") && !obj.isNull("id")) obj.optLong("id") else null
                    val savedId = db.upsertNote(id, obj.optString("title", ""), obj.optString("body", ""), obj.optBoolean("pinned", false))
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("id", savedId).put("notes", db.getNotes()))
                }

                delete("/api/notes/{id}") {
                    if (!checkAuth(call)) return@delete
                    db.deleteNote(call.parameters["id"]?.toLongOrNull() ?: 0L)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                get("/api/checklists") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, JSONObject().put("checklists", db.getChecklists()))
                }

                post("/api/checklists") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val text = obj.optString("text", "").trim()
                    if (text.isEmpty()) {
                        call.respondText("""{"error":"text required"}""", ContentType.Application.Json, HttpStatusCode.BadRequest)
                        return@post
                    }
                    val id = db.addChecklist(text)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("id", id).put("checklists", db.getChecklists()))
                }

                patch("/api/checklists/{id}") {
                    if (!checkAuth(call)) return@patch
                    val id = call.parameters["id"]?.toLongOrNull() ?: 0L
                    val obj = JSONObject(call.receiveText())
                    db.toggleChecklist(id, obj.optBoolean("done", false))
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("checklists", db.getChecklists()))
                }

                delete("/api/checklists/{id}") {
                    if (!checkAuth(call)) return@delete
                    db.deleteChecklist(call.parameters["id"]?.toLongOrNull() ?: 0L)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                get("/api/monitors") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, JSONObject().put("monitors", db.getMonitors()))
                }

                post("/api/monitors") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val name = obj.optString("name", "").trim()
                    val host = obj.optString("host", "").trim()
                    val portNum = obj.optInt("port", 0)
                    if (host.isEmpty()) {
                        call.respondText("""{"error":"host required"}""", ContentType.Application.Json, HttpStatusCode.BadRequest)
                        return@post
                    }
                    val id = db.addMonitor(name.ifBlank { host }, host, portNum)
                    scope.launch(Dispatchers.IO) { onRunMonitorsNow() }
                    respondJson(call, JSONObject().put("ok", true).put("id", id).put("monitors", db.getMonitors()))
                }

                post("/api/monitors/run") {
                    if (!checkAuth(call)) return@post
                    withContext(Dispatchers.IO) { onRunMonitorsNow() }
                    respondJson(call, JSONObject().put("ok", true).put("monitors", db.getMonitors()))
                }

                delete("/api/monitors/{id}") {
                    if (!checkAuth(call)) return@delete
                    db.deleteMonitor(call.parameters["id"]?.toLongOrNull() ?: 0L)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                get("/api/files") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, JSONObject().put("files", db.getFiles()))
                }

                post("/api/files") {
                    if (!checkAuth(call)) return@post
                    val contentType = call.request.headers[HttpHeaders.ContentType] ?: ""
                    val dropDir = PhoneBoxApp.instance.dropDir
                    var savedName = ""
                    var savedMime = "application/octet-stream"
                    var savedSize = 0L
                    var storedKey = ""

                    if (contentType.startsWith("multipart/form-data", ignoreCase = true)) {
                        val multipart = call.receiveMultipart()
                        multipart.forEachPart { part ->
                            if (part is PartData.FileItem) {
                                val orig = sanitizeFilename(part.originalFileName ?: "upload.bin")
                                val stored = "${UUID.randomUUID()}_$orig"
                                val outFile = File(dropDir, stored)
                                val ch = part.provider()
                                val buf = ByteArray(8192)
                                outFile.outputStream().use { out ->
                                    while (!ch.isClosedForRead) {
                                        val n = ch.readAvailable(buf)
                                        if (n > 0) { out.write(buf, 0, n); savedSize += n } else if (n < 0) break
                                    }
                                }
                                savedName = orig
                                savedMime = part.contentType?.toString() ?: "application/octet-stream"
                                storedKey = stored
                            }
                            part.dispose()
                        }
                    } else {
                        val qName = call.request.queryParameters["name"] ?: call.request.headers["X-Filename"] ?: "upload.bin"
                        val orig = sanitizeFilename(URLDecoder.decode(qName, "UTF-8"))
                        val stored = "${UUID.randomUUID()}_$orig"
                        val outFile = File(dropDir, stored)
                        val ch = call.receiveChannel()
                        val buf = ByteArray(8192)
                        outFile.outputStream().use { out ->
                            while (!ch.isClosedForRead) {
                                val n = ch.readAvailable(buf)
                                if (n > 0) { out.write(buf, 0, n); savedSize += n } else if (n < 0) break
                            }
                        }
                        savedName = orig
                        savedMime = contentType.ifBlank { "application/octet-stream" }
                        storedKey = stored
                    }

                    if (storedKey.isBlank()) {
                        call.respondText("""{"error":"no file uploaded"}""", ContentType.Application.Json, HttpStatusCode.BadRequest)
                        return@post
                    }
                    val id = db.insertFile(savedName, savedMime, savedSize, storedKey)
                    AppLog.add("info", "files", "Stored $savedName ($savedSize bytes)")
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("id", id).put("files", db.getFiles()))
                }

                get("/api/files/{id}") {
                    if (!checkAuth(call)) return@get
                    val id = call.parameters["id"]?.toLongOrNull() ?: 0L
                    val found = db.findFile(id) ?: return@get call.respondText("Not found", ContentType.Text.Plain, HttpStatusCode.NotFound)
                    val file = File(PhoneBoxApp.instance.dropDir, found.second)
                    if (!file.exists()) return@get call.respondText("Missing", ContentType.Text.Plain, HttpStatusCode.NotFound)
                    call.response.header(HttpHeaders.ContentDisposition, "attachment; filename=\"${found.first}\"")
                    call.respondFile(file)
                }

                delete("/api/files/{id}") {
                    if (!checkAuth(call)) return@delete
                    val stored = db.deleteFile(call.parameters["id"]?.toLongOrNull() ?: 0L)
                    if (stored != null) File(PhoneBoxApp.instance.dropDir, stored).delete()
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                get("/api/wol") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, JSONObject().put("targets", db.getWolTargets()))
                }

                post("/api/wol") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val id = db.addWolTarget(obj.optString("name", "PC"), obj.optString("mac", "").trim(), obj.optString("broadcast", "255.255.255.255"))
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("id", id).put("targets", db.getWolTargets()))
                }

                post("/api/wol/send") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val res = withContext(Dispatchers.IO) { NetworkTools.sendWakeOnLan(obj.optString("mac", ""), obj.optString("broadcast", "255.255.255.255")) }
                    if (res.isSuccess) {
                        val msg = res.getOrNull() ?: "Sent"
                        AppLog.add("ok", "wol", msg)
                        respondJson(call, JSONObject().put("ok", true).put("message", msg))
                    } else {
                        call.respondText(JSONObject().put("ok", false).put("error", res.exceptionOrNull()?.message ?: "Failed").toString(), ContentType.Application.Json, HttpStatusCode.BadRequest)
                    }
                }

                delete("/api/wol/{id}") {
                    if (!checkAuth(call)) return@delete
                    db.deleteWolTarget(call.parameters["id"]?.toLongOrNull() ?: 0L)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                // --- Apps & App Dock ---
                get("/api/apps") {
                    if (!checkAuth(call)) return@get
                    val apps = withContext(Dispatchers.IO) { hw.listInstalledApps() }
                    respondJson(call, JSONObject().put("apps", apps).put("dock", db.getAppDock()))
                }

                get("/api/apps/icon") {
                    val pkg = call.request.queryParameters["pkg"] ?: return@get call.respondText("", status = HttpStatusCode.BadRequest)
                    val bytes = withContext(Dispatchers.IO) { hw.getAppIconPng(pkg) }
                        ?: return@get call.respondText("", status = HttpStatusCode.NotFound)
                    call.respondBytes(bytes, ContentType.Image.PNG)
                }

                post("/api/apps/launch") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val pkg = obj.optString("pkg", "")
                    val ok = hw.launchApp(pkg)
                    AppLog.add(if (ok) "ok" else "error", "apps", "Launch $pkg -> $ok")
                    respondJson(call, JSONObject().put("ok", ok))
                }

                post("/api/apps/uri") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val ok = hw.openUri(obj.optString("uri", ""))
                    respondJson(call, JSONObject().put("ok", ok))
                }

                post("/api/app-dock") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    db.pinApp(obj.optString("pkg", ""), obj.optString("label", "App"))
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("dock", db.getAppDock()))
                }

                delete("/api/app-dock/{pkg}") {
                    if (!checkAuth(call)) return@delete
                    db.unpinApp(call.parameters["pkg"] ?: "")
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("dock", db.getAppDock()))
                }

                // --- Hardware, Media & Volume ---
                post("/api/hw/torch") {
                    if (!checkAuth(call)) return@post
                    val raw = call.receiveText().trim()
                    val on = if (raw.startsWith("{")) {
                        val o = JSONObject(raw)
                        if (o.has("on")) hw.setTorch(o.getBoolean("on")) else hw.toggleTorch()
                    } else hw.toggleTorch()
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("torchOn", hw.torchOn))
                }

                post("/api/hw/volume") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    hw.setMediaVolumePercent(obj.optInt("percent", 50))
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("audio", hw.getAudioState()))
                }

                post("/api/hw/mute") {
                    if (!checkAuth(call)) return@post
                    hw.toggleMuteMedia()
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("audio", hw.getAudioState()))
                }

                post("/api/hw/media") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    hw.sendMediaKey(obj.optString("action", "play_pause"))
                    delay(180)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("media", PhoneNotificationService.getActiveMedia(context)))
                }

                post("/api/hw/beep") {
                    if (!checkAuth(call)) return@post
                    hw.beepFindPhone()
                    vibratePhone(250)
                    respondJson(call, JSONObject().put("ok", true))
                }

                post("/api/hw/tts") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val ok = hw.speak(obj.optString("text", ""))
                    respondJson(call, JSONObject().put("ok", ok))
                }

                post("/api/hw/open-settings") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val ok = hw.openAndroidSettings(obj.optString("kind", "accessibility"))
                    respondJson(call, JSONObject().put("ok", ok))
                }

                post("/api/hw/ensure-ssh") {
                    if (!checkAuth(call)) return@post
                    ServerService.ensureTermuxSshAsync(context, force = true)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                // --- Antigravity Telemetry & Phone Approval Bridge ---
                get("/api/agy") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, JSONObject().apply {
                        put("state", db.getAgyState())
                        put("permissions", db.getAgyPermissions(25))
                        put("gateEnabled", db.getSetting("agy_gate_enabled", "0") == "1")
                    })
                }

                post("/api/agy/status") {
                    if (!checkAuth(call)) return@post
                    val incoming = JSONObject(call.receiveText())
                    val prev = db.getAgyState()
                    val merged = JSONObject(prev.toString())
                    val keys = incoming.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        val v = incoming.get(k)
                        if (v != JSONObject.NULL) merged.put(k, v)
                    }
                    db.saveAgyState(merged)
                    notifyChange("state")
                    respondJson(call, JSONObject().apply {
                        put("ok", true)
                        put("state", db.getAgyState())
                        put("paused", db.getSetting("agy_paused", "0") == "1")
                        put("gateEnabled", db.getSetting("agy_gate_enabled", "0") == "1")
                        put("gateScope", db.getSetting("agy_gate_scope", "all"))
                        put("autoWsEdits", db.getSetting("agy_auto_ws_edits", "0") == "1")
                    })
                }

                post("/api/agy/gate") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val enabled = obj.optBoolean("enabled", db.getSetting("agy_gate_enabled", "0") != "1")
                    db.putSettings(JSONObject().put("agy_gate_enabled", if (enabled) "1" else "0"))
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("gateEnabled", enabled))
                }

                post("/api/agy/permission") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    if (db.getSetting("agy_gate_enabled", "0") != "1") {
                        respondJson(call, JSONObject().put("ok", true).put("gateEnabled", false).put("decision", "allow"))
                        return@post
                    }
                    val toolName = obj.optString("toolName", "tool")
                    val target = obj.optString("target", "").take(220)
                    val detail = obj.optString("detail", "").take(2400)
                    val modelName = obj.optString("modelName", "")
                    val convId = obj.optString("conversationId", "")
                    val kind = obj.optString("kind", "approval").take(32)
                    val payloadJson = (obj.optJSONObject("payload")?.toString() ?: "{}").take(16384)
                    val reqKey = obj.optString("reqKey", "${System.currentTimeMillis()}-$toolName")
                    val row = db.enqueueAgyPermission(reqKey, toolName, target, detail, modelName, convId, kind, payloadJson)
                    if (db.getSetting("agy_alert_buzz", "1") == "1") {
                        vibratePhone(150)
                        hw.beepFindPhone()
                    }
                    notifyChange("agy_perm", row.toString())
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("gateEnabled", true).put("permission", row))
                }

                get("/api/agy/permission/{id}/wait") {
                    if (!checkAuth(call)) return@get
                    val id = call.parameters["id"]?.toLongOrNull() ?: return@get call.respondText("""{"ok":false,"decision":"ask"}""", ContentType.Application.Json, HttpStatusCode.BadRequest)
                    val timeoutMs = (call.request.queryParameters["timeout"]?.toLongOrNull() ?: 50_000L).coerceIn(1000L, 58_000L)
                    val keepPending = call.request.queryParameters["keepPending"] == "1"
                    val deadline = System.currentTimeMillis() + timeoutMs
                    var row = db.getAgyPermission(id)
                    while (row != null && row.optString("status") == "pending" && System.currentTimeMillis() < deadline) {
                        delay(200)
                        row = db.getAgyPermission(id)
                    }
                    val status = row?.optString("status") ?: "ask"
                    if (status == "pending") {
                        if (!keepPending) {
                            db.resolveAgyPermission(id, "ask")
                            notifyChange("state")
                        }
                        respondJson(call, JSONObject().put("ok", true).put("id", id).put("decision", if (keepPending) "pending" else "ask").put("timedOut", true))
                    } else {
                        val respObj = row?.optJSONObject("response") ?: JSONObject()
                        respondJson(call, JSONObject().put("ok", true).put("id", id).put("decision", status).put("response", respObj).put("timedOut", false))
                    }
                }

                post("/api/agy/permission/{id}/decide") {
                    if (!checkAuth(call)) return@post
                    val id = call.parameters["id"]?.toLongOrNull() ?: 0L
                    val obj = JSONObject(call.receiveText())
                    val decision = obj.optString("decision", "auto_approve")
                    val responseObj = obj.optJSONObject("response") ?: JSONObject()
                    val ok = db.resolveAgyPermission(id, decision, responseObj.toString().take(16384))
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", ok).put("decision", decision).put("response", responseObj))
                }

                delete("/api/agy/permissions") {
                    if (!checkAuth(call)) return@delete
                    db.clearResolvedAgyPermissions()
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                // --- Antigravity Live Code Diff & Remote Control ---
                get("/api/agy/code") {
                    if (!checkAuth(call)) return@get
                    val obj = db.getAgyCode()
                    val reqAt = db.getSetting("agy_code_sync_req", "0").toLongOrNull() ?: 0L
                    obj.put("syncRequestedAt", reqAt)
                    respondJson(call, obj)
                }

                post("/api/agy/code") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    db.saveAgyCode(obj)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                post("/api/agy/code/request-sync") {
                    if (!checkAuth(call)) return@post
                    val now = System.currentTimeMillis()
                    db.putSettings(JSONObject().put("agy_code_sync_req", now.toString()))
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("requestedAt", now))
                }

                get("/api/agy/commands") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, JSONObject().apply {
                        put("commands", db.getAgyCommands(20))
                        put("paused", db.getSetting("agy_paused", "0") == "1")
                        put("gateEnabled", db.getSetting("agy_gate_enabled", "0") == "1")
                        put("gateScope", db.getSetting("agy_gate_scope", "all"))
                        put("autoWsEdits", db.getSetting("agy_auto_ws_edits", "0") == "1")
                    })
                }

                post("/api/agy/commands") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val cmdText = obj.optString("command", "").trim()
                    val kind = obj.optString("kind", "prompt").ifBlank { "prompt" }
                    if (kind == "pause") db.putSettings(JSONObject().put("agy_paused", "1"))
                    if (kind == "resume") db.putSettings(JSONObject().put("agy_paused", "0"))
                    val row = if (cmdText.isNotEmpty() || kind in listOf("stop", "pause", "continue")) {
                        db.enqueueAgyCommand(cmdText.ifBlank { kind }, kind)
                    } else null
                    notifyChange("state")
                    respondJson(call, JSONObject().apply {
                        put("ok", true)
                        if (row != null) put("command", row)
                        put("commands", db.getAgyCommands(20))
                        put("paused", db.getSetting("agy_paused", "0") == "1")
                    })
                }

                post("/api/agy/commands/claim") {
                    if (!checkAuth(call)) return@post
                    val claimed = db.claimPendingAgyCommands()
                    if (claimed.length() > 0) notifyChange("state")
                    respondJson(call, JSONObject().apply {
                        put("ok", true)
                        put("commands", claimed)
                        put("paused", db.getSetting("agy_paused", "0") == "1")
                        put("gateEnabled", db.getSetting("agy_gate_enabled", "0") == "1")
                        put("gateScope", db.getSetting("agy_gate_scope", "all"))
                        put("autoWsEdits", db.getSetting("agy_auto_ws_edits", "0") == "1")
                    })
                }

                delete("/api/agy/commands") {
                    if (!checkAuth(call)) return@delete
                    db.clearAgyCommands()
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                post("/api/agy/control") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val updates = JSONObject()
                    if (obj.has("paused")) updates.put("agy_paused", if (obj.optBoolean("paused")) "1" else "0")
                    if (obj.has("gateEnabled")) updates.put("agy_gate_enabled", if (obj.optBoolean("gateEnabled")) "1" else "0")
                    if (obj.has("gateScope")) updates.put("agy_gate_scope", obj.optString("gateScope", "all"))
                    if (obj.has("autoWsEdits")) updates.put("agy_auto_ws_edits", if (obj.optBoolean("autoWsEdits")) "1" else "0")
                    if (obj.has("alertBuzz")) updates.put("agy_alert_buzz", if (obj.optBoolean("alertBuzz")) "1" else "0")
                    if (updates.length() > 0) db.putSettings(updates)
                    notifyChange("state")
                    respondJson(call, JSONObject().apply {
                        put("ok", true)
                        put("paused", db.getSetting("agy_paused", "0") == "1")
                        put("gateEnabled", db.getSetting("agy_gate_enabled", "0") == "1")
                        put("gateScope", db.getSetting("agy_gate_scope", "all"))
                        put("autoWsEdits", db.getSetting("agy_auto_ws_edits", "0") == "1")
                        put("alertBuzz", db.getSetting("agy_alert_buzz", "1") == "1")
                    })
                }

                // --- Real-Time Laptop Hardware Telemetry ---
                get("/api/laptop/telemetry") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, db.getLaptopTelemetry())
                }

                post("/api/laptop/telemetry") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    db.saveLaptopTelemetry(obj)
                    val cpu = obj.optDouble("cpuPct", -1.0)
                    val gpu = obj.optDouble("gpuPct", -1.0)
                    val rx = obj.optDouble("netRxKbps", -1.0)
                    val tx = obj.optDouble("netTxKbps", -1.0)
                    if (cpu >= 0) db.recordMetric("lap_cpuPct", cpu)
                    if (gpu >= 0) db.recordMetric("lap_gpuPct", gpu)
                    if (rx >= 0) db.recordMetric("lap_netRxKbps", rx)
                    if (tx >= 0) db.recordMetric("lap_netTxKbps", tx)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                post("/api/laptop/process/kill") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val name = obj.optString("name", "").trim()
                    val pids = obj.optJSONArray("pids") ?: JSONArray()
                    if (name.isEmpty() || pids.length() == 0) {
                        call.respondText("""{"error":"Missing app or PIDs"}""", ContentType.Application.Json, HttpStatusCode.BadRequest)
                        return@post
                    }
                    val cmd = db.enqueueLaptopCommand("kill", obj)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("command", cmd))
                }

                post("/api/laptop/commands/claim") {
                    if (!checkAuth(call)) return@post
                    respondJson(call, JSONObject().put("ok", true).put("commands", db.claimPendingLaptopCommands()))
                }

                // --- Installed Windows Apps & Stream Deck Profiles ---
                get("/api/laptop/apps") {
                    if (!checkAuth(call)) return@get
                    val f = File(context.filesDir, "laptop_apps.json")
                    val arr = if (f.exists()) runCatching { JSONArray(f.readText()) }.getOrElse { JSONArray() } else JSONArray()
                    respondJson(call, JSONObject().put("apps", arr))
                }

                post("/api/laptop/apps") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val arr = obj.optJSONArray("apps") ?: JSONArray()
                    File(context.filesDir, "laptop_apps.json").writeText(arr.toString())
                    respondJson(call, JSONObject().put("ok", true).put("count", arr.length()))
                }

                get("/api/laptop/deck") {
                    if (!checkAuth(call)) return@get
                    val raw = db.getSetting("laptop_deck", "")
                    val obj = runCatching { JSONObject(raw) }.getOrNull() ?: JSONObject()
                    respondJson(call, obj)
                }

                put("/api/laptop/deck") {
                    if (!checkAuth(call)) return@put
                    val raw = call.receiveText()
                    val obj = JSONObject(raw)
                    db.putSettings(JSONObject().put("laptop_deck", obj.toString()))
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                // --- Long-Job Process Watchlist ("Notify Me When Done") ---
                get("/api/laptop/watch") {
                    if (!checkAuth(call)) return@get
                    val arr = runCatching { JSONArray(db.getSetting("laptop_watches", "[]")) }.getOrElse { JSONArray() }
                    respondJson(call, JSONObject().put("watches", arr))
                }

                post("/api/laptop/watch") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val name = obj.optString("name", "").trim()
                    val mode = obj.optString("mode", "exit").ifBlank { "exit" }
                    if (name.isEmpty()) {
                        call.respondText("""{"error":"Missing process name"}""", ContentType.Application.Json, HttpStatusCode.BadRequest)
                        return@post
                    }
                    val existing = runCatching { JSONArray(db.getSetting("laptop_watches", "[]")) }.getOrElse { JSONArray() }
                    val id = "w_${System.currentTimeMillis()}_${(100..999).random()}"
                    val entry = JSONObject().apply {
                        put("id", id)
                        put("name", name)
                        put("processName", obj.optString("processName", name))
                        put("pids", obj.optJSONArray("pids") ?: JSONArray())
                        put("mode", if (mode == "idle") "idle" else "exit")
                        put("startedAt", System.currentTimeMillis())
                    }
                    existing.put(entry)
                    db.putSettings(JSONObject().put("laptop_watches", existing.toString()))
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("watch", entry).put("watches", existing))
                }

                delete("/api/laptop/watch/{id}") {
                    if (!checkAuth(call)) return@delete
                    val id = call.parameters["id"] ?: ""
                    val cur = runCatching { JSONArray(db.getSetting("laptop_watches", "[]")) }.getOrElse { JSONArray() }
                    val next = JSONArray()
                    for (i in 0 until cur.length()) {
                        val item = cur.optJSONObject(i) ?: continue
                        if (item.optString("id") != id) next.put(item)
                    }
                    db.putSettings(JSONObject().put("laptop_watches", next.toString()))
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("watches", next))
                }

                // --- Wireless Trackpad, Keyboard & Live Screen Peek ---
                post("/api/laptop/input") {
                    if (!checkAuth(call)) return@post
                    val raw = call.receiveText()
                    val obj = runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
                    val batch = obj.optJSONArray("batch")
                    if (batch != null) {
                        for (i in 0 until batch.length()) {
                            batch.optJSONObject(i)?.let { item ->
                                while (laptopInputQueue.size > 128) laptopInputQueue.poll()
                                laptopInputQueue.offer(item)
                            }
                        }
                    } else if (obj.has("op")) {
                        while (laptopInputQueue.size > 128) laptopInputQueue.poll()
                        laptopInputQueue.offer(obj)
                    }
                    laptopInputSignal.tryEmit(Unit)
                    respondJson(call, JSONObject().put("ok", true))
                }

                get("/api/laptop/input/wait") {
                    if (!checkAuth(call)) return@get
                    val timeoutMs = (call.request.queryParameters["timeout"]?.toLongOrNull() ?: 8000L).coerceIn(500L, 15000L)
                    if (laptopInputQueue.isEmpty()) {
                        withTimeoutOrNull(timeoutMs) { laptopInputSignal.first() }
                    }
                    val arr = JSONArray()
                    while (arr.length() < 64) {
                        val ev = laptopInputQueue.poll() ?: break
                        arr.put(ev)
                    }
                    respondJson(call, JSONObject().put("ok", true).put("events", arr))
                }

                post("/api/laptop/screen/request") {
                    if (!checkAuth(call)) return@post
                    val obj = runCatching { JSONObject(call.receiveText()) }.getOrElse { JSONObject() }
                    while (laptopInputQueue.size > 128) laptopInputQueue.poll()
                    laptopInputQueue.offer(JSONObject().apply {
                        put("op", "capture")
                        put("maxW", obj.optInt("maxW", 960).coerceIn(320, 1920))
                        put("quality", obj.optInt("quality", 62).coerceIn(30, 90))
                        put("ts", System.currentTimeMillis())
                    })
                    laptopInputSignal.tryEmit(Unit)
                    respondJson(call, JSONObject().put("ok", true))
                }

                post("/api/laptop/screen") {
                    if (!checkAuth(call)) return@post
                    val ch = call.receiveChannel()
                    val baos = ByteArrayOutputStream()
                    val buf = ByteArray(8192)
                    while (!ch.isClosedForRead && baos.size() < 2 * 1024 * 1024) {
                        val n = ch.readAvailable(buf)
                        if (n > 0) baos.write(buf, 0, n) else if (n < 0) break
                    }
                    val bytes = baos.toByteArray()
                    val w = call.request.queryParameters["w"]?.toIntOrNull()
                        ?: call.request.headers["X-Screen-W"]?.toIntOrNull() ?: 0
                    val h = call.request.queryParameters["h"]?.toIntOrNull()
                        ?: call.request.headers["X-Screen-H"]?.toIntOrNull() ?: 0
                    val ts = System.currentTimeMillis()
                    if (bytes.isNotEmpty()) {
                        laptopScreenBytes = bytes
                        val meta = JSONObject().put("ts", ts).put("w", w).put("h", h).put("bytes", bytes.size)
                        laptopScreenMeta = meta
                        notifyChange("screen_ready", meta.toString())
                    }
                    respondJson(call, JSONObject().put("ok", bytes.isNotEmpty()).put("ts", ts).put("bytes", bytes.size))
                }

                get("/api/laptop/screen") {
                    if (!checkAuth(call)) return@get
                    val bytes = laptopScreenBytes
                    if (bytes == null || bytes.isEmpty()) {
                        call.respondText("""{"error":"No screenshot yet"}""", ContentType.Application.Json, HttpStatusCode.NotFound)
                        return@get
                    }
                    call.response.header(HttpHeaders.CacheControl, "no-store")
                    call.respondBytes(bytes, ContentType.Image.JPEG)
                }

                post("/api/laptop/smtc-art") {
                    if (!checkAuth(call)) return@post
                    val ch = call.receiveChannel()
                    val baos = ByteArrayOutputStream()
                    val buf = ByteArray(8192)
                    while (!ch.isClosedForRead && baos.size() < 2 * 1024 * 1024) {
                        val n = ch.readAvailable(buf)
                        if (n > 0) baos.write(buf, 0, n) else if (n < 0) break
                    }
                    val bytes = baos.toByteArray()
                    val mime = call.request.headers[HttpHeaders.ContentType] ?: "image/jpeg"
                    val key = call.request.queryParameters["key"] ?: ""
                    val ts = System.currentTimeMillis()
                    if (bytes.isNotEmpty()) {
                        smtcArtBytes = bytes
                        smtcArtMime = mime
                        val meta = JSONObject().put("ts", ts).put("key", key).put("bytes", bytes.size)
                        smtcArtMeta = meta
                        notifyChange("smtc_art_ready", meta.toString())
                    }
                    respondJson(call, JSONObject().put("ok", bytes.isNotEmpty()).put("ts", ts))
                }

                delete("/api/laptop/smtc-art") {
                    if (!checkAuth(call)) return@delete
                    smtcArtBytes = null
                    val meta = JSONObject().put("ts", 0L).put("key", "")
                    smtcArtMeta = meta
                    notifyChange("smtc_art_ready", meta.toString())
                    respondJson(call, JSONObject().put("ok", true))
                }

                get("/api/laptop/smtc-art") {
                    if (!checkAuth(call)) return@get
                    val bytes = smtcArtBytes
                    if (bytes == null || bytes.isEmpty()) {
                        call.respondText("""{"error":"No album art"}""", ContentType.Application.Json, HttpStatusCode.NotFound)
                        return@get
                    }
                    val parsedMime = runCatching { ContentType.parse(smtcArtMime) }.getOrElse { ContentType.Image.JPEG }
                    call.response.header(HttpHeaders.CacheControl, "no-store")
                    call.respondBytes(bytes, parsedMime)
                }

                // --- Clipboard Vault ---
                get("/api/clipboard") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, JSONObject().put("items", db.getClipboardHistory()).put("deviceClip", hw.getClipboardText()))
                }

                post("/api/clipboard") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val text = obj.optString("content", "").ifBlank { hw.getClipboardText() }
                    val source = obj.optString("source", if (isLocalClient(call)) "phone" else "laptop")
                    val copyToDevice = obj.optBoolean("copyToDevice", true)
                    if (text.isNotBlank()) {
                        db.addClipboardItem(text, source)
                        if (copyToDevice) hw.setClipboardText(text)
                        notifyChange("clip_sync", JSONObject().put("content", text).put("source", source).toString())
                        notifyChange("state")
                    }
                    respondJson(call, JSONObject().put("ok", text.isNotBlank()).put("items", db.getClipboardHistory()))
                }

                delete("/api/clipboard/{id}") {
                    if (!checkAuth(call)) return@delete
                    db.deleteClipboardItem(call.parameters["id"]?.toLongOrNull() ?: 0L)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                // --- Live Phone Notifications Bridge ---
                get("/api/phone-notifications") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, JSONObject().put("items", PhoneNotificationService.getActiveNotifications(context)))
                }

                post("/api/phone-notifications/dismiss") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val ok = PhoneNotificationService.dismissNotification(obj.optString("key", ""))
                    respondJson(call, JSONObject().put("ok", ok))
                }

                post("/api/phone-notifications/reply") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val ok = PhoneNotificationService.replyToNotification(
                        obj.optString("key", ""),
                        obj.optInt("actionIndex", 0),
                        obj.optString("text", "")
                    )
                    respondJson(call, JSONObject().put("ok", ok))
                }

                // --- Accessibility App Remote Control & Macros ---
                post("/api/a11y/global") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val ok = PhoneAccessibilityService.instance?.performGlobal(obj.optString("action", "home")) ?: false
                    respondJson(call, JSONObject().put("ok", ok).put("connected", PhoneAccessibilityService.instance != null))
                }

                post("/api/a11y/tap") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val svc = PhoneAccessibilityService.instance
                    val ok = when {
                        svc == null -> false
                        obj.has("text") -> svc.tapByText(obj.optString("text", ""))
                        else -> svc.tap(obj.optDouble("x", 540.0).toFloat(), obj.optDouble("y", 1200.0).toFloat())
                    }
                    respondJson(call, JSONObject().put("ok", ok).put("connected", svc != null))
                }

                post("/api/a11y/swipe") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val svc = PhoneAccessibilityService.instance
                    val ok = svc?.swipe(
                        obj.optDouble("x1", 540.0).toFloat(),
                        obj.optDouble("y1", 1600.0).toFloat(),
                        obj.optDouble("x2", 540.0).toFloat(),
                        obj.optDouble("y2", 600.0).toFloat(),
                        obj.optLong("ms", 320)
                    ) ?: false
                    respondJson(call, JSONObject().put("ok", ok).put("connected", svc != null))
                }

                post("/api/a11y/type") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val svc = PhoneAccessibilityService.instance
                    val ok = svc?.typeTextIntoFocused(obj.optString("text", "")) ?: false
                    respondJson(call, JSONObject().put("ok", ok).put("connected", svc != null))
                }

                get("/api/a11y/nodes") {
                    if (!checkAuth(call)) return@get
                    val svc = PhoneAccessibilityService.instance
                    if (svc == null) {
                        respondJson(call, JSONObject().put("connected", false).put("nodes", JSONArray()))
                    } else {
                        respondJson(call, svc.inspectScreenNodes())
                    }
                }

                get("/api/macros") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, JSONObject().put("macros", db.getMacros()))
                }

                post("/api/macros") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val steps = obj.optJSONArray("steps") ?: JSONArray()
                    val id = db.addMacro(obj.optString("name", "Macro"), steps)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("id", id).put("macros", db.getMacros()))
                }

                post("/api/macros/{id}/run") {
                    if (!checkAuth(call)) return@post
                    val id = call.parameters["id"]?.toLongOrNull() ?: 0L
                    val steps = db.findMacroSteps(id)
                        ?: return@post call.respondText("""{"ok":false,"error":"Macro not found"}""", ContentType.Application.Json, HttpStatusCode.NotFound)
                    scope.launch(Dispatchers.IO) { PhoneAccessibilityService.runMacroSteps(steps, hw) }
                    respondJson(call, JSONObject().put("ok", true))
                }

                delete("/api/macros/{id}") {
                    if (!checkAuth(call)) return@delete
                    db.deleteMacro(call.parameters["id"]?.toLongOrNull() ?: 0L)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                // --- Automation Rules ---
                get("/api/rules") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, JSONObject().put("rules", db.getRules()))
                }

                post("/api/rules") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val id = db.addRule(
                        obj.optString("name", ""),
                        obj.optString("triggerType", "battery_below"),
                        obj.optString("triggerValue", "20"),
                        obj.optString("actionType", "notify"),
                        obj.optString("actionValue", ""),
                        obj.optInt("cooldownSec", 300)
                    )
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("id", id).put("rules", db.getRules()))
                }

                patch("/api/rules/{id}") {
                    if (!checkAuth(call)) return@patch
                    val id = call.parameters["id"]?.toLongOrNull() ?: 0L
                    val obj = JSONObject(call.receiveText())
                    db.toggleRule(id, obj.optBoolean("enabled", true))
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                post("/api/rules/{id}/run") {
                    if (!checkAuth(call)) return@post
                    val id = call.parameters["id"]?.toLongOrNull() ?: 0L
                    val ok = ruleEngine.runRuleById(id, scope)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", ok))
                }

                delete("/api/rules/{id}") {
                    if (!checkAuth(call)) return@delete
                    db.deleteRule(call.parameters["id"]?.toLongOrNull() ?: 0L)
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true))
                }

                // --- RSS & Hacker News ---
                get("/api/feeds") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, JSONObject().put("feeds", db.getFeeds()))
                }

                post("/api/feeds") {
                    if (!checkAuth(call)) return@post
                    val obj = JSONObject(call.receiveText())
                    val url = obj.optString("url", "").trim()
                    if (url.isEmpty()) return@post call.respondText("""{"error":"url required"}""", ContentType.Application.Json, HttpStatusCode.BadRequest)
                    val id = db.addFeed(obj.optString("name", url), url)
                    scope.launch(Dispatchers.IO) { onRefreshNewsNow() }
                    respondJson(call, JSONObject().put("ok", true).put("id", id).put("feeds", db.getFeeds()))
                }

                delete("/api/feeds/{id}") {
                    if (!checkAuth(call)) return@delete
                    db.deleteFeed(call.parameters["id"]?.toLongOrNull() ?: 0L)
                    scope.launch(Dispatchers.IO) { onRefreshNewsNow() }
                    respondJson(call, JSONObject().put("ok", true))
                }

                post("/api/news/refresh") {
                    if (!checkAuth(call)) return@post
                    withContext(Dispatchers.IO) { onRefreshNewsNow() }
                    respondJson(call, JSONObject().put("ok", true).put("news", ServerService.cachedNews))
                }

                get("/api/geocode") {
                    if (!checkAuth(call)) return@get
                    val city = call.request.queryParameters["city"]?.trim().orEmpty()
                    if (city.isBlank()) return@get call.respondText("""{"error":"city required"}""", ContentType.Application.Json, HttpStatusCode.BadRequest)
                    val resJson = withContext(Dispatchers.IO) {
                        runCatching {
                            val enc = java.net.URLEncoder.encode(city, "UTF-8")
                            val url = java.net.URL("https://geocoding-api.open-meteo.com/v1/search?name=$enc&count=1&language=en&format=json")
                            val conn = (url.openConnection() as java.net.HttpURLConnection).apply { connectTimeout = 5000; readTimeout = 5000 }
                            conn.inputStream.bufferedReader().use { it.readText() }
                        }.getOrNull()
                    }
                    if (resJson == null) {
                        respondJson(call, JSONObject().put("ok", false).put("error", "Geocoding request failed"))
                    } else {
                        val first = runCatching { JSONObject(resJson).optJSONArray("results")?.optJSONObject(0) }.getOrNull()
                        if (first == null) {
                            respondJson(call, JSONObject().put("ok", false).put("error", "No data found for '$city'"))
                        } else {
                            respondJson(call, JSONObject().apply {
                                put("ok", true)
                                put("name", first.optString("name", city))
                                put("country", first.optString("country", ""))
                                put("lat", first.optDouble("latitude"))
                                put("lon", first.optDouble("longitude"))
                            })
                        }
                    }
                }

                get("/api/settings") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, db.getSettings())
                }

                put("/api/settings") {
                    if (!checkAuth(call)) return@put
                    val obj = JSONObject(call.receiveText())
                    db.putSettings(obj)
                    onSettingsApplied()
                    notifyChange("state")
                    respondJson(call, JSONObject().put("ok", true).put("settings", db.getSettings()))
                }

                get("/api/db/summary") {
                    if (!checkAuth(call)) return@get
                    respondJson(call, db.getDbSummary())
                }

                post("/api/vibrate") {
                    if (!checkAuth(call)) return@post
                    vibratePhone(100)
                    respondJson(call, JSONObject().put("ok", true))
                }
            }
        }
        engine?.start(wait = false)
        AppLog.add("ok", "server", "Ktor CIO listening on 0.0.0.0:$port")
    }

    fun stop() {
        runCatching { engine?.stop(300, 1000) }
        engine = null
    }

    private fun buildFullState(includeLocalSecrets: Boolean = false): JSONObject {
        val telemetry = DeviceTelemetry.collect(context, port, startedAt)
        val metrics = JSONObject().apply {
            put("batteryPct", db.getMetricsHistory("batteryPct", 60))
            put("cpuPct", db.getMetricsHistory("cpuPct", 60))
            put("ramPct", db.getMetricsHistory("ramPct", 60))
            put("netRxKbps", db.getMetricsHistory("netRxKbps", 60))
            put("netTxKbps", db.getMetricsHistory("netTxKbps", 60))
            put("socTempC", db.getMetricsHistory("socTempC", 60))
            put("lap_cpuPct", db.getMetricsHistory("lap_cpuPct", 60))
            put("lap_gpuPct", db.getMetricsHistory("lap_gpuPct", 60))
            put("lap_netRxKbps", db.getMetricsHistory("lap_netRxKbps", 60))
            put("lap_netTxKbps", db.getMetricsHistory("lap_netTxKbps", 60))
        }
        val perms = JSONObject().apply {
            put("a11yEnabled", PhoneAccessibilityService.isEnabled(context))
            put("a11yConnected", PhoneAccessibilityService.instance != null)
            put("notifEnabled", PhoneNotificationService.isEnabled(context))
            put("notifConnected", PhoneNotificationService.instance != null)
            put("foregroundPkg", PhoneAccessibilityService.currentForegroundPkg)
        }
        val relayInfo = JSONObject().apply {
            val rc = ServerService.activeRelay
            put("enabled", db.getSetting("relay_enabled", "0") == "1")
            put("connected", rc?.connected == true)
            put("lastError", rc?.lastError ?: "")
            put("url", db.getSetting("relay_url", ""))
            put("room", db.getSetting("relay_room", ""))
        }
        return JSONObject().apply {
            put("serverTime", System.currentTimeMillis())
            put("telemetry", telemetry)
            put("sensors", hw.getSensorsSnapshot())
            put("audio", hw.getAudioState())
            put("media", PhoneNotificationService.getActiveMedia(context))
            put("permissions", perms)
            put("pages", db.getPages())
            put("pushed", db.getPushedMap())
            put("notes", db.getNotes())
            put("checklists", db.getChecklists())
            put("monitors", db.getMonitors())
            put("notifications", db.getNotifications(30))
            put("phoneNotifications", PhoneNotificationService.getActiveNotifications(context))
            put("files", db.getFiles())
            put("wolTargets", db.getWolTargets())
            put("clipboard", db.getClipboardHistory(20))
            put("rules", db.getRules())
            put("macros", db.getMacros())
            put("feeds", db.getFeeds())
            put("news", ServerService.cachedNews)
            put("appDock", db.getAppDock())
            put("agy", db.getAgyState())
            put("agyPermissions", db.getAgyPermissions(20))
            put("agyCode", db.getAgyCode())
            put("agyCommands", db.getAgyCommands(15))
            put("laptop", db.getLaptopTelemetry())
            put("callState", PhoneNotificationService.getCallState(context))
            put("laptopScreen", laptopScreenMeta)
            put("smtcArt", smtcArtMeta)
            put("pairedDevices", db.getPairedDevices())
            put("pendingPairs", buildPendingPairsJson(includeLocalSecrets))
            put("relay", relayInfo)
            put("settings", db.getSettings())
            put("metrics", metrics)
            put("db", db.getDbSummary())
            put("logs", AppLog.toJsonArray(30))
        }
    }

    private fun isLocalClient(call: RoutingCall): Boolean {
        if (call.request.headers.contains("X-PhoneBox-Forwarded")) return false
        val remote = call.request.local.remoteAddress
        return remote == "127.0.0.1" || remote == "::1" || remote == "localhost" || remote == "0:0:0:0:0:0:0:1"
    }

    private fun hasValidAuth(call: RoutingCall): Boolean {
        val remoteIp = call.request.local.remoteAddress
        val authHdr = call.request.headers[HttpHeaders.Authorization]
        val bearer = if (authHdr != null && authHdr.startsWith("Bearer ", ignoreCase = true)) authHdr.substring(7).trim() else ""
        val token = call.request.headers["X-PhoneBox-Token"]
            ?: bearer.ifEmpty { null }
            ?: call.request.queryParameters["token"]
            ?: call.request.cookies["pb_token"]
        if (!token.isNullOrBlank() && db.verifyPairedToken(token, remoteIp)) return true

        val pinEnabled = db.getSetting("pin_enabled", "0") == "1"
        if (pinEnabled) {
            val expected = db.getSetting("pin", "1234")
            val provided = call.request.headers["X-PhoneBox-Pin"]
                ?: call.request.queryParameters["pin"]
                ?: call.request.cookies["pb_pin"]
            if (provided == expected) return true
        }
        return false
    }

    private suspend fun checkAuth(call: RoutingCall): Boolean {
        if (isLocalClient(call) || hasValidAuth(call)) return true
        val pairRequired = db.getSetting("require_pairing", "1") == "1"
        val pinEnabled = db.getSetting("pin_enabled", "0") == "1"
        if (!pairRequired && !pinEnabled) return true
        call.respondText(
            """{"error":"Device confirmation required","pairRequired":$pairRequired,"pinRequired":$pinEnabled}""",
            ContentType.Application.Json,
            HttpStatusCode.Unauthorized
        )
        return false
    }

    private suspend fun respondJson(call: RoutingCall, obj: JSONObject) {
        call.respondText(obj.toString(), ContentType.Application.Json)
    }

    private suspend fun serveAsset(call: RoutingCall, assetPath: String) {
        val clean = assetPath.removePrefix("/").replace("..", "")
        try {
            val bytes = context.assets.open(clean).use { it.readBytes() }
            val ct = when {
                clean.endsWith(".html") -> ContentType.Text.Html
                clean.endsWith(".css") -> ContentType.Text.CSS
                clean.endsWith(".js") -> ContentType.Text.JavaScript
                clean.endsWith(".json") -> ContentType.Application.Json
                clean.endsWith(".svg") -> ContentType.Image.SVG
                clean.endsWith(".png") -> ContentType.Image.PNG
                else -> ContentType.Application.OctetStream
            }
            call.respondBytes(bytes, ct)
        } catch (_: Throwable) {
            call.respondText("Not found: $clean", ContentType.Text.Plain, HttpStatusCode.NotFound)
        }
    }

    private fun sanitizeFilename(raw: String): String {
        return raw.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[^A-Za-z0-9._ -]"), "_")
            .take(120)
            .ifBlank { "file.bin" }
    }

    private fun postUrgentAndroidNotification(title: String, body: String) {
        runCatching {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return
            val openIntent = Intent(context, Class.forName("com.santhu.phonebox.MainActivity")).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            }
            val pi = PendingIntent.getActivity(
                context, 901, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val n = NotificationCompat.Builder(context, PhoneBoxApp.CHANNEL_URGENT)
                .setSmallIcon(R.drawable.ic_stat_friday)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build()
            nm.notify((System.currentTimeMillis() % 100000L).toInt() + 2000, n)
        }
    }

    private fun vibratePhone(ms: Long) {
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vm?.defaultVibrator?.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                val v = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
                v?.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
            }
        }
    }

    private fun buildQrSvg(text: String): String {
        val hints = mapOf(EncodeHintType.MARGIN to 1)
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints)
        val size = matrix.width
        val sb = StringBuilder()
        sb.append("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 $size $size\" shape-rendering=\"crispEdges\">")
        sb.append("<rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>")
        sb.append("<path fill=\"#090b10\" d=\"")
        for (y in 0 until size) {
            for (x in 0 until size) {
                if (matrix.get(x, y)) sb.append("M").append(x).append(",").append(y).append("h1v1h-1z")
            }
        }
        sb.append("\"/></svg>")
        return sb.toString()
    }

    private data class WidgetSpec(
        val type: String,
        val name: String,
        val category: String,
        val device: String,
        val desc: String,
        val w: Int,
        val h: Int
    )

    private fun buildWidgetCatalog(): JSONArray {
        val items = listOf(
            // MOBILE WIDGETS
            WidgetSpec("clock", "Digital Clock", "Time", "mobile", "Live clock, date, and battery status", 5, 3),
            WidgetSpec("connect_qr", "Connect & Pair", "System", "mobile", "LAN/Remote URL QR, paired laptops & 6-digit onboarding", 4, 3),
            WidgetSpec("phone_monitor", "Mobile Hardware (2x2 + 3D)", "System", "mobile", "Live SoC CPU, Power/Thermal, RAM/Disk, Network & 3D Phone", 12, 6),
            WidgetSpec("world_strip", "World Clocks Strip", "Time", "mobile", "5-city live timezone strip with day offsets", 12, 2),
            WidgetSpec("hourly_weather", "Weather Forecast", "Data", "mobile", "Bi-hourly Open-Meteo temperature and weather icons", 8, 4),
            WidgetSpec("calendar_month", "Monthly Calendar", "Time", "mobile", "Monday-start calendar grid with ISO week badge", 4, 4),
            WidgetSpec("quick_controls", "Phone Quick Controls", "Hardware", "mobile", "Flashlight toggle, phone volume slider, mute & find beep", 3, 3),
            WidgetSpec("now_playing", "Phone Media", "Media", "mobile", "Local Android playback + Play/Pause/Skip", 6, 3),
            WidgetSpec("app_dock", "Android App Dock", "Hardware", "mobile", "Launch pinned Android apps with real icons", 6, 3),
            WidgetSpec("checklist", "Daily Checklist", "Productivity", "mobile", "Interactive task checklist saved in SQLite", 4, 3),
            WidgetSpec("notes", "Quick Notes", "Productivity", "mobile", "Create, edit, and pin notes directly on phone", 4, 3),
            WidgetSpec("clipboard", "Shared Clipboard", "Productivity", "mobile", "Two-way laptop/phone clipboard history", 4, 3),
            WidgetSpec("files", "File Drop Vault", "Productivity", "mobile", "Send and access phone vault files", 4, 3),
            WidgetSpec("timer", "Timers & Stopwatch", "Time", "mobile", "Quick timers, Pomodoro & live stopwatch", 4, 3),
            WidgetSpec("pomodoro", "Pomodoro Focus", "Time", "mobile", "Dedicated 25-min focus timer", 4, 3),
            WidgetSpec("uptime_monitor", "Uptime & Ping Monitor", "Network", "mobile", "Live status of configured LAN/Web hosts", 4, 3),
            WidgetSpec("metrics_chart", "SQLite History Chart", "System", "mobile", "Sparkline chart backed by SQLite history", 5, 3),
            WidgetSpec("sensors", "Sensors & Signal", "System", "mobile", "Ambient light lux, steps, motion, and Wi-Fi dBm", 4, 3),
            WidgetSpec("wol", "Wake-on-LAN", "Network", "mobile", "One-tap magic packet wake buttons for PCs", 3, 3),
            WidgetSpec("rules_widget", "Automation Rules", "Automation", "mobile", "Monitor, pause, or fire on-phone SQLite rules", 4, 3),
            WidgetSpec("inbox", "Webhook Inbox", "Data", "mobile", "Recent alerts from webhooks & notifications", 4, 3),
            WidgetSpec("news_feed", "Tech News & RSS", "Data", "mobile", "Live HN & RSS headlines cached by server", 4, 3),
            // LAPTOP WIDGETS
            WidgetSpec("laptop_monitor", "Laptop Hardware (2x2 + 3D)", "System", "laptop", "Live CPU, GPU, RAM/VRAM, Disks, Network & 3D Laptop", 12, 6),
            WidgetSpec("laptop_processes", "Processes & Job Watch", "System", "laptop", "Live CPU/RAM process table with End Task & Completion Ping", 12, 6),
            WidgetSpec("pc_music_player", "Music Studio Player", "Music", "laptop", "Album art, SMTC live timeline seek, transport & master volume", 7, 6),
            WidgetSpec("pc_audio_stage", "3D Audio Devices & Mixer", "Music", "laptop", "Interactive 3D audio device stage, output switcher & per-app mixer", 5, 6),
            WidgetSpec("pc_deck", "PC App & Control Deck", "Control", "laptop", "4x3 Windows app launcher, active window focus & system keys", 12, 6),
            WidgetSpec("pc_trackpad", "Wireless Trackpad & Keys", "Control", "laptop", "Touch cursor, scroll rail, keyboard, hotkeys & Call Auto-Mute", 6, 6),
            WidgetSpec("pc_screen", "Live Screen Peek", "Control", "laptop", "Real-time laptop monitor snapshots & tap-to-click", 6, 6),
            WidgetSpec("pc_display", "Display, Profiles & Clip", "Control", "laptop", "Screen brightness slider, audio presets & clipboard auto-sync", 5, 6),
            WidgetSpec("pc_windows", "Open PC Windows Manager", "Control", "laptop", "Focus, snap left/right, minimize or close laptop windows", 7, 6),
            // DEV / AI WIDGETS
            WidgetSpec("antigravity", "Antigravity Usage & Quota", "Dev", "laptop", "Live 5h/weekly quota, context window & token breakdown", 7, 6),
            WidgetSpec("agy_permissions", "Phone Approvals Gate", "Dev", "laptop", "Approve or deny laptop AI tool prompts on phone", 5, 6),
            WidgetSpec("agy_code", "Live Code Diff Preview", "Dev", "laptop", "Modified workspace files & colorized diffs", 7, 6),
            WidgetSpec("agy_control", "AI Remote Control", "Dev", "laptop", "Send instructions, pause agent & switch gate policies", 5, 6)
        )
        val arr = JSONArray()
        for (it in items) {
            arr.put(JSONObject().apply {
                put("type", it.type)
                put("name", it.name)
                put("category", it.category)
                put("device", it.device)
                put("desc", it.desc)
                put("w", it.w)
                put("h", it.h)
            })
        }
        return arr
    }
}
