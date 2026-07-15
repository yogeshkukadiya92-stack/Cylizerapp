package co.callora.mobile.core.logging

import android.util.Log

object SafeLog {
    private val bearer = Regex("(?i)bearer\\s+[A-Za-z0-9._~+\\-/]+=*")
    private val tokenAssignment = Regex(
        "(?i)((?:access|refresh|session|bootstrap|device)[_-]?(?:token|credential)|token|pairing[_-]?code|authorization)\\s*[:=]\\s*[^,;\\s]+",
    )
    private val phone = Regex("(?<![A-Za-z0-9])\\+?[0-9][0-9 ()-]{6,}[0-9]")

    fun redact(message: String): String = message
        .replace(bearer, "Bearer [REDACTED]")
        .replace(tokenAssignment) { "${it.groupValues[1]}=[REDACTED]" }
        .replace(phone, "[PHONE_REDACTED]")
        .take(MAX_MESSAGE_LENGTH)

    fun info(tag: String, message: String) {
        Log.i(tag, redact(message))
    }

    fun warn(tag: String, message: String, throwable: Throwable? = null) {
        Log.w(tag, redact(message), throwable?.let { SanitizedThrowable(it) })
    }

    private class SanitizedThrowable(source: Throwable) : RuntimeException(
        source::class.java.simpleName + ": " + redact(source.message.orEmpty()),
    )

    private const val MAX_MESSAGE_LENGTH = 2_000
}
