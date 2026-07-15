package co.callora.mobile.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface LeadMutationDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(item: LeadMutationEntity): Long

    @Query(
        """
        SELECT * FROM lead_mutations
        WHERE status IN ('PENDING', 'RETRY') AND availableAtEpochMillis <= :nowEpochMillis
        ORDER BY createdAtEpochMillis, requestId
        LIMIT :limit
        """,
    )
    suspend fun due(nowEpochMillis: Long, limit: Int): List<LeadMutationEntity>

    @Query(
        """
        SELECT * FROM lead_mutations
        WHERE activeLeadKey = :activeLeadKey AND status IN ('PENDING', 'IN_FLIGHT', 'RETRY')
        LIMIT 1
        """,
    )
    suspend fun active(activeLeadKey: String): LeadMutationEntity?

    @Query(
        """
        UPDATE lead_mutations
        SET status = 'IN_FLIGHT', updatedAtEpochMillis = :updatedAtEpochMillis, lastErrorCode = NULL
        WHERE requestId = :requestId AND status IN ('PENDING', 'RETRY')
        """,
    )
    suspend fun markInFlight(requestId: String, updatedAtEpochMillis: Long): Int

    @Query(
        """
        UPDATE lead_mutations
        SET status = 'SYNCED', activeLeadKey = NULL, updatedAtEpochMillis = :updatedAtEpochMillis,
            lastErrorCode = NULL
        WHERE requestId = :requestId AND status = 'IN_FLIGHT'
        """,
    )
    suspend fun markSynced(requestId: String, updatedAtEpochMillis: Long): Int

    @Query(
        """
        UPDATE lead_mutations
        SET status = 'RETRY', attemptCount = attemptCount + 1,
            availableAtEpochMillis = :availableAtEpochMillis,
            updatedAtEpochMillis = :updatedAtEpochMillis, lastErrorCode = :errorCode
        WHERE requestId = :requestId AND status = 'IN_FLIGHT'
        """,
    )
    suspend fun scheduleRetry(
        requestId: String,
        availableAtEpochMillis: Long,
        updatedAtEpochMillis: Long,
        errorCode: String,
    ): Int

    @Query(
        """
        UPDATE lead_mutations
        SET status = 'CONFLICT', activeLeadKey = NULL, updatedAtEpochMillis = :updatedAtEpochMillis,
            lastErrorCode = :errorCode
        WHERE requestId = :requestId AND status = 'IN_FLIGHT'
        """,
    )
    suspend fun markConflict(requestId: String, updatedAtEpochMillis: Long, errorCode: String): Int

    @Query(
        """
        UPDATE lead_mutations
        SET status = 'REJECTED', activeLeadKey = NULL, updatedAtEpochMillis = :updatedAtEpochMillis,
            lastErrorCode = :errorCode
        WHERE requestId = :requestId AND status IN ('PENDING', 'IN_FLIGHT', 'RETRY')
        """,
    )
    suspend fun markRejected(requestId: String, updatedAtEpochMillis: Long, errorCode: String): Int

    @Query(
        """
        UPDATE lead_mutations
        SET status = 'RETRY', attemptCount = attemptCount + 1,
            availableAtEpochMillis = :availableAtEpochMillis,
            updatedAtEpochMillis = :updatedAtEpochMillis, lastErrorCode = 'PROCESS_INTERRUPTED'
        WHERE status = 'IN_FLIGHT'
        """,
    )
    suspend fun recoverInterrupted(availableAtEpochMillis: Long, updatedAtEpochMillis: Long): Int

    @Query("DELETE FROM lead_mutations WHERE leadId = :leadId AND status IN ('CONFLICT', 'REJECTED')")
    suspend fun deleteTerminalForLead(leadId: String): Int

    @Query("DELETE FROM lead_mutations WHERE status = 'SYNCED' AND updatedAtEpochMillis < :olderThanEpochMillis")
    suspend fun pruneSynced(olderThanEpochMillis: Long): Int

    @Query(
        """
        SELECT leadId, status FROM lead_mutations
        WHERE status IN ('PENDING', 'IN_FLIGHT', 'RETRY', 'CONFLICT', 'REJECTED')
        ORDER BY createdAtEpochMillis, requestId
        """,
    )
    fun observeOutstanding(): Flow<List<LeadMutationStateRow>>
}
