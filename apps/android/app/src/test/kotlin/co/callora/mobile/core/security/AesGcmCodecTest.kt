package co.callora.mobile.core.security

import co.callora.mobile.core.model.DeviceCredentials
import javax.crypto.AEADBadTagException
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AesGcmCodecTest {
    private val key = SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES")

    @Test
    fun `payload encrypts and round trips with associated data`() {
        val codec = AesGcmCodec({ key })
        val plaintext = "session credential value".toByteArray()
        val aad = "row-1|credential".toByteArray()
        val envelope = codec.encrypt(plaintext, aad)
        val secondEnvelope = codec.encrypt(plaintext, aad)

        assertNotEquals(String(plaintext), String(envelope.ciphertext))
        assertEquals(AesGcmCodec.IV_BYTES, envelope.iv.size)
        assertNotEquals(envelope.iv.toList(), secondEnvelope.iv.toList())
        assertArrayEquals(plaintext, codec.decrypt(CipherEnvelope.decode(envelope.encode()), aad))
        assertThrows(AEADBadTagException::class.java) {
            codec.decrypt(envelope, "row-2|credential".toByteArray())
        }
    }

    @Test
    fun `credential codec persists one session token and no bootstrap token`() {
        val value = DeviceCredentials("org", "employee", "device", "opaque-session", "2026-07-22T00:00:00Z")
        val encoded = CredentialCodec.encode(value)
        assertEquals(value, CredentialCodec.decode(encoded))
        assertEquals(5, encoded.split('.').size)
    }
}
