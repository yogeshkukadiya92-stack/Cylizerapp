package co.callora.mobile.core.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

class AndroidKeystoreKeyProvider(private val alias: String) {
    private val keyStore: KeyStore by lazy {
        KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
    }

    @Synchronized
    fun getOrCreate(): SecretKey {
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    fun delete() {
        if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
    }

    companion object {
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        const val CREDENTIAL_ALIAS = "callora_device_credentials_v1"
        const val PROTOCOL_ALIAS = "callora_mobile_protocol_v1"
        const val FIELD_ALIAS = "callora_call_fields_v1"
    }
}
