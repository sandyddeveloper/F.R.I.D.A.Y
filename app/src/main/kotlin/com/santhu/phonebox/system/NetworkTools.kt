package com.santhu.phonebox.system

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket

object NetworkTools {

    data class PingResult(val up: Boolean, val latencyMs: Int)

    fun checkHost(host: String, port: Int, timeoutMs: Int = 2000): PingResult {
        val start = System.nanoTime()
        return try {
            if (port > 0) {
                Socket().use { socket ->
                    socket.connect(InetSocketAddress(host, port), timeoutMs)
                }
                val ms = ((System.nanoTime() - start) / 1_000_000L).toInt().coerceAtLeast(1)
                PingResult(true, ms)
            } else {
                val reachable = InetAddress.getByName(host).isReachable(timeoutMs)
                val ms = ((System.nanoTime() - start) / 1_000_000L).toInt().coerceAtLeast(1)
                PingResult(reachable, if (reachable) ms else -1)
            }
        } catch (_: Throwable) {
            PingResult(false, -1)
        }
    }

    fun sendWakeOnLan(macAddress: String, broadcastIp: String = "255.255.255.255"): Result<String> {
        return try {
            val clean = macAddress.trim().replace(":", "").replace("-", "").replace(".", "")
            require(clean.length == 12 && clean.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) {
                "Invalid MAC address: $macAddress"
            }
            val macBytes = ByteArray(6) { i ->
                clean.substring(i * 2, i * 2 + 2).toInt(16).toByte()
            }
            val packetBytes = ByteArray(6 + 16 * 6)
            for (i in 0 until 6) packetBytes[i] = 0xFF.toByte()
            for (i in 0 until 16) {
                System.arraycopy(macBytes, 0, packetBytes, 6 + i * 6, 6)
            }

            val targets = buildSet {
                add(broadcastIp.ifBlank { "255.255.255.255" })
                add("255.255.255.255")
            }
            DatagramSocket().use { socket ->
                socket.broadcast = true
                for (ip in targets) {
                    val addr = InetAddress.getByName(ip)
                    socket.send(DatagramPacket(packetBytes, packetBytes.size, addr, 9))
                }
            }
            Result.success("Magic packet sent to $macAddress")
        } catch (t: Throwable) {
            Result.failure(t)
        }
    }
}
