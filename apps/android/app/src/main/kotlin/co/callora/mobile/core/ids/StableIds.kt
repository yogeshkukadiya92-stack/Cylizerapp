package co.callora.mobile.core.ids

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Locale

object StableIds {
    fun installationId(seed: String): String = digest("installation|$seed")

    fun callLocalId(
        installationId: String,
        nativeCallId: String?,
        startedAtEpochMillis: Long,
        direction: String,
        phoneNumber: String,
    ): String {
        val normalizedNumberDigest = digest(normalizePhone(phoneNumber))
        val sourceIdentity = nativeCallId?.trim()?.takeIf(String::isNotEmpty)
            ?: "$startedAtEpochMillis|${direction.lowercase(Locale.ROOT)}|$normalizedNumberDigest"
        return "call_${digest("v1|$installationId|$sourceIdentity").take(40)}"
    }

    fun batchId(deviceId: String, previousCursor: String?, orderedLocalIds: List<String>): String {
        require(orderedLocalIds.isNotEmpty()) { "A batch needs at least one local ID" }
        val canonical = buildString {
            append("v1|")
            append(deviceId)
            append('|')
            append(previousCursor.orEmpty())
            orderedLocalIds.forEach { append('|').append(it) }
        }
        return "batch_${digest(canonical).take(40)}"
    }

    fun requestId(scope: String, stableParts: List<String>): String =
        "req_${digest((listOf("v1", scope) + stableParts).joinToString("|")).take(40)}"

    fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(StandardCharsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

    private fun normalizePhone(value: String): String = value.filter { it.isDigit() || it == '+' }
}

