package com.santhu.phonebox.system

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

object AppLog {
    data class Entry(val ts: Long, val level: String, val tag: String, val message: String)

    private val entries = CopyOnWriteArrayList<Entry>()
    private const val MAX_ENTRIES = 200

    fun add(level: String, tag: String, message: String) {
        entries.add(0, Entry(System.currentTimeMillis(), level, tag, message))
        while (entries.size > MAX_ENTRIES) {
            entries.removeAt(entries.lastIndex)
        }
    }

    fun toJsonArray(limit: Int = 50): JSONArray {
        val arr = JSONArray()
        for (item in entries.take(limit)) {
            arr.put(
                JSONObject().apply {
                    put("ts", item.ts)
                    put("level", item.level)
                    put("tag", item.tag)
                    put("message", item.message)
                }
            )
        }
        return arr
    }
}
