package co.callora.mobile.core.security

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/** Non-reversible, truncated correlation ID for diagnosing credential hand-off failures. */
object CredentialDiagnostics {
    fun correlationId(token: String): String = MessageDigest.getInstance("SHA-256")
        .digest(token.toByteArray(StandardCharsets.UTF_8))
        .take(8)
        .joinToString("") { byte -> "%02x".format(byte) }
}
