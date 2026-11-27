package com.santhu.phonebox.db

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.util.UUID

class PhoneDb(context: Context) : SQLiteOpenHelper(context, "phonebox_server.db", null, 13) {

    init {
        setWriteAheadLoggingEnabled(true)
    }

    override fun onCreate(db: SQLiteDatabase) {
        createCoreTables(db)
        createV2Tables(db)
        createAgyTables(db)
        createCodeControlV6(db)
        createTelemetryV7(db)
        createLaptopCommandsV8(db)
        createPairingTablesV12(db)
        seedDefaults(db)
        seedV2Defaults(db)
        seedAgyDefaults(db)
        seedCodePageV6(db)
        seedTelemetryPagesV7(db)
        seedDashPagesV8(db)
        seedRemoteControlV9(db)
        seedDeckPagesV10(db)
        seedMusicStudioV11(db)
        consolidateOpenSourceV12(db)
        cleanupOpenSourceV13(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            createV2Tables(db)
            seedV2Defaults(db)
        }
        if (oldVersion < 3) {
            cleanDemoSeeds(db)
        }
        if (oldVersion < 4) {
            createAgyTables(db)
            seedAgyDefaults(db)
        }
        if (oldVersion < 5) {
            upgradeAgyV5(db)
        }
        if (oldVersion < 6) {
            createCodeControlV6(db)
            seedCodePageV6(db)
        }
        if (oldVersion < 7) {
            createTelemetryV7(db)
            seedTelemetryPagesV7(db)
        }
        if (oldVersion < 8) {
            createLaptopCommandsV8(db)
            seedDashPagesV8(db)
        }
        if (oldVersion < 9) {
            seedRemoteControlV9(db)
        }
        if (oldVersion < 10) {
            seedDeckPagesV10(db)
        }
        if (oldVersion < 11) {
            seedMusicStudioV11(db)
        }
        if (oldVersion < 12) {
            createPairingTablesV12(db)
            consolidateOpenSourceV12(db)
        }
        if (oldVersion < 13) {
            cleanupOpenSourceV13(db)
        }
    }

    private fun upgradeAgyV5(db: SQLiteDatabase) {
        val cols = HashSet<String>()
        db.rawQuery("PRAGMA table_info(agy_permissions)", null).use { c ->
            while (c.moveToNext()) cols.add(c.getString(1))
        }
        if (!cols.contains("kind")) db.execSQL("ALTER TABLE agy_permissions ADD COLUMN kind TEXT NOT NULL DEFAULT 'approval'")
        if (!cols.contains("payload_json")) db.execSQL("ALTER TABLE agy_permissions ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'")
        if (!cols.contains("response_json")) db.execSQL("ALTER TABLE agy_permissions ADD COLUMN response_json TEXT NOT NULL DEFAULT '{}'")
    }

    private fun cleanDemoSeeds(db: SQLiteDatabase) {
        db.delete("notes", "title = ?", arrayOf("PhoneBox Server Ready"))
        db.delete(
            "checklists",
            "text IN (?,?,?,?)",
            arrayOf("Verify PC browser Admin UI", "Customize desk widgets", "Test webhook push", "Open Admin Studio on laptop")
        )
        db.delete("checklists", "text IN (?,?)", arrayOf("Pin favorite phone apps", "Test clipboard & rules"))
        db.delete("kv_store", "k = ? AND value_json LIKE ?", arrayOf("status", "%Phone SQLite + Ktor active%"))
        db.delete("notifications", "title = ? AND source = ?", arrayOf("Server Initialized", "system"))
        db.delete("clipboard_history", "source = ?", arrayOf("system"))
        db.delete("clipboard_history", "content = ?", arrayOf("Studio verified"))
        db.delete("monitors", "name IN (?,?)", arrayOf("Home Router", "Cloudflare DNS"))
        db.delete("macros", "name = ?", arrayOf("Home & Play Media"))
        db.delete("rules", "name IN (?,?)", arrayOf("Low Battery Warning", "Dark Room Night Focus"))
        db.delete("settings", "k IN (?,?,?) AND v IN (?,?,?)", arrayOf("weather_city", "weather_lat", "weather_lon", "Local", "12.9716", "77.5946"))
        db.execSQL("DELETE FROM settings WHERE k = 'world_clocks' AND v = 'Asia/Kolkata|IST,UTC|UTC,America/New_York|NYC,Europe/London|LON'")
    }

    private fun createCoreTables(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS pages (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                sort_order INTEGER NOT NULL,
                layout_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS kv_store (
                k TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS metrics_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                metric_key TEXT NOT NULL,
                value_num REAL NOT NULL,
                meta_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_metrics_key_ts ON metrics_history(metric_key, created_at)")
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                pinned INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS checklists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL,
                done INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS monitors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL DEFAULT 0,
                last_up INTEGER NOT NULL DEFAULT -1,
                last_latency_ms INTEGER NOT NULL DEFAULT -1,
                last_checked_at INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                level TEXT NOT NULL DEFAULT 'info',
                source TEXT NOT NULL DEFAULT 'webhook',
                created_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                stored_name TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS wol_targets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                mac TEXT NOT NULL,
                broadcast TEXT NOT NULL DEFAULT '255.255.255.255'
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS settings (
                k TEXT PRIMARY KEY,
                v TEXT NOT NULL
            )
            """.trimIndent()
        )
    }

    private fun createV2Tables(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS clipboard_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'phone',
                created_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                trigger_type TEXT NOT NULL,
                trigger_value TEXT NOT NULL DEFAULT '',
                action_type TEXT NOT NULL,
                action_value TEXT NOT NULL DEFAULT '',
                cooldown_sec INTEGER NOT NULL DEFAULT 300,
                last_fired_at INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS macros (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                steps_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS rss_feeds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS app_dock (
                pkg TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent()
        )
    }

    private fun createAgyTables(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS agy_state (
                id INTEGER PRIMARY KEY,
                json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS agy_permissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                req_key TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                target TEXT NOT NULL,
                detail TEXT NOT NULL,
                model_name TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                resolved_at INTEGER NOT NULL DEFAULT 0,
                kind TEXT NOT NULL DEFAULT 'approval',
                payload_json TEXT NOT NULL DEFAULT '{}',
                response_json TEXT NOT NULL DEFAULT '{}'
            )
            """.trimIndent()
        )
    }

    private fun createCodeControlV6(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS agy_code (
                id INTEGER PRIMARY KEY,
                json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS agy_commands (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                command TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'prompt',
                status TEXT NOT NULL DEFAULT 'pending',
                created_at INTEGER NOT NULL,
                delivered_at INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent()
        )
    }

    private fun seedCodePageV6(db: SQLiteDatabase) {
        val now = System.currentTimeMillis()
        val codeLayout = """[
          {"id":"cd1","type":"agy_code","x":0,"y":0,"w":7,"h":6,"title":"Code Diff Preview","opts":{}},
          {"id":"cd2","type":"agy_control","x":7,"y":0,"w":5,"h":6,"title":"Antigravity Control","opts":{}}
        ]""".trimIndent()
        db.insertWithOnConflict("pages", null, ContentValues().apply {
            put("id", "code")
            put("title", "Code & Control")
            put("sort_order", 6)
            put("layout_json", codeLayout)
            put("updated_at", now)
        }, SQLiteDatabase.CONFLICT_IGNORE)

        val extraSettings = mapOf(
            "agy_paused" to "0",
            "agy_gate_scope" to "all",
            "agy_auto_ws_edits" to "0"
        )
        for ((k, v) in extraSettings) {
            db.insertWithOnConflict("settings", null, ContentValues().apply {
                put("k", k)
                put("v", v)
            }, SQLiteDatabase.CONFLICT_IGNORE)
        }
    }

    private fun createTelemetryV7(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS laptop_state (
                id INTEGER PRIMARY KEY,
                json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
    }

    private fun seedTelemetryPagesV7(db: SQLiteDatabase) {
        val now = System.currentTimeMillis()
        val laptopLayout = """[{"id":"lm1","type":"laptop_monitor","x":0,"y":0,"w":12,"h":6,"title":"Laptop Monitor","opts":{}}]"""
        val phoneLayout = """[{"id":"pm1","type":"phone_monitor","x":0,"y":0,"w":12,"h":6,"title":"Phone Hardware","opts":{}}]"""
        listOf(
            Triple("laptop", "Laptop Monitor", 7 to laptopLayout),
            Triple("phone_hw", "Phone Hardware", 8 to phoneLayout)
        ).forEach { (id, title, pair) ->
            db.insertWithOnConflict("pages", null, ContentValues().apply {
                put("id", id)
                put("title", title)
                put("sort_order", pair.first)
                put("layout_json", pair.second)
                put("updated_at", now)
            }, SQLiteDatabase.CONFLICT_IGNORE)
        }
    }

    private fun createLaptopCommandsV8(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS laptop_commands (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at INTEGER NOT NULL,
                delivered_at INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent()
        )
    }

    private fun seedDashPagesV8(db: SQLiteDatabase) {
        val now = System.currentTimeMillis()
        val procLayout = """[{"id":"lp1","type":"laptop_processes","x":0,"y":0,"w":12,"h":6,"title":"Laptop Processes","opts":{}}]"""
        val worldCalLayout = """[
          {"id":"wc1","type":"world_strip","x":0,"y":0,"w":12,"h":2,"title":"World Clocks","opts":{}},
          {"id":"wc2","type":"hourly_weather","x":0,"y":2,"w":8,"h":4,"title":"Next Hours","opts":{}},
          {"id":"wc3","type":"calendar_month","x":8,"y":2,"w":4,"h":4,"title":"Calendar","opts":{}}
        ]""".trimIndent()
        listOf(
            Triple("processes", "Laptop Processes", 9 to procLayout),
            Triple("world_cal", "World & Weather", 10 to worldCalLayout)
        ).forEach { (id, title, pair) ->
            db.insertWithOnConflict("pages", null, ContentValues().apply {
                put("id", id)
                put("title", title)
                put("sort_order", pair.first)
                put("layout_json", pair.second)
                put("updated_at", now)
            }, SQLiteDatabase.CONFLICT_IGNORE)
        }
    }

    private fun seedRemoteControlV9(db: SQLiteDatabase) {
        val now = System.currentTimeMillis()
        val remoteLayout = """[
          {"id":"pr1","type":"pc_trackpad","x":0,"y":0,"w":6,"h":6,"title":"Trackpad & Keyboard","opts":{}},
          {"id":"pr2","type":"pc_screen","x":6,"y":0,"w":6,"h":6,"title":"Live Screen Peek","opts":{}}
        ]""".trimIndent()
        db.insertWithOnConflict("pages", null, ContentValues().apply {
            put("id", "pc_remote")
            put("title", "PC Remote")
            put("sort_order", 11)
            put("layout_json", remoteLayout)
            put("updated_at", now)
        }, SQLiteDatabase.CONFLICT_IGNORE)

        val remoteSettings = mapOf(
            "win_notif_mirror" to "1",
            "call_auto_mute" to "1"
        )
        for ((k, v) in remoteSettings) {
            db.insertWithOnConflict("settings", null, ContentValues().apply {
                put("k", k)
                put("v", v)
            }, SQLiteDatabase.CONFLICT_IGNORE)
        }
    }

    private fun seedDeckPagesV10(db: SQLiteDatabase) {
        val now = System.currentTimeMillis()
        val deckLayout = """[{"id":"pd1","type":"pc_deck","x":0,"y":0,"w":12,"h":6,"title":"PC App & Control Deck","opts":{}}]"""
        val studioLayout = """[
          {"id":"ps1","type":"pc_media","x":0,"y":0,"w":7,"h":3,"title":"PC Media & Volume","opts":{}},
          {"id":"ps2","type":"pc_display","x":7,"y":0,"w":5,"h":3,"title":"Brightness, Profiles & Clip","opts":{}},
          {"id":"ps3","type":"pc_windows","x":0,"y":3,"w":12,"h":3,"title":"Open PC Windows","opts":{}}
        ]""".trimIndent()
        listOf(
            Triple("pc_deck", "PC Control Deck", 12 to deckLayout),
            Triple("pc_studio", "PC Media & Windows", 13 to studioLayout)
        ).forEach { (id, title, pair) ->
            db.insertWithOnConflict("pages", null, ContentValues().apply {
                put("id", id)
                put("title", title)
                put("sort_order", pair.first)
                put("layout_json", pair.second)
                put("updated_at", now)
            }, SQLiteDatabase.CONFLICT_IGNORE)
        }
        db.insertWithOnConflict("settings", null, ContentValues().apply {
            put("k", "clip_auto_sync")
            put("v", "1")
        }, SQLiteDatabase.CONFLICT_IGNORE)
    }

    private fun seedMusicStudioV11(db: SQLiteDatabase) {
        val now = System.currentTimeMillis()
        val musicLayout = """[
          {"id":"pm1","type":"pc_music_player","x":0,"y":0,"w":7,"h":6,"title":"Now Playing","opts":{}},
          {"id":"pm2","type":"pc_audio_stage","x":7,"y":0,"w":5,"h":6,"title":"3D Audio Devices & Mixer","opts":{}}
        ]""".trimIndent()
        db.insertWithOnConflict("pages", null, ContentValues().apply {
            put("id", "pc_music")
            put("title", "Music Studio")
            put("sort_order", 14)
            put("layout_json", musicLayout)
            put("updated_at", now)
        }, SQLiteDatabase.CONFLICT_IGNORE)
    }

    private fun createPairingTablesV12(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS paired_devices (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                platform TEXT NOT NULL DEFAULT 'windows',
                device_token TEXT NOT NULL UNIQUE,
                paired_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL DEFAULT 0,
                remote_ip TEXT NOT NULL DEFAULT ''
            )
            """.trimIndent()
        )
        val roomId = UUID.randomUUID().toString().replace("-", "").take(12)
        val secret = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val openSettings = mapOf(
            "require_pairing" to "1",
            "remote_url" to "",
            "relay_enabled" to "0",
            "relay_url" to "",
            "relay_room" to roomId,
            "relay_secret" to secret
        )
        for ((k, v) in openSettings) {
            db.insertWithOnConflict("settings", null, ContentValues().apply {
                put("k", k)
                put("v", v)
            }, SQLiteDatabase.CONFLICT_IGNORE)
        }
    }

    private fun consolidateOpenSourceV12(db: SQLiteDatabase) {
        val now = System.currentTimeMillis()
        // Remove legacy duplicate pages so Mobile & Laptop pages have zero repeated widgets
        db.delete("pages", "id IN (?,?,?)", arrayOf("pc_studio", "focus", "dash"))

        val cleanPages = listOf(
            // MOBILE GROUP (sort 0..4)
            Triple("home", "Mobile Home", 0 to """[
              {"id":"w1","type":"clock","x":0,"y":0,"w":5,"h":3,"title":"Clock","opts":{"showSeconds":true}},
              {"id":"w2","type":"connect_qr","x":5,"y":0,"w":4,"h":3,"title":"Connect & Pair","opts":{}},
              {"id":"w3","type":"quick_controls","x":9,"y":0,"w":3,"h":3,"title":"Quick Controls","opts":{}},
              {"id":"w4","type":"checklist","x":0,"y":3,"w":4,"h":3,"title":"Daily Tasks","opts":{}},
              {"id":"w5","type":"notes","x":4,"y":3,"w":4,"h":3,"title":"Quick Notes","opts":{}},
              {"id":"w6","type":"sensors","x":8,"y":3,"w":4,"h":3,"title":"Sensors & Signal","opts":{}}
            ]"""),
            Triple("phone_hw", "Mobile Hardware", 1 to """[
              {"id":"pm1","type":"phone_monitor","x":0,"y":0,"w":12,"h":6,"title":"Mobile Hardware","opts":{}}
            ]"""),
            Triple("world_cal", "World & Weather", 2 to """[
              {"id":"wc1","type":"world_strip","x":0,"y":0,"w":12,"h":2,"title":"World Clocks","opts":{}},
              {"id":"wc2","type":"hourly_weather","x":0,"y":2,"w":8,"h":4,"title":"Next Hours","opts":{}},
              {"id":"wc3","type":"calendar_month","x":8,"y":2,"w":4,"h":4,"title":"Calendar","opts":{}}
            ]"""),
            Triple("apps", "Apps & Toolbox", 3 to """[
              {"id":"a1","type":"now_playing","x":0,"y":0,"w":6,"h":3,"title":"Phone Media","opts":{}},
              {"id":"a2","type":"app_dock","x":6,"y":0,"w":6,"h":3,"title":"App Dock","opts":{}},
              {"id":"a3","type":"clipboard","x":0,"y":3,"w":4,"h":3,"title":"Clipboard Vault","opts":{}},
              {"id":"a4","type":"files","x":4,"y":3,"w":4,"h":3,"title":"File Vault","opts":{}},
              {"id":"a5","type":"timer","x":8,"y":3,"w":4,"h":3,"title":"Timers & Focus","opts":{}}
            ]"""),
            Triple("server", "Ops & Automation", 4 to """[
              {"id":"s1","type":"uptime_monitor","x":0,"y":0,"w":4,"h":3,"title":"Uptime Monitor","opts":{}},
              {"id":"s2","type":"metrics_chart","x":4,"y":0,"w":5,"h":3,"title":"Phone History","opts":{"metric":"batteryPct"}},
              {"id":"s3","type":"wol","x":9,"y":0,"w":3,"h":3,"title":"Wake PC","opts":{}},
              {"id":"s4","type":"rules_widget","x":0,"y":3,"w":4,"h":3,"title":"Automation Rules","opts":{}},
              {"id":"s5","type":"inbox","x":4,"y":3,"w":4,"h":3,"title":"Webhook Inbox","opts":{}},
              {"id":"s6","type":"news_feed","x":8,"y":3,"w":4,"h":3,"title":"Tech News","opts":{}}
            ]"""),
            // LAPTOP GROUP (sort 5..12)
            Triple("laptop", "Laptop Hardware", 5 to """[
              {"id":"lm1","type":"laptop_monitor","x":0,"y":0,"w":12,"h":6,"title":"Laptop Hardware","opts":{}}
            ]"""),
            Triple("processes", "Processes & Jobs", 6 to """[
              {"id":"lp1","type":"laptop_processes","x":0,"y":0,"w":12,"h":6,"title":"Processes & Jobs","opts":{}}
            ]"""),
            Triple("pc_music", "Music Studio", 7 to """[
              {"id":"pm1","type":"pc_music_player","x":0,"y":0,"w":7,"h":6,"title":"Now Playing","opts":{}},
              {"id":"pm2","type":"pc_audio_stage","x":7,"y":0,"w":5,"h":6,"title":"3D Audio Devices & Mixer","opts":{}}
            ]"""),
            Triple("pc_deck", "PC Control Deck", 8 to """[
              {"id":"pd1","type":"pc_deck","x":0,"y":0,"w":12,"h":6,"title":"PC App & Control Deck","opts":{}}
            ]"""),
            Triple("pc_remote", "PC Remote & Screen", 9 to """[
              {"id":"pr1","type":"pc_trackpad","x":0,"y":0,"w":6,"h":6,"title":"Trackpad & Keyboard","opts":{}},
              {"id":"pr2","type":"pc_screen","x":6,"y":0,"w":6,"h":6,"title":"Live Screen Peek","opts":{}}
            ]"""),
            Triple("pc_workspace", "Windows & Display", 10 to """[
              {"id":"pw1","type":"pc_display","x":0,"y":0,"w":5,"h":6,"title":"Display, Profiles & Clip","opts":{}},
              {"id":"pw2","type":"pc_windows","x":5,"y":0,"w":7,"h":6,"title":"Open PC Windows","opts":{}}
            ]"""),
            Triple("agy", "Antigravity AI", 11 to """[
              {"id":"ag1","type":"antigravity","x":0,"y":0,"w":7,"h":6,"title":"Antigravity","opts":{}},
              {"id":"ag2","type":"agy_permissions","x":7,"y":0,"w":5,"h":6,"title":"Permission Requests","opts":{}}
            ]"""),
            Triple("code", "Code & Control", 12 to """[
              {"id":"cd1","type":"agy_code","x":0,"y":0,"w":7,"h":6,"title":"Code Diff Preview","opts":{}},
              {"id":"cd2","type":"agy_control","x":7,"y":0,"w":5,"h":6,"title":"Antigravity Control","opts":{}}
            ]""")
        )

        cleanPages.forEach { (id, title, pair) ->
            db.insertWithOnConflict("pages", null, ContentValues().apply {
                put("id", id)
                put("title", title)
                put("sort_order", pair.first)
                put("layout_json", pair.second.trimIndent())
                put("updated_at", now)
            }, SQLiteDatabase.CONFLICT_REPLACE)
        }
    }

    private fun cleanupOpenSourceV13(db: SQLiteDatabase) {
        db.delete("pages", "id IN (?,?,?,?)", arrayOf("pc_studio", "focus", "dash", "feeds"))
        consolidateOpenSourceV12(db)
    }

    private fun seedAgyDefaults(db: SQLiteDatabase) {
        val now = System.currentTimeMillis()
        val agyLayout = """[
          {"id":"ag1","type":"antigravity","x":0,"y":0,"w":7,"h":6,"title":"Antigravity","opts":{}},
          {"id":"ag2","type":"agy_permissions","x":7,"y":0,"w":5,"h":6,"title":"Permission Requests","opts":{}}
        ]""".trimIndent()
        db.insertWithOnConflict("pages", null, ContentValues().apply {
            put("id", "agy")
            put("title", "Antigravity")
            put("sort_order", 5)
            put("layout_json", agyLayout)
            put("updated_at", now)
        }, SQLiteDatabase.CONFLICT_IGNORE)

        val agySettings = mapOf(
            "agy_gate_enabled" to "0",
            "agy_alert_buzz" to "1",
            "auto_keep_ssh" to "1"
        )
        for ((k, v) in agySettings) {
            db.insertWithOnConflict("settings", null, ContentValues().apply {
                put("k", k)
                put("v", v)
            }, SQLiteDatabase.CONFLICT_IGNORE)
        }
    }

    private fun seedDefaults(db: SQLiteDatabase) {
        val now = System.currentTimeMillis()
        val pages = listOf(
            Triple(
                "home",
                "Home",
                """[
                  {"id":"w1","type":"clock","x":0,"y":0,"w":5,"h":3,"title":"Clock","opts":{"showSeconds":true}},
                  {"id":"w2","type":"phone_stats","x":5,"y":0,"w":4,"h":3,"title":"Phone Server","opts":{}},
                  {"id":"w3","type":"weather","x":9,"y":0,"w":3,"h":3,"title":"Weather","opts":{}},
                  {"id":"w4","type":"quick_controls","x":0,"y":3,"w":4,"h":3,"title":"Quick Controls","opts":{}},
                  {"id":"w5","type":"checklist","x":4,"y":3,"w":4,"h":3,"title":"Daily Tasks","opts":{}},
                  {"id":"w6","type":"notes","x":8,"y":3,"w":4,"h":3,"title":"Quick Notes","opts":{}}
                ]"""
            ),
            Triple(
                "server",
                "Server & Ops",
                """[
                  {"id":"s1","type":"uptime_monitor","x":0,"y":0,"w":6,"h":3,"title":"Uptime Monitor","opts":{}},
                  {"id":"s2","type":"metrics_chart","x":6,"y":0,"w":6,"h":3,"title":"Phone History","opts":{"metric":"batteryPct"}},
                  {"id":"s3","type":"sensors","x":0,"y":3,"w":4,"h":3,"title":"Sensors & Signal","opts":{}},
                  {"id":"s4","type":"inbox","x":4,"y":3,"w":5,"h":3,"title":"Webhook Inbox","opts":{}},
                  {"id":"s5","type":"server_qr","x":9,"y":3,"w":3,"h":3,"title":"Admin Studio","opts":{}}
                ]"""
            ),
            Triple(
                "apps",
                "Apps & Media",
                """[
                  {"id":"a1","type":"now_playing","x":0,"y":0,"w":6,"h":3,"title":"Now Playing","opts":{}},
                  {"id":"a2","type":"app_dock","x":6,"y":0,"w":6,"h":3,"title":"App Dock","opts":{}},
                  {"id":"a3","type":"clipboard","x":0,"y":3,"w":4,"h":3,"title":"Clipboard Vault","opts":{}},
                  {"id":"a4","type":"files","x":4,"y":3,"w":5,"h":3,"title":"File Vault","opts":{}},
                  {"id":"a5","type":"wol","x":9,"y":3,"w":3,"h":3,"title":"Wake PC","opts":{}}
                ]"""
            ),
            Triple(
                "focus",
                "Time & Focus",
                """[
                  {"id":"f1","type":"analog","x":0,"y":0,"w":4,"h":3,"title":"Analog Clock","opts":{}},
                  {"id":"f2","type":"world_clock","x":4,"y":0,"w":4,"h":3,"title":"World Clocks","opts":{}},
                  {"id":"f3","type":"time_progress","x":8,"y":0,"w":4,"h":3,"title":"Time Progress","opts":{}},
                  {"id":"f4","type":"pomodoro","x":0,"y":3,"w":6,"h":3,"title":"Pomodoro Timer","opts":{}},
                  {"id":"f5","type":"timer","x":6,"y":3,"w":6,"h":3,"title":"Timers & Stopwatch","opts":{}}
                ]"""
            ),
            Triple(
                "feeds",
                "Feeds & Rules",
                """[
                  {"id":"r1","type":"news_feed","x":0,"y":0,"w":6,"h":6,"title":"News & Hacker News","opts":{}},
                  {"id":"r2","type":"rules_widget","x":6,"y":0,"w":6,"h":3,"title":"Automation Rules","opts":{}},
                  {"id":"r3","type":"push_value","x":6,"y":3,"w":3,"h":3,"title":"Pushed Status","opts":{"key":"status"}},
                  {"id":"r4","type":"counter","x":9,"y":3,"w":3,"h":3,"title":"Tap Counter","opts":{"key":"counter_daily"}}
                ]"""
            )
        )
        pages.forEachIndexed { idx, (id, title, json) ->
            db.insert("pages", null, ContentValues().apply {
                put("id", id)
                put("title", title)
                put("sort_order", idx)
                put("layout_json", json.trimIndent())
                put("updated_at", now)
            })
        }

        val defaultSettings = mapOf(
            "port" to "8765",
            "keep_screen_on" to "1",
            "oled_shift" to "1",
            "pin_enabled" to "0",
            "pin" to "1234",
            "dim_after_sec" to "0",
            "weather_city" to "",
            "weather_lat" to "",
            "weather_lon" to ""
        )
        for ((k, v) in defaultSettings) {
            db.insertWithOnConflict("settings", null, ContentValues().apply {
                put("k", k)
                put("v", v)
            }, SQLiteDatabase.CONFLICT_IGNORE)
        }
    }

    private fun seedV2Defaults(db: SQLiteDatabase) {
        val v2Settings = mapOf(
            "theme" to "glass",
            "accent" to "#2dd4bf",
            "card_radius" to "16",
            "grid_gap" to "8",
            "world_clocks" to "",
            "news_mode" to "hn",
            "rules_paused" to "0"
        )
        for ((k, v) in v2Settings) {
            db.insertWithOnConflict("settings", null, ContentValues().apply {
                put("k", k)
                put("v", v)
            }, SQLiteDatabase.CONFLICT_IGNORE)
        }
    }

    fun getSettings(): JSONObject {
        val obj = JSONObject()
        readableDatabase.rawQuery("SELECT k, v FROM settings", null).use { c ->
            while (c.moveToNext()) obj.put(c.getString(0), c.getString(1))
        }
        return obj
    }

    fun getSetting(key: String, default: String = ""): String {
        readableDatabase.rawQuery("SELECT v FROM settings WHERE k = ?", arrayOf(key)).use { c ->
            return if (c.moveToFirst()) c.getString(0) else default
        }
    }

    fun putSettings(updates: JSONObject) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val keys = updates.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                val v = updates.optString(k, "")
                db.insertWithOnConflict(
                    "settings",
                    null,
                    ContentValues().apply { put("k", k); put("v", v) },
                    SQLiteDatabase.CONFLICT_REPLACE
                )
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun getPages(): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery("SELECT id, title, sort_order, layout_json, updated_at FROM pages ORDER BY sort_order ASC", null).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject().apply {
                    put("id", c.getString(0))
                    put("title", c.getString(1))
                    put("sortOrder", c.getInt(2))
                    put("widgets", JSONArray(c.getString(3)))
                    put("updatedAt", c.getLong(4))
                })
            }
        }
        return arr
    }

    fun replacePages(pages: JSONArray) {
        val db = writableDatabase
        val now = System.currentTimeMillis()
        db.beginTransaction()
        try {
            db.delete("pages", null, null)
            for (i in 0 until pages.length()) {
                val p = pages.getJSONObject(i)
                val id = p.optString("id", "page_${i + 1}").ifBlank { "page_${i + 1}" }
                val title = p.optString("title", "Page ${i + 1}")
                val widgets = p.optJSONArray("widgets") ?: JSONArray()
                db.insert("pages", null, ContentValues().apply {
                    put("id", id)
                    put("title", title)
                    put("sort_order", i)
                    put("layout_json", widgets.toString())
                    put("updated_at", now)
                })
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun putPush(key: String, valueObj: JSONObject, ttlSec: Long = 0) {
        val now = System.currentTimeMillis()
        val exp = if (ttlSec > 0) now + ttlSec * 1000L else 0L
        writableDatabase.insertWithOnConflict(
            "kv_store",
            null,
            ContentValues().apply {
                put("k", key)
                put("value_json", valueObj.toString())
                put("updated_at", now)
                put("expires_at", exp)
            },
            SQLiteDatabase.CONFLICT_REPLACE
        )
        val num = valueObj.optDouble("value", Double.NaN)
        if (!num.isNaN()) {
            recordMetric("push:$key", num)
        }
    }

    fun deletePush(key: String) {
        writableDatabase.delete("kv_store", "k = ?", arrayOf(key))
    }

    fun getPushedMap(): JSONObject {
        val now = System.currentTimeMillis()
        writableDatabase.delete("kv_store", "expires_at > 0 AND expires_at < ?", arrayOf(now.toString()))
        val out = JSONObject()
        readableDatabase.rawQuery("SELECT k, value_json, updated_at, expires_at FROM kv_store ORDER BY updated_at DESC", null).use { c ->
            while (c.moveToNext()) {
                val obj = try { JSONObject(c.getString(1)) } catch (_: Throwable) { JSONObject().put("value", c.getString(1)) }
                obj.put("updatedAt", c.getLong(2))
                obj.put("expiresAt", c.getLong(3))
                out.put(c.getString(0), obj)
            }
        }
        return out
    }

    fun recordMetric(key: String, value: Double, metaJson: String = "{}") {
        val now = System.currentTimeMillis()
        writableDatabase.insert("metrics_history", null, ContentValues().apply {
            put("metric_key", key)
            put("value_num", value)
            put("meta_json", metaJson)
            put("created_at", now)
        })
        if ((now / 1000) % 30 == 0L) {
            val cutoff = now - 24 * 3600 * 1000L
            writableDatabase.delete("metrics_history", "created_at < ?", arrayOf(cutoff.toString()))
        }
    }

    fun getMetricsHistory(key: String, limit: Int = 60): JSONArray {
        val list = mutableListOf<JSONObject>()
        readableDatabase.rawQuery(
            "SELECT value_num, created_at FROM metrics_history WHERE metric_key = ? ORDER BY created_at DESC LIMIT ?",
            arrayOf(key, limit.toString())
        ).use { c ->
            while (c.moveToNext()) {
                list.add(JSONObject().apply {
                    put("v", c.getDouble(0))
                    put("ts", c.getLong(1))
                })
            }
        }
        val arr = JSONArray()
        for (item in list.asReversed()) arr.put(item)
        return arr
    }

    fun getNotes(): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery("SELECT id, title, body, pinned, updated_at FROM notes ORDER BY pinned DESC, updated_at DESC", null).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject().apply {
                    put("id", c.getLong(0))
                    put("title", c.getString(1))
                    put("body", c.getString(2))
                    put("pinned", c.getInt(3) == 1)
                    put("updatedAt", c.getLong(4))
                })
            }
        }
        return arr
    }

    fun upsertNote(id: Long?, title: String, body: String, pinned: Boolean): Long {
        val now = System.currentTimeMillis()
        val cv = ContentValues().apply {
            put("title", title.ifBlank { "Untitled" })
            put("body", body)
            put("pinned", if (pinned) 1 else 0)
            put("updated_at", now)
        }
        return if (id != null && id > 0) {
            writableDatabase.update("notes", cv, "id = ?", arrayOf(id.toString()))
            id
        } else {
            writableDatabase.insert("notes", null, cv)
        }
    }

    fun deleteNote(id: Long) {
        writableDatabase.delete("notes", "id = ?", arrayOf(id.toString()))
    }

    fun getChecklists(): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery("SELECT id, text, done, sort_order, created_at FROM checklists ORDER BY done ASC, sort_order ASC, id DESC", null).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject().apply {
                    put("id", c.getLong(0))
                    put("text", c.getString(1))
                    put("done", c.getInt(2) == 1)
                    put("sortOrder", c.getInt(3))
                    put("createdAt", c.getLong(4))
                })
            }
        }
        return arr
    }

    fun addChecklist(text: String): Long {
        return writableDatabase.insert("checklists", null, ContentValues().apply {
            put("text", text)
            put("done", 0)
            put("sort_order", 0)
            put("created_at", System.currentTimeMillis())
        })
    }

    fun toggleChecklist(id: Long, done: Boolean) {
        writableDatabase.update("checklists", ContentValues().apply { put("done", if (done) 1 else 0) }, "id = ?", arrayOf(id.toString()))
    }

    fun deleteChecklist(id: Long) {
        writableDatabase.delete("checklists", "id = ?", arrayOf(id.toString()))
    }

    fun getMonitors(): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery("SELECT id, name, host, port, last_up, last_latency_ms, last_checked_at FROM monitors ORDER BY id ASC", null).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject().apply {
                    put("id", c.getLong(0))
                    put("name", c.getString(1))
                    put("host", c.getString(2))
                    put("port", c.getInt(3))
                    put("up", c.getInt(4))
                    put("latencyMs", c.getInt(5))
                    put("checkedAt", c.getLong(6))
                })
            }
        }
        return arr
    }

    fun addMonitor(name: String, host: String, port: Int): Long {
        return writableDatabase.insert("monitors", null, ContentValues().apply {
            put("name", name)
            put("host", host)
            put("port", port)
        })
    }

    fun updateMonitorStatus(id: Long, up: Boolean, latencyMs: Int) {
        writableDatabase.update(
            "monitors",
            ContentValues().apply {
                put("last_up", if (up) 1 else 0)
                put("last_latency_ms", latencyMs)
                put("last_checked_at", System.currentTimeMillis())
            },
            "id = ?",
            arrayOf(id.toString())
        )
    }

    fun deleteMonitor(id: Long) {
        writableDatabase.delete("monitors", "id = ?", arrayOf(id.toString()))
    }

    fun getNotifications(limit: Int = 40): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery("SELECT id, title, body, level, source, created_at FROM notifications ORDER BY id DESC LIMIT ?", arrayOf(limit.toString())).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject().apply {
                    put("id", c.getLong(0))
                    put("title", c.getString(1))
                    put("body", c.getString(2))
                    put("level", c.getString(3))
                    put("source", c.getString(4))
                    put("createdAt", c.getLong(5))
                })
            }
        }
        return arr
    }

    fun addNotification(title: String, body: String, level: String = "info", source: String = "webhook"): Long {
        val id = writableDatabase.insert("notifications", null, ContentValues().apply {
            put("title", title)
            put("body", body)
            put("level", level)
            put("source", source)
            put("created_at", System.currentTimeMillis())
        })
        writableDatabase.execSQL("DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT 100)")
        return id
    }

    fun clearNotifications() {
        writableDatabase.delete("notifications", null, null)
    }

    fun getFiles(): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery("SELECT id, filename, mime_type, size_bytes, stored_name, created_at FROM files ORDER BY id DESC", null).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject().apply {
                    put("id", c.getLong(0))
                    put("filename", c.getString(1))
                    put("mimeType", c.getString(2))
                    put("sizeBytes", c.getLong(3))
                    put("storedName", c.getString(4))
                    put("createdAt", c.getLong(5))
                })
            }
        }
        return arr
    }

    fun insertFile(filename: String, mimeType: String, sizeBytes: Long, storedName: String): Long {
        return writableDatabase.insert("files", null, ContentValues().apply {
            put("filename", filename)
            put("mime_type", mimeType)
            put("size_bytes", sizeBytes)
            put("stored_name", storedName)
            put("created_at", System.currentTimeMillis())
        })
    }

    fun findFile(id: Long): Pair<String, String>? {
        readableDatabase.rawQuery("SELECT filename, stored_name FROM files WHERE id = ?", arrayOf(id.toString())).use { c ->
            return if (c.moveToFirst()) c.getString(0) to c.getString(1) else null
        }
    }

    fun deleteFile(id: Long): String? {
        val pair = findFile(id) ?: return null
        writableDatabase.delete("files", "id = ?", arrayOf(id.toString()))
        return pair.second
    }

    fun getWolTargets(): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery("SELECT id, name, mac, broadcast FROM wol_targets ORDER BY id ASC", null).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject().apply {
                    put("id", c.getLong(0))
                    put("name", c.getString(1))
                    put("mac", c.getString(2))
                    put("broadcast", c.getString(3))
                })
            }
        }
        return arr
    }

    fun addWolTarget(name: String, mac: String, broadcast: String): Long {
        return writableDatabase.insert("wol_targets", null, ContentValues().apply {
            put("name", name)
            put("mac", mac)
            put("broadcast", broadcast.ifBlank { "255.255.255.255" })
        })
    }

    fun deleteWolTarget(id: Long) {
        writableDatabase.delete("wol_targets", "id = ?", arrayOf(id.toString()))
    }

    // --- V2: Clipboard History ---
    fun getClipboardHistory(limit: Int = 25): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery("SELECT id, content, source, created_at FROM clipboard_history ORDER BY id DESC LIMIT ?", arrayOf(limit.toString())).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject().apply {
                    put("id", c.getLong(0))
                    put("content", c.getString(1))
                    put("source", c.getString(2))
                    put("createdAt", c.getLong(3))
                })
            }
        }
        return arr
    }

    fun addClipboardItem(content: String, source: String): Long {
        if (content.isBlank()) return -1L
        readableDatabase.rawQuery("SELECT content FROM clipboard_history ORDER BY id DESC LIMIT 1", null).use { c ->
            if (c.moveToFirst() && c.getString(0) == content) return -1L
        }
        val id = writableDatabase.insert("clipboard_history", null, ContentValues().apply {
            put("content", content.take(4096))
            put("source", source)
            put("created_at", System.currentTimeMillis())
        })
        writableDatabase.execSQL("DELETE FROM clipboard_history WHERE id NOT IN (SELECT id FROM clipboard_history ORDER BY id DESC LIMIT 50)")
        return id
    }

    fun deleteClipboardItem(id: Long) {
        writableDatabase.delete("clipboard_history", "id = ?", arrayOf(id.toString()))
    }

    // --- V2: Automation Rules ---
    fun getRules(): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery(
            "SELECT id, name, enabled, trigger_type, trigger_value, action_type, action_value, cooldown_sec, last_fired_at FROM rules ORDER BY id ASC",
            null
        ).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject().apply {
                    put("id", c.getLong(0))
                    put("name", c.getString(1))
                    put("enabled", c.getInt(2) == 1)
                    put("triggerType", c.getString(3))
                    put("triggerValue", c.getString(4))
                    put("actionType", c.getString(5))
                    put("actionValue", c.getString(6))
                    put("cooldownSec", c.getInt(7))
                    put("lastFiredAt", c.getLong(8))
                })
            }
        }
        return arr
    }

    fun addRule(name: String, triggerType: String, triggerValue: String, actionType: String, actionValue: String, cooldownSec: Int): Long {
        return writableDatabase.insert("rules", null, ContentValues().apply {
            put("name", name.ifBlank { "$triggerType -> $actionType" })
            put("enabled", 1)
            put("trigger_type", triggerType)
            put("trigger_value", triggerValue)
            put("action_type", actionType)
            put("action_value", actionValue)
            put("cooldown_sec", cooldownSec.coerceAtLeast(10))
        })
    }

    fun toggleRule(id: Long, enabled: Boolean) {
        writableDatabase.update("rules", ContentValues().apply { put("enabled", if (enabled) 1 else 0) }, "id = ?", arrayOf(id.toString()))
    }

    fun markRuleFired(id: Long) {
        writableDatabase.update("rules", ContentValues().apply { put("last_fired_at", System.currentTimeMillis()) }, "id = ?", arrayOf(id.toString()))
    }

    fun deleteRule(id: Long) {
        writableDatabase.delete("rules", "id = ?", arrayOf(id.toString()))
    }

    // --- V2: App Macros ---
    fun getMacros(): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery("SELECT id, name, steps_json, updated_at FROM macros ORDER BY id DESC", null).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject().apply {
                    put("id", c.getLong(0))
                    put("name", c.getString(1))
                    put("steps", runCatching { JSONArray(c.getString(2)) }.getOrElse { JSONArray() })
                    put("updatedAt", c.getLong(3))
                })
            }
        }
        return arr
    }

    fun addMacro(name: String, steps: JSONArray): Long {
        return writableDatabase.insert("macros", null, ContentValues().apply {
            put("name", name.ifBlank { "Macro" })
            put("steps_json", steps.toString())
            put("updated_at", System.currentTimeMillis())
        })
    }

    fun findMacroSteps(id: Long): JSONArray? {
        readableDatabase.rawQuery("SELECT steps_json FROM macros WHERE id = ?", arrayOf(id.toString())).use { c ->
            return if (c.moveToFirst()) runCatching { JSONArray(c.getString(0)) }.getOrNull() else null
        }
    }

    fun deleteMacro(id: Long) {
        writableDatabase.delete("macros", "id = ?", arrayOf(id.toString()))
    }

    // --- V2: RSS Feeds & App Dock ---
    fun getFeeds(): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery("SELECT id, name, url, enabled FROM rss_feeds ORDER BY id ASC", null).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject().apply {
                    put("id", c.getLong(0))
                    put("name", c.getString(1))
                    put("url", c.getString(2))
                    put("enabled", c.getInt(3) == 1)
                })
            }
        }
        return arr
    }

    fun addFeed(name: String, url: String): Long {
        return writableDatabase.insert("rss_feeds", null, ContentValues().apply {
            put("name", name.ifBlank { url })
            put("url", url)
            put("enabled", 1)
        })
    }

    fun deleteFeed(id: Long) {
        writableDatabase.delete("rss_feeds", "id = ?", arrayOf(id.toString()))
    }

    fun getAppDock(): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery("SELECT pkg, label, sort_order FROM app_dock ORDER BY sort_order ASC, label ASC", null).use { c ->
            while (c.moveToNext()) {
                val pkg = c.getString(0)
                arr.put(JSONObject().apply {
                    put("pkg", pkg)
                    put("label", c.getString(1))
                    put("iconUrl", "/api/apps/icon?pkg=$pkg")
                })
            }
        }
        return arr
    }

    fun pinApp(pkg: String, label: String) {
        writableDatabase.insertWithOnConflict(
            "app_dock",
            null,
            ContentValues().apply {
                put("pkg", pkg)
                put("label", label)
                put("sort_order", 0)
            },
            SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    fun unpinApp(pkg: String) {
        writableDatabase.delete("app_dock", "pkg = ?", arrayOf(pkg))
    }

    // --- Antigravity Sync & Remote Permission Queue ---
    fun saveAgyState(obj: JSONObject) {
        val now = System.currentTimeMillis()
        obj.put("updatedAt", now)
        writableDatabase.insertWithOnConflict(
            "agy_state",
            null,
            ContentValues().apply {
                put("id", 1)
                put("json", obj.toString())
                put("updated_at", now)
            },
            SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    fun getAgyState(): JSONObject {
        readableDatabase.rawQuery("SELECT json, updated_at FROM agy_state WHERE id = 1", null).use { c ->
            if (!c.moveToFirst()) return JSONObject()
            val obj = runCatching { JSONObject(c.getString(0)) }.getOrElse { JSONObject() }
            if (!obj.has("updatedAt")) obj.put("updatedAt", c.getLong(1))
            return obj
        }
    }

    fun enqueueAgyPermission(
        reqKey: String,
        toolName: String,
        target: String,
        detail: String,
        modelName: String,
        conversationId: String,
        kind: String = "approval",
        payloadJson: String = "{}"
    ): JSONObject {
        val now = System.currentTimeMillis()
        val id = writableDatabase.insert("agy_permissions", null, ContentValues().apply {
            put("req_key", reqKey)
            put("tool_name", toolName)
            put("target", target)
            put("detail", detail)
            put("model_name", modelName)
            put("conversation_id", conversationId)
            put("status", "pending")
            put("created_at", now)
            put("resolved_at", 0L)
            put("kind", kind)
            put("payload_json", payloadJson)
            put("response_json", "{}")
        })
        writableDatabase.execSQL("DELETE FROM agy_permissions WHERE id NOT IN (SELECT id FROM agy_permissions ORDER BY id DESC LIMIT 100)")
        return getAgyPermission(id) ?: JSONObject().put("id", id).put("status", "pending").put("kind", kind)
    }

    fun resolveAgyPermission(id: Long, decision: String, responseJson: String = "{}"): Boolean {
        val norm = when (decision) {
            "auto_approve", "auto_proceed", "always_allow", "submit_choice", "allow", "deny", "ask" -> decision
            else -> "ask"
        }
        val rows = writableDatabase.update(
            "agy_permissions",
            ContentValues().apply {
                put("status", norm)
                put("resolved_at", System.currentTimeMillis())
                put("response_json", responseJson)
            },
            "id = ? AND status = 'pending'",
            arrayOf(id.toString())
        )
        return rows > 0
    }

    private fun readAgyPermissionRow(c: android.database.Cursor): JSONObject {
        val payloadStr = c.getString(11)
        val respStr = c.getString(12)
        return JSONObject().apply {
            put("id", c.getLong(0))
            put("reqKey", c.getString(1))
            put("toolName", c.getString(2))
            put("target", c.getString(3))
            put("detail", c.getString(4))
            put("modelName", c.getString(5))
            put("conversationId", c.getString(6))
            put("status", c.getString(7))
            put("createdAt", c.getLong(8))
            put("resolvedAt", c.getLong(9))
            put("kind", c.getString(10))
            put("payload", runCatching { JSONObject(payloadStr) }.getOrElse { JSONObject() })
            put("response", runCatching { JSONObject(respStr) }.getOrElse { JSONObject() })
        }
    }

    fun getAgyPermission(id: Long): JSONObject? {
        readableDatabase.rawQuery(
            "SELECT id, req_key, tool_name, target, detail, model_name, conversation_id, status, created_at, resolved_at, kind, payload_json, response_json FROM agy_permissions WHERE id = ?",
            arrayOf(id.toString())
        ).use { c ->
            if (!c.moveToFirst()) return null
            return readAgyPermissionRow(c)
        }
    }

    fun getAgyPermissions(limit: Int = 20): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery(
            "SELECT id, req_key, tool_name, target, detail, model_name, conversation_id, status, created_at, resolved_at, kind, payload_json, response_json FROM agy_permissions ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, id DESC LIMIT ?",
            arrayOf(limit.toString())
        ).use { c ->
            while (c.moveToNext()) arr.put(readAgyPermissionRow(c))
        }
        return arr
    }

    fun clearResolvedAgyPermissions() {
        writableDatabase.delete("agy_permissions", "status != 'pending'", null)
    }

    fun saveAgyCode(obj: JSONObject) {
        val now = System.currentTimeMillis()
        obj.put("updatedAt", now)
        writableDatabase.insertWithOnConflict(
            "agy_code",
            null,
            ContentValues().apply {
                put("id", 1)
                put("json", obj.toString())
                put("updated_at", now)
            },
            SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    fun getAgyCode(): JSONObject {
        readableDatabase.rawQuery("SELECT json, updated_at FROM agy_code WHERE id = 1", null).use { c ->
            if (!c.moveToFirst()) return JSONObject()
            val obj = runCatching { JSONObject(c.getString(0)) }.getOrElse { JSONObject() }
            if (!obj.has("updatedAt")) obj.put("updatedAt", c.getLong(1))
            return obj
        }
    }

    fun enqueueAgyCommand(command: String, kind: String = "prompt"): JSONObject {
        val now = System.currentTimeMillis()
        val id = writableDatabase.insert("agy_commands", null, ContentValues().apply {
            put("command", command.take(2000))
            put("kind", kind.take(32))
            put("status", "pending")
            put("created_at", now)
            put("delivered_at", 0L)
        })
        writableDatabase.execSQL("DELETE FROM agy_commands WHERE id NOT IN (SELECT id FROM agy_commands ORDER BY id DESC LIMIT 40)")
        return JSONObject().apply {
            put("id", id)
            put("command", command.take(2000))
            put("kind", kind.take(32))
            put("status", "pending")
            put("createdAt", now)
            put("deliveredAt", 0L)
        }
    }

    fun claimPendingAgyCommands(): JSONArray {
        val arr = JSONArray()
        val now = System.currentTimeMillis()
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.rawQuery(
                "SELECT id, command, kind, created_at FROM agy_commands WHERE status = 'pending' ORDER BY id ASC",
                null
            ).use { c ->
                val ids = mutableListOf<String>()
                while (c.moveToNext()) {
                    val id = c.getLong(0)
                    ids.add(id.toString())
                    arr.put(JSONObject().apply {
                        put("id", id)
                        put("command", c.getString(1))
                        put("kind", c.getString(2))
                        put("status", "delivered")
                        put("createdAt", c.getLong(3))
                        put("deliveredAt", now)
                    })
                }
                for (idStr in ids) {
                    db.update(
                        "agy_commands",
                        ContentValues().apply {
                            put("status", "delivered")
                            put("delivered_at", now)
                        },
                        "id = ?",
                        arrayOf(idStr)
                    )
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return arr
    }

    fun getAgyCommands(limit: Int = 20): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery(
            "SELECT id, command, kind, status, created_at, delivered_at FROM agy_commands ORDER BY id DESC LIMIT ?",
            arrayOf(limit.toString())
        ).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject().apply {
                    put("id", c.getLong(0))
                    put("command", c.getString(1))
                    put("kind", c.getString(2))
                    put("status", c.getString(3))
                    put("createdAt", c.getLong(4))
                    put("deliveredAt", c.getLong(5))
                })
            }
        }
        return arr
    }

    fun clearAgyCommands() {
        writableDatabase.delete("agy_commands", null, null)
    }

    fun saveLaptopTelemetry(obj: JSONObject) {
        val now = System.currentTimeMillis()
        obj.put("updatedAt", now)
        writableDatabase.insertWithOnConflict(
            "laptop_state",
            null,
            ContentValues().apply {
                put("id", 1)
                put("json", obj.toString())
                put("updated_at", now)
            },
            SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    fun getLaptopTelemetry(): JSONObject {
        readableDatabase.rawQuery("SELECT json, updated_at FROM laptop_state WHERE id = 1", null).use { c ->
            if (!c.moveToFirst()) return JSONObject()
            val obj = runCatching { JSONObject(c.getString(0)) }.getOrElse { JSONObject() }
            if (!obj.has("updatedAt")) obj.put("updatedAt", c.getLong(1))
            return obj
        }
    }

    fun enqueueLaptopCommand(action: String, payload: JSONObject): JSONObject {
        val now = System.currentTimeMillis()
        val id = writableDatabase.insert("laptop_commands", null, ContentValues().apply {
            put("action", action.take(32))
            put("payload_json", payload.toString())
            put("status", "pending")
            put("created_at", now)
            put("delivered_at", 0L)
        })
        writableDatabase.execSQL("DELETE FROM laptop_commands WHERE id NOT IN (SELECT id FROM laptop_commands ORDER BY id DESC LIMIT 40)")
        return JSONObject().apply {
            put("id", id)
            put("action", action)
            put("payload", payload)
            put("status", "pending")
            put("createdAt", now)
        }
    }

    fun claimPendingLaptopCommands(): JSONArray {
        val arr = JSONArray()
        val now = System.currentTimeMillis()
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.rawQuery(
                "SELECT id, action, payload_json, created_at FROM laptop_commands WHERE status = 'pending' ORDER BY id ASC",
                null
            ).use { c ->
                val ids = mutableListOf<String>()
                while (c.moveToNext()) {
                    val id = c.getLong(0)
                    ids.add(id.toString())
                    val pJson = c.getString(2)
                    arr.put(JSONObject().apply {
                        put("id", id)
                        put("action", c.getString(1))
                        put("payload", runCatching { JSONObject(pJson) }.getOrElse { JSONObject() })
                        put("createdAt", c.getLong(3))
                    })
                }
                for (idStr in ids) {
                    db.update(
                        "laptop_commands",
                        ContentValues().apply {
                            put("status", "delivered")
                            put("delivered_at", now)
                        },
                        "id = ?",
                        arrayOf(idStr)
                    )
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return arr
    }

    fun addPairedDevice(name: String, platform: String, remoteIp: String): JSONObject {
        val id = UUID.randomUUID().toString().replace("-", "").take(12)
        val token = ByteArray(24).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val now = System.currentTimeMillis()
        writableDatabase.insert("paired_devices", null, ContentValues().apply {
            put("id", id)
            put("name", name.take(80).ifBlank { "Laptop" })
            put("platform", platform.take(32).ifBlank { "windows" })
            put("device_token", token)
            put("paired_at", now)
            put("last_seen_at", now)
            put("remote_ip", remoteIp.take(64))
        })
        return JSONObject().apply {
            put("id", id)
            put("name", name)
            put("platform", platform)
            put("token", token)
            put("pairedAt", now)
        }
    }

    fun getPairedDevices(): JSONArray {
        val arr = JSONArray()
        readableDatabase.rawQuery(
            "SELECT id, name, platform, paired_at, last_seen_at, remote_ip FROM paired_devices ORDER BY paired_at DESC",
            null
        ).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject().apply {
                    put("id", c.getString(0))
                    put("name", c.getString(1))
                    put("platform", c.getString(2))
                    put("pairedAt", c.getLong(3))
                    put("lastSeenAt", c.getLong(4))
                    put("remoteIp", c.getString(5))
                })
            }
        }
        return arr
    }

    fun getPairedCount(): Int {
        readableDatabase.rawQuery("SELECT COUNT(*) FROM paired_devices", null).use { c ->
            return if (c.moveToFirst()) c.getInt(0) else 0
        }
    }

    fun verifyPairedToken(token: String, remoteIp: String): Boolean {
        if (token.isBlank()) return false
        readableDatabase.rawQuery("SELECT id, last_seen_at FROM paired_devices WHERE device_token = ?", arrayOf(token)).use { c ->
            if (!c.moveToFirst()) return false
            val id = c.getString(0)
            val lastSeen = c.getLong(1)
            val now = System.currentTimeMillis()
            if (now - lastSeen > 25_000L) {
                runCatching {
                    writableDatabase.update(
                        "paired_devices",
                        ContentValues().apply {
                            put("last_seen_at", now)
                            if (remoteIp.isNotBlank()) put("remote_ip", remoteIp.take(64))
                        },
                        "id = ?",
                        arrayOf(id)
                    )
                }
            }
            return true
        }
    }

    fun revokePairedDevice(id: String): Boolean {
        return writableDatabase.delete("paired_devices", "id = ?", arrayOf(id)) > 0
    }

    fun getPairedTokenById(id: String): String? {
        if (id.isBlank()) return null
        readableDatabase.rawQuery("SELECT device_token FROM paired_devices WHERE id = ?", arrayOf(id)).use { c ->
            return if (c.moveToFirst()) c.getString(0) else null
        }
    }

    fun getDbSummary(): JSONObject {
        val tables = listOf(
            "pages", "kv_store", "metrics_history", "notes", "checklists",
            "monitors", "notifications", "files", "wol_targets", "settings",
            "clipboard_history", "rules", "macros", "rss_feeds", "app_dock",
            "agy_state", "agy_permissions", "agy_code", "agy_commands",
            "laptop_state", "laptop_commands", "paired_devices"
        )
        val counts = JSONObject()
        for (t in tables) {
            readableDatabase.rawQuery("SELECT COUNT(*) FROM $t", null).use { c ->
                counts.put(t, if (c.moveToFirst()) c.getLong(0) else 0L)
            }
        }
        return JSONObject().apply {
            put("dbName", "phonebox_server.db")
            put("journalMode", "WAL")
            put("tables", counts)
        }
    }
}
