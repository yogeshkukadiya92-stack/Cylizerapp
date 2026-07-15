package co.callora.mobile.core.security

import android.content.Context
import android.content.SharedPreferences
import co.callora.mobile.core.model.DeviceCredentials
import java.nio.charset.StandardCharsets
import java.util.Base64

interface CredentialVault {
    fun read(): DeviceCredentials?
    fun write(credentials: DeviceCredentials)
    fun clear(destroyKey: Boolean = false)
}

class SecureCredentialVault(context: Context) : CredentialVault {
    private val preferences: SharedPreferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val keys = AndroidKeystoreKeyProvider(AndroidKeystoreKeyProvider.CREDENTIAL_ALIAS)
    private val cipher = AesGcmCodec(keys::getOrCreate)

    override fun read(): DeviceCredentials? {
        val encoded = preferences.getString(KEY_ENVELOPE, null) ?: return null
        return runCatching {
            val plaintext = cipher.decrypt(CipherEnvelope.decode(encoded), AAD)
            CredentialCodec.decode(String(plaintext, StandardCharsets.UTF_8))
        }.getOrNull()
    }

    override fun write(credentials: DeviceCredentials) {
        val plaintext = CredentialCodec.encode(credentials).toByteArray(StandardCharsets.UTF_8)
        val encrypted = cipher.encrypt(plaintext, AAD).encode()
        check(preferences.edit().putString(KEY_ENVELOPE, encrypted).commit()) {
            "Unable to persist device credentials"
        }
    }

    override fun clear(destroyKey: Boolean) {
        val envelopeRemoved = preferences.edit().remove(KEY_ENVELOPE).commit()
        // Crypto-erasure must not depend on a successful preference-file rewrite.
        if (destroyKey) keys.delete()
        check(envelopeRemoved) { "Unable to clear device credentials" }
    }

    private companion object {
        const val PREFS = "callora_secure_vault"
        const val KEY_ENVELOPE = "device_credential_envelope"
        val AAD = "callora.device.credentials.v1".toByteArray(StandardCharsets.UTF_8)
    }
}

object CredentialCodec {
    fun encode(value: DeviceCredentials): String = listOf(
        value.organizationId,
        value.employeeId,
        value.deviceId,
        value.sessionToken,
        value.expiresAt,
    ).joinToString(".") { Base64.getUrlEncoder().withoutPadding().encodeToString(it.toByteArray()) }

    fun decode(value: String): DeviceCredentials {
        val parts = value.split('.')
        require(parts.size == 5) { "Invalid credential payload" }
        val decoded = parts.map { String(Base64.getUrlDecoder().decode(it), StandardCharsets.UTF_8) }
        return DeviceCredentials(
            organizationId = decoded[0],
            employeeId = decoded[1],
            deviceId = decoded[2],
            sessionToken = decoded[3],
            expiresAt = decoded[4],
        )
    }
}

class EncryptedFieldCodec {
    private val keys = AndroidKeystoreKeyProvider(AndroidKeystoreKeyProvider.FIELD_ALIAS)
    private val cipher = AesGcmCodec(keys::getOrCreate)

    fun encrypt(value: String, localId: String, fieldName: String): String = cipher.encrypt(
        value.toByteArray(StandardCharsets.UTF_8),
        aad(localId, fieldName),
    ).encode()

    fun decrypt(value: String, localId: String, fieldName: String): String = String(
        cipher.decrypt(CipherEnvelope.decode(value), aad(localId, fieldName)),
        StandardCharsets.UTF_8,
    )

    fun destroyKey() = keys.delete()

    private fun aad(localId: String, fieldName: String): ByteArray =
        "callora.queue.v1|$localId|$fieldName".toByteArray(StandardCharsets.UTF_8)
}
