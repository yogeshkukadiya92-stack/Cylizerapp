package co.callora.mobile

import android.content.Context
import co.callora.mobile.calls.CallLogSource
import co.callora.mobile.calls.VariantCallLogSourceFactory
import co.callora.mobile.core.security.EncryptedFieldCodec
import co.callora.mobile.core.security.AndroidKeystoreKeyProvider
import co.callora.mobile.core.security.MobileCredentialGenerator
import co.callora.mobile.core.security.SecureCredentialVault
import co.callora.mobile.core.security.SecureProtocolVault
import co.callora.mobile.data.api.HttpMobileApi
import co.callora.mobile.data.api.MobileApi
import co.callora.mobile.data.local.CallQueueRepository
import co.callora.mobile.data.local.CalloraDatabase
import co.callora.mobile.data.local.LeadMutationRepository
import co.callora.mobile.data.preferences.AppPreferences
import co.callora.mobile.sync.BatchBuilder
import co.callora.mobile.sync.LeadMutationProcessor
import kotlinx.coroutines.sync.Mutex

class AppContainer(context: Context) {
    /** Serializes queue/source ownership with destructive consent and identity transitions. */
    val collectionMutex = Mutex()
    val preferences = AppPreferences(context)
    val credentialVault = SecureCredentialVault(context)
    val protocolVault = SecureProtocolVault(context)
    val credentialGenerator = MobileCredentialGenerator()
    val database = CalloraDatabase.create(context)
    val fieldCipher = EncryptedFieldCodec()
    val leadMutationCipher = EncryptedFieldCodec(
        alias = AndroidKeystoreKeyProvider.LEAD_MUTATION_ALIAS,
        namespace = "callora.lead-mutation.v1",
    )
    val queue = CallQueueRepository(
        dao = database.queuedCalls(),
        preferences = preferences,
        fields = fieldCipher,
    )
    val source: CallLogSource = VariantCallLogSourceFactory.create(context) {
        preferences.disclosureAccepted && !preferences.consentStale && !preferences.revoked
    }
    val api: MobileApi = HttpMobileApi { preferences.apiBaseUrl }
    val leadMutations = LeadMutationRepository(
        dao = database.leadMutations(),
        fields = leadMutationCipher,
    )
    val leadMutationProcessor = LeadMutationProcessor(
        store = leadMutations,
        sender = { credentials, command -> api.submitLeadUpdate(credentials, command) },
    )
    val batchBuilder = BatchBuilder(
        decryptPhone = queue::decryptPhone,
        decryptContact = queue::decryptContact,
        collectionMode = BuildConfig.COLLECTION_MODE,
    )

    /** Crypto-erase all queued PII first, then secure-delete rows, truncate WAL, and compact pages. */
    fun purgeLocalCallData() {
        // Destroying the field key first keeps the purge fail-closed even if a later
        // storage-maintenance operation is interrupted.
        fieldCipher.destroyKey()
        leadMutationCipher.destroyKey()
        database.clearAllTables()
        val sqlite = database.openHelper.writableDatabase
        sqlite.query("PRAGMA wal_checkpoint(TRUNCATE)").close()
        sqlite.execSQL("VACUUM")
    }
}
