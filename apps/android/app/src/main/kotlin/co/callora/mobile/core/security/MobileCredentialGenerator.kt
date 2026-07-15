package co.callora.mobile.core.security

import java.security.SecureRandom
import java.util.Base64

/** Generates client-owned credentials that the API stores only as keyed digests. */
class MobileCredentialGenerator(
    private val secureRandom: SecureRandom = SecureRandom(),
) {
    fun bootstrap(): String = token(BOOTSTRAP_PREFIX)

    fun session(): String = token(SESSION_PREFIX)

    private fun token(prefix: String): String {
        val entropy = ByteArray(ENTROPY_BYTES)
        secureRandom.nextBytes(entropy)
        return prefix + Base64.getUrlEncoder().withoutPadding().encodeToString(entropy)
    }

    companion object {
        const val ENTROPY_BYTES = 32
        const val ENCODED_ENTROPY_LENGTH = 43
        const val BOOTSTRAP_PREFIX = "clb_"
        const val SESSION_PREFIX = "cls_"
    }
}
