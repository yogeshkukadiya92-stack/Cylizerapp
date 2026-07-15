package co.callora.mobile.data.local

import co.callora.mobile.core.model.DeviceCredentials
import co.callora.mobile.core.security.EncryptedFieldCodec
import co.callora.mobile.data.api.LeadUpdateCommand
import co.callora.mobile.data.api.LeadUpdateDraft
import co.callora.mobile.data.api.LeadUpdateValidator
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

interface LeadMutationStore {
    suspend fun due(nowEpochMillis: Long, limit: Int): List<LeadMutationEntity>
    suspend fun markInFlight(requestId: String, at: Long): Int
    suspend fun markSynced(requestId: String, at: Long): Int
    suspend fun scheduleRetry(requestId: String, availableAt: Long, at: Long, errorCode: String): Int
    suspend fun markConflict(requestId: String, at: Long, errorCode: String): Int
    suspend fun markRejected(requestId: String, at: Long, errorCode: String): Int
    suspend fun recoverInterrupted(at: Long): Int
    suspend fun pruneSynced(olderThan: Long): Int
    fun decode(entity: LeadMutationEntity): LeadUpdateCommand
}

sealed interface LeadMutationEnqueueResult {
    data class Queued(val requestId: String) : LeadMutationEnqueueResult
    data class AlreadyPending(val requestId: String) : LeadMutationEnqueueResult
}

class LeadMutationRepository(
    private val dao: LeadMutationDao,
    private val fields: EncryptedFieldCodec,
    private val now: () -> Long = System::currentTimeMillis,
    private val newRequestId: () -> String = { UUID.randomUUID().toString() },
) : LeadMutationStore {
    suspend fun enqueue(
        credentials: DeviceCredentials,
        draft: LeadUpdateDraft,
    ): LeadMutationEnqueueResult {
        val normalized = LeadUpdateValidator.normalized(draft)
        val activeLeadKey = listOf(credentials.organizationId, credentials.employeeId, normalized.leadId)
            .joinToString(":")
        dao.active(activeLeadKey)?.let { return LeadMutationEnqueueResult.AlreadyPending(it.requestId) }
        dao.deleteTerminalForLead(normalized.leadId)
        val requestId = newRequestId()
        val createdAt = now()
        val command = LeadUpdateCommand(
            requestId = requestId,
            leadId = normalized.leadId,
            expectedLeadVersion = normalized.expectedLeadVersion,
            occurredAt = Instant.ofEpochMilli(createdAt).toString(),
            statusId = normalized.statusId,
            noteBody = normalized.noteBody,
            followUp = normalized.followUp,
        )
        val inserted = dao.insert(
            LeadMutationEntity(
                requestId = requestId,
                organizationId = credentials.organizationId,
                employeeId = credentials.employeeId,
                deviceId = credentials.deviceId,
                leadId = normalized.leadId,
                activeLeadKey = activeLeadKey,
                encryptedCommand = fields.encrypt(
                    LeadMutationPayloadCodec.encode(command),
                    requestId,
                    FIELD_COMMAND,
                ),
                createdAtEpochMillis = createdAt,
                updatedAtEpochMillis = createdAt,
            ),
        )
        if (inserted != -1L) return LeadMutationEnqueueResult.Queued(requestId)
        val existing = dao.active(activeLeadKey)
        return LeadMutationEnqueueResult.AlreadyPending(existing?.requestId ?: requestId)
    }

    fun observeQueueState(): Flow<LeadMutationQueueState> = dao.observeOutstanding().map { rows ->
        LeadMutationQueueState(
            pendingLeadIds = rows.filter { it.status in ACTIVE_STATUSES }.mapTo(linkedSetOf()) { it.leadId },
            conflictedLeadIds = rows.filter { it.status == LeadMutationStatus.CONFLICT }
                .mapTo(linkedSetOf()) { it.leadId },
            rejectedLeadIds = rows.filter { it.status == LeadMutationStatus.REJECTED }
                .mapTo(linkedSetOf()) { it.leadId },
        )
    }

    override suspend fun due(nowEpochMillis: Long, limit: Int): List<LeadMutationEntity> =
        dao.due(nowEpochMillis, limit.coerceIn(1, 25))

    override suspend fun markInFlight(requestId: String, at: Long): Int = dao.markInFlight(requestId, at)
    override suspend fun markSynced(requestId: String, at: Long): Int = dao.markSynced(requestId, at)
    override suspend fun scheduleRetry(
        requestId: String,
        availableAt: Long,
        at: Long,
        errorCode: String,
    ): Int = dao.scheduleRetry(requestId, availableAt, at, errorCode.take(100))

    override suspend fun markConflict(requestId: String, at: Long, errorCode: String): Int =
        dao.markConflict(requestId, at, errorCode.take(100))

    override suspend fun markRejected(requestId: String, at: Long, errorCode: String): Int =
        dao.markRejected(requestId, at, errorCode.take(100))

    override suspend fun recoverInterrupted(at: Long): Int = dao.recoverInterrupted(at, at)
    override suspend fun pruneSynced(olderThan: Long): Int = dao.pruneSynced(olderThan)

    override fun decode(entity: LeadMutationEntity): LeadUpdateCommand = LeadMutationPayloadCodec.decode(
        fields.decrypt(entity.encryptedCommand, entity.requestId, FIELD_COMMAND),
    ).also { command ->
        require(command.requestId == entity.requestId && command.leadId == entity.leadId) {
            "Lead mutation identity mismatch"
        }
    }

    companion object {
        const val FIELD_COMMAND = "lead_update_command"
        private val ACTIVE_STATUSES = setOf(
            LeadMutationStatus.PENDING,
            LeadMutationStatus.IN_FLIGHT,
            LeadMutationStatus.RETRY,
        )
    }
}
