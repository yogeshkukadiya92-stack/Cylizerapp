package co.callora.mobile.core.security

import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class CipherEnvelope(
    val version: Int,
    val iv: ByteArray,
    val ciphertext: ByteArray,
) {
    fun encode(): String {
        val encoder = Base64.getUrlEncoder().withoutPadding()
        return listOf(
            version.toString(),
            encoder.encodeToString(iv),
            encoder.encodeToString(ciphertext),
        ).joinToString(".")
    }

    companion object {
        fun decode(encoded: String): CipherEnvelope {
            val parts = encoded.split('.')
            require(parts.size == 3) { "Invalid encrypted envelope" }
            val version = parts[0].toIntOrNull() ?: error("Invalid encrypted envelope version")
            require(version == 1) { "Unsupported encrypted envelope version" }
            val decoder = Base64.getUrlDecoder()
            val iv = decoder.decode(parts[1])
            val ciphertext = decoder.decode(parts[2])
            require(iv.size == AesGcmCodec.IV_BYTES) { "Invalid AES-GCM IV" }
            require(ciphertext.size >= AesGcmCodec.TAG_BYTES) { "Invalid AES-GCM ciphertext" }
            return CipherEnvelope(version, iv, ciphertext)
        }
    }

    override fun equals(other: Any?): Boolean = other is CipherEnvelope &&
        version == other.version && iv.contentEquals(other.iv) && ciphertext.contentEquals(other.ciphertext)

    override fun hashCode(): Int = 31 * (31 * version + iv.contentHashCode()) + ciphertext.contentHashCode()
}

class AesGcmCodec(
    private val keyProvider: () -> SecretKey,
) {
    fun encrypt(plaintext: ByteArray, associatedData: ByteArray): CipherEnvelope {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        // Android Keystore keys with randomized encryption required reject a
        // caller-provided IV. Let the provider generate its CSPRNG IV, then store
        // that public nonce alongside the authenticated ciphertext.
        cipher.init(Cipher.ENCRYPT_MODE, keyProvider())
        val iv = cipher.iv
        require(iv.size == IV_BYTES) { "Unexpected AES-GCM IV size" }
        cipher.updateAAD(associatedData)
        return CipherEnvelope(1, iv, cipher.doFinal(plaintext))
    }

    fun decrypt(envelope: CipherEnvelope, associatedData: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, keyProvider(), GCMParameterSpec(TAG_BITS, envelope.iv))
        cipher.updateAAD(associatedData)
        return cipher.doFinal(envelope.ciphertext)
    }

    companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
        const val TAG_BYTES = TAG_BITS / 8
    }
}
