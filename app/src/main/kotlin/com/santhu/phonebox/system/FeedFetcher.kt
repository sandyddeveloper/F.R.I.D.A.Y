package com.santhu.phonebox.system

import org.json.JSONArray
import org.json.JSONObject
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory
import java.io.StringReader
import java.net.HttpURLConnection
import java.net.URL

object FeedFetcher {

    fun fetchHackerNews(limit: Int = 8): JSONArray {
        val arr = JSONArray()
        runCatching {
            val idsRaw = httpGet("https://hacker-news.firebaseio.com/v0/topstories.json")
            val ids = JSONArray(idsRaw)
            val count = minOf(limit, ids.length())
            for (i in 0 until count) {
                val id = ids.getLong(i)
                val itemRaw = httpGet("https://hacker-news.firebaseio.com/v0/item/$id.json")
                val item = JSONObject(itemRaw)
                arr.put(JSONObject().apply {
                    put("title", item.optString("title", ""))
                    put("url", item.optString("url", "https://news.ycombinator.com/item?id=$id"))
                    put("source", "Hacker News")
                    put("score", item.optInt("score", 0))
                })
            }
        }
        return arr
    }

    fun fetchRssFeed(feedName: String, feedUrl: String, limit: Int = 8): JSONArray {
        val arr = JSONArray()
        runCatching {
            val xml = httpGet(feedUrl)
            val factory = XmlPullParserFactory.newInstance()
            factory.isNamespaceAware = false
            val parser = factory.newPullParser()
            parser.setInput(StringReader(xml))

            var insideItem = false
            var title = ""
            var link = ""
            var event = parser.eventType
            while (event != XmlPullParser.END_DOCUMENT && arr.length() < limit) {
                val tag = parser.name?.lowercase().orEmpty()
                when (event) {
                    XmlPullParser.START_TAG -> {
                        if (tag == "item" || tag == "entry") {
                            insideItem = true
                            title = ""
                            link = ""
                        } else if (insideItem && tag == "title") {
                            title = parser.nextText().trim()
                        } else if (insideItem && tag == "link") {
                            val href = parser.getAttributeValue(null, "href")
                            link = href ?: parser.nextText().trim()
                        }
                    }
                    XmlPullParser.END_TAG -> {
                        if ((tag == "item" || tag == "entry") && insideItem) {
                            if (title.isNotBlank()) {
                                arr.put(JSONObject().apply {
                                    put("title", title)
                                    put("url", link)
                                    put("source", feedName)
                                })
                            }
                            insideItem = false
                        }
                    }
                }
                event = parser.next()
            }
        }
        return arr
    }

    private fun httpGet(url: String): String {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 4500
            readTimeout = 4500
            setRequestProperty("User-Agent", "FRIDAY-Server/2.0")
        }
        return conn.inputStream.bufferedReader().use { it.readText() }
    }
}
