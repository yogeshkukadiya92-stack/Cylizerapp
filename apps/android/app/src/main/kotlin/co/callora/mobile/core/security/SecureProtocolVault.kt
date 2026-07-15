package co.callora.mobile.core.security

import android.content.Context
import android.content.SharedPreferences
import co.callora.mobile.core.protocol.MobileProtocolState
import co.callora.mobile.core.protocol.MobileProtocolStateCodec

interface ProtocolVault {
    fun read(): MobileProtocolState
    fun write(state: MobileProtocolState)
    fun clear(destroyKey: Boolean = false)
}

class SecureProtocolVault(context: Context) : ProtocolVault {
    private val preferences: SharedPreferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val keys = AndroidKeystoreKeyProvider(AndroidKeystoreKeyProvider.PROTOCOL_ALIAS)
    private val cipher = AesGcmCodec(keys::getOrCreate)

    override fun read(): MobileProtocolState {
        val encoded = preferences.getString(KEY_ENVELOPE, null) ?: return MobileProtocolState()
        val plaintext = cipher.decrypt(CipherEnvelope.decode(encoded), AAD)
        return MobileProtocolStateCodec.decode(plaintext)
    }

    override fun write(state: MobileProtocolState) {
        val encrypted = cipher.encrypt(MobileProtocolStateCodec.encode(state), AAD).encode()
        check(preferences.edit().putString(KEY_ENVELOPE, encrypted).commit()) {
            "Unable to persist mobile protocol state"
        }
    }

    override fun clear(destroyKey: Boolean) {
        val removed = preferences.edit().remove(KEY_ENVELOPE).commit()
        if (destroyKey) keys.delete()
        check(removed) { "Unable to clear mobile protocol state" }
    }

    private companion object {
        const val PREFS = "callora_secure_protocol"
        const val KEY_ENVELOPE = "mobile_protocol_envelope"
        val AAD = "callora.mobile.protocol.v1".toByteArray(Charsets.UTF_8)
    }
}
