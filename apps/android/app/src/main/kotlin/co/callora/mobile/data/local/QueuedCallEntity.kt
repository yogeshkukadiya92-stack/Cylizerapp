package co.callora.mobile.data.local

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

enum class QueueStatus {
    PENDING,
    IN_FLIGHT,
    RETRY,
    SYNCED,
    REJECTED,
}

@Entity(
    tableName = "queued_calls",
    indices = [
        Index(value = ["status", "availableAtEpochMillis"]),
        Index(value = ["startedAtEpochMillis"]),
    ],
)
data class QueuedCallEntity(
    @PrimaryKey val localId: String,
    val nativeCallId: String?,
    val simCardId: String?,
    /** AES-GCM envelope; plaintext numbers are never persisted in Room. */
    val encryptedPhoneNumber: String,
    /** AES-GCM envelope; populated only when the call-log row exposes a cached name. */
    val encryptedContactName: String?,
    val direction: String,
    val disposition: String,
    val startedAtEpochMillis: Long,
    val answeredAtEpochMillis: Long?,
    val endedAtEpochMillis: Long?,
    val durationSeconds: Long,
    val ringDurationSeconds: Long?,
    val isInternal: Boolean,
    val nativeLastModifiedAtEpochMillis: Long?,
    val status: QueueStatus = QueueStatus.PENDING,
    val attemptCount: Int = 0,
    val availableAtEpochMillis: Long = 0,
    val createdAtEpochMillis: Long,
)

data class QueueCounts(
    val pending: Int,
    val retrying: Int,
    val rejected: Int,
)

