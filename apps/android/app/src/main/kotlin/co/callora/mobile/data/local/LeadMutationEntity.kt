package co.callora.mobile.data.local

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

enum class LeadMutationStatus {
    PENDING,
    IN_FLIGHT,
    RETRY,
    SYNCED,
    CONFLICT,
    REJECTED,
}

@Entity(
    tableName = "lead_mutations",
    indices = [
        Index(value = ["status", "availableAtEpochMillis", "createdAtEpochMillis"]),
        Index(value = ["organizationId", "employeeId", "leadId", "status"]),
        Index(value = ["activeLeadKey"], unique = true),
    ],
)
data class LeadMutationEntity(
    @PrimaryKey val requestId: String,
    val organizationId: String,
    val employeeId: String,
    val deviceId: String,
    val leadId: String,
    /** Non-null only while the command is active, enforcing one immutable command per lead. */
    val activeLeadKey: String?,
    /** AES-GCM envelope containing the exact immutable replay command. */
    val encryptedCommand: String,
    val status: LeadMutationStatus = LeadMutationStatus.PENDING,
    val attemptCount: Int = 0,
    val availableAtEpochMillis: Long = 0,
    val createdAtEpochMillis: Long,
    val updatedAtEpochMillis: Long,
    val lastErrorCode: String? = null,
)
data class LeadMutationStateRow(
    val leadId: String,
    val status: LeadMutationStatus,
)

data class LeadMutationQueueState(
    val pendingLeadIds: Set<String> = emptySet(),
    val conflictedLeadIds: Set<String> = emptySet(),
    val rejectedLeadIds: Set<String> = emptySet(),
)
