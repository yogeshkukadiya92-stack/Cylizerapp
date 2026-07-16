package co.callora.mobile.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction

@Dao
interface QueuedCallDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(items: List<QueuedCallEntity>): List<Long>

    @Transaction
    suspend fun insertAtomically(items: List<QueuedCallEntity>): List<Long> = insertAll(items)

    @Query(
        """
        SELECT * FROM queued_calls
        WHERE status IN ('PENDING', 'RETRY') AND availableAtEpochMillis <= :nowEpochMillis
        ORDER BY startedAtEpochMillis ASC, localId ASC
        LIMIT :limit
        """,
    )
    suspend fun due(nowEpochMillis: Long, limit: Int): List<QueuedCallEntity>

    @Query("UPDATE queued_calls SET status = 'IN_FLIGHT' WHERE localId IN (:localIds) AND status IN ('PENDING', 'RETRY')")
    suspend fun markInFlight(localIds: List<String>): Int

    @Query("UPDATE queued_calls SET status = 'SYNCED' WHERE localId IN (:localIds) AND status = 'IN_FLIGHT'")
    suspend fun markSynced(localIds: List<String>): Int

    @Query("UPDATE queued_calls SET status = 'REJECTED' WHERE localId IN (:localIds) AND status = 'IN_FLIGHT'")
    suspend fun markRejected(localIds: List<String>): Int

    @Query(
        """
        UPDATE queued_calls
        SET status = 'RETRY', attemptCount = attemptCount + 1,
            availableAtEpochMillis = :availableAtEpochMillis
        WHERE localId IN (:localIds) AND status = 'IN_FLIGHT'
        """,
    )
    suspend fun scheduleRetry(localIds: List<String>, availableAtEpochMillis: Long): Int

    @Query("UPDATE queued_calls SET status = 'PENDING' WHERE status = 'IN_FLIGHT'")
    suspend fun recoverInterruptedBatches(): Int

    @Query("DELETE FROM queued_calls WHERE status = 'SYNCED' AND createdAtEpochMillis < :olderThanEpochMillis")
    suspend fun pruneSynced(olderThanEpochMillis: Long): Int

    @Query("SELECT COUNT(*) FROM queued_calls WHERE status IN ('PENDING', 'IN_FLIGHT')")
    suspend fun pendingCount(): Int

    @Query("SELECT COUNT(*) FROM queued_calls WHERE status = 'RETRY'")
    suspend fun retryCount(): Int

    @Query("SELECT COUNT(*) FROM queued_calls WHERE status = 'REJECTED'")
    suspend fun rejectedCount(): Int

    @Query("SELECT * FROM queued_calls ORDER BY startedAtEpochMillis DESC, localId DESC LIMIT :limit")
    suspend fun recent(limit: Int): List<QueuedCallEntity>

    @Query("DELETE FROM queued_calls")
    suspend fun clearAll()
}
