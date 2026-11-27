package com.santhu.phonebox.system

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import com.santhu.phonebox.PhoneBoxApp
import com.santhu.phonebox.server.ServerService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.UUID

object ShareReceiverHelper {

    fun handle(context: Context, intent: Intent?, scope: CoroutineScope, onDone: (String) -> Unit) {
        if (intent == null) return
        val action = intent.action ?: return
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return

        val uris = extractUris(intent, action)
        val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        if (uris.isEmpty() && sharedText.isBlank()) return

        val appCtx = context.applicationContext
        scope.launch(Dispatchers.IO) {
            repeat(24) {
                if (ServerService.activeServer != null) return@repeat
                delay(150)
            }
            val app = PhoneBoxApp.instance
            var sentCount = 0
            var lastFilename = ""

            for (uri in uris) {
                runCatching {
                    val mime = appCtx.contentResolver.getType(uri) ?: "application/octet-stream"
                    val rawName = resolveName(appCtx, uri, mime)
                    val safeName = rawName.replace(Regex("[/\\\\:*?\"<>|\\r\\n\\t]+"), "_").take(140).ifBlank { "shared-file" }
                    val storedKey = "${UUID.randomUUID()}_$safeName"
                    val outFile = File(app.dropDir, storedKey)
                    appCtx.contentResolver.openInputStream(uri)?.use { input ->
                        outFile.outputStream().use { output -> input.copyTo(output) }
                    } ?: return@runCatching
                    val size = outFile.length()
                    val id = app.db.insertFile(safeName, mime, size, storedKey)
                    ServerService.enqueueLaptopCommand(
                        JSONObject()
                            .put("op", "pull_file")
                            .put("id", id)
                            .put("filename", safeName)
                    )
                    sentCount++
                    lastFilename = safeName
                    AppLog.add("ok", "share", "Queued PC transfer: $safeName ($size bytes)")
                }
            }

            if (sentCount > 0) {
                ServerService.activeServer?.notifyChange("state")
                val msg = if (sentCount == 1) "Sent $lastFilename to F.R.I.D.A.Y. PC Drop" else "Sent $sentCount files to F.R.I.D.A.Y. PC Drop"
                withContext(Dispatchers.Main) { onDone(msg) }
                return@launch
            }

            if (sharedText.isNotBlank()) {
                app.db.addClipboardItem(sharedText, "share")
                if (sharedText.length <= 8000) app.hw.setClipboardText(sharedText)
                ServerService.activeServer?.notifyChange(
                    "clip_sync",
                    JSONObject().put("content", sharedText).put("source", "share").toString()
                )
                ServerService.activeServer?.notifyChange("state")
                if (sharedText.length <= 4000) {
                    ServerService.enqueueLaptopCommand(JSONObject().put("op", "set_clip").put("text", sharedText))
                }
                val isUrl = sharedText.startsWith("http://") || sharedText.startsWith("https://")
                val msg = if (isUrl) "Shared link synced to PC clipboard" else "Shared text synced to PC clipboard"
                withContext(Dispatchers.Main) { onDone(msg) }
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun extractUris(intent: Intent, action: String): List<Uri> {
        return when (action) {
            Intent.ACTION_SEND -> listOfNotNull(
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    intent.getParcelableExtra(Intent.EXTRA_STREAM)
                }
            )
            Intent.ACTION_SEND_MULTIPLE -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
                } else {
                    intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
                }
            }
            else -> emptyList()
        }
    }

    private fun resolveName(context: Context, uri: Uri, mime: String): String {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (idx >= 0) {
                    val v = c.getString(idx)
                    if (!v.isNullOrBlank()) return v
                }
            }
        }
        val seg = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() }
        if (seg != null && seg.contains('.')) return seg
        val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: "bin"
        return "${seg ?: "shared"}_${System.currentTimeMillis()}.$ext"
    }
}
