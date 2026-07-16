package co.callora.mobile.data.local

import co.callora.mobile.core.ids.StableIds
import co.callora.mobile.core.model.ObservedCall
import co.callora.mobile.core.security.EncryptedFieldCodec
import co.callora.mobile.data.preferences.AppPreferences

class CallQueueRepository(
    private val dao: QueuedCallDao,
    private val preferences: AppPreferences,
    private val fields: EncryptedFieldCodec,
    private val now: () -> Long = System::currentTimeMillis,
) {
    suspend fun enqueue(observed: List<ObservedCall>): QueueEnqueueResult {
        val installationId = preferences.installationId
        val createdAt = now()
        val entities = observed.mapNotNull { call ->
            val normalizedPhone = normalizeE164(call.phoneNumber) ?: return@mapNotNull null
            val localId = StableIds.callLocalId(
                installationId = installationId,
                nativeCallId = call.nativeCallId,
                startedAtEpochMillis = call.startedAtEpochMillis,
                direction = call.direction.wireName,
                phoneNumber = normalizedPhone,
            )
            QueuedCallEntity(
                localId = localId,
                nativeCallId = call.nativeCallId,
                // The mobile alpha does not collect or persist SIM/account identity.
                simCardId = null,
                encryptedPhoneNumber = fields.encrypt(normalizedPhone, localId, FIELD_PHONE),
                encryptedContactName = call.contactName
                    ?.trim()
                    ?.take(160)
                    ?.takeIf(String::isNotEmpty)
                    ?.let { fields.encrypt(it, localId, FIELD_CONTACT) },
                direction = call.direction.wireName,
                disposition = call.disposition.wireName,
                startedAtEpochMillis = call.startedAtEpochMillis,
                answeredAtEpochMillis = call.answeredAtEpochMillis,
                endedAtEpochMillis = call.endedAtEpochMillis,
                durationSeconds = call.durationSeconds.coerceIn(0, MAX_DURATION_SECONDS),
                ringDurationSeconds = call.ringDurationSeconds?.coerceIn(0, MAX_RING_SECONDS),
                isInternal = call.isInternal,
                nativeLastModifiedAtEpochMillis = call.nativeLastModifiedAtEpochMillis,
                createdAtEpochMillis = createdAt,
            )
        }
        if (entities.isEmpty()) return QueueEnqueueResult(0, observed.size)
        val inserted = dao.insertAtomically(entities).count { it != -1L }
        return QueueEnqueueResult(inserted, observed.size - entities.size)
    }

    suspend fun counts(): QueueCounts = QueueCounts(
        pending = dao.pendingCount(),
        retrying = dao.retryCount(),
        rejected = dao.rejectedCount(),
    )

    suspend fun recent(limit: Int = 200): List<LocalCallItem> = dao.recent(limit.coerceIn(1, 500)).map { entity ->
        LocalCallItem(
            id = entity.localId,
            phoneNumber = decryptPhone(entity),
            contactName = decryptContact(entity),
            direction = entity.direction,
            disposition = entity.disposition,
            startedAtEpochMillis = entity.startedAtEpochMillis,
            durationSeconds = entity.durationSeconds,
            status = entity.status,
        )
    }

    fun decryptPhone(entity: QueuedCallEntity): String =
        fields.decrypt(entity.encryptedPhoneNumber, entity.localId, FIELD_PHONE)

    fun decryptContact(entity: QueuedCallEntity): String? = entity.encryptedContactName?.let {
        fields.decrypt(it, entity.localId, FIELD_CONTACT)
    }

    companion object {
        const val FIELD_PHONE = "phone"
        const val FIELD_CONTACT = "contact"
        private const val MAX_DURATION_SECONDS = 7 * 86_400L
        private const val MAX_RING_SECONDS = 86_400L

        fun normalizeE164(value: String): String? {
            val normalized = value.trim().replace(Regex("[ ()-]"), "")
            return normalized.takeIf { E164.matches(it) }
        }

        private val E164 = Regex("^\\+[1-9][0-9]{7,14}$")
    }
}

data class QueueEnqueueResult(
    val inserted: Int,
    val skippedInvalid: Int,
)

data class LocalCallItem(
    val id: String,
    val phoneNumber: String,
    val contactName: String?,
    val direction: String,
    val disposition: String,
    val startedAtEpochMillis: Long,
    val durationSeconds: Long,
    val status: QueueStatus,
)
