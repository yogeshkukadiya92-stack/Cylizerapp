package co.callora.mobile.sync

import co.callora.mobile.core.ids.StableIds
import co.callora.mobile.core.model.CallDirection
import co.callora.mobile.core.model.CallDisposition
import co.callora.mobile.core.model.CallSyncBatch
import co.callora.mobile.core.model.CallSyncItem
import co.callora.mobile.core.model.DeviceCredentials
import co.callora.mobile.data.local.QueuedCallEntity
import java.time.Instant

data class BatchPolicy(
    val maxItems: Int = 100,
    val maxEstimatedBytes: Int = 256 * 1_024,
) {
    init {
        require(maxItems in 1..100) { "Server contract permits at most 100 call items" }
        require(maxEstimatedBytes >= 8_192) { "Batch byte budget is too small" }
    }
}

class BatchBuilder(
    private val decryptPhone: (QueuedCallEntity) -> String,
    private val decryptContact: (QueuedCallEntity) -> String?,
    private val collectionMode: String,
    private val policy: BatchPolicy = BatchPolicy(),
) {
    init {
        require(collectionMode == "android_call_log" || collectionMode == "synthetic_demo") {
            "Unsupported collection mode"
        }
    }

    fun build(
        candidates: List<QueuedCallEntity>,
        credentials: DeviceCredentials,
        previousCursor: String?,
    ): CallSyncBatch? {
        if (candidates.isEmpty()) return null
        val selected = mutableListOf<CallSyncItem>()
        var persistedBatchTimestamp = Long.MIN_VALUE
        var estimatedBytes = BASE_BATCH_BYTES
        for (entity in candidates.sortedWith(compareBy(QueuedCallEntity::startedAtEpochMillis, QueuedCallEntity::localId))) {
            if (selected.size >= policy.maxItems) break
            val item = entity.toSyncItem()
            val itemBytes = estimateBytes(item)
            if (selected.isNotEmpty() && estimatedBytes + itemBytes > policy.maxEstimatedBytes) break
            require(itemBytes <= policy.maxEstimatedBytes) { "A single call item exceeds the batch byte budget" }
            selected += item
            persistedBatchTimestamp = maxOf(persistedBatchTimestamp, entity.createdAtEpochMillis)
            estimatedBytes += itemBytes
        }
        if (selected.isEmpty()) return null
        val localIds = selected.map(CallSyncItem::localId)
        return CallSyncBatch(
            batchId = StableIds.batchId(credentials.deviceId, previousCursor, localIds),
            collectionMode = collectionMode,
            organizationId = credentials.organizationId,
            employeeId = credentials.employeeId,
            deviceId = credentials.deviceId,
            // Stable across process death/retry so the same batchId always hashes to one payload.
            sentAt = Instant.ofEpochMilli(persistedBatchTimestamp).toString(),
            previousCursor = previousCursor,
            items = selected,
        )
    }

    private fun QueuedCallEntity.toSyncItem(): CallSyncItem = CallSyncItem(
        localId = localId,
        nativeCallId = nativeCallId,
        // The mobile API intentionally rejects SIM identity in this collection contract.
        simCardId = null,
        phoneNumber = decryptPhone(this),
        contactName = decryptContact(this),
        direction = CallDirection.entries.first { it.wireName == direction },
        disposition = CallDisposition.entries.first { it.wireName == disposition },
        startedAt = Instant.ofEpochMilli(startedAtEpochMillis).toString(),
        answeredAt = answeredAtEpochMillis?.let { Instant.ofEpochMilli(it).toString() },
        endedAt = endedAtEpochMillis?.let { Instant.ofEpochMilli(it).toString() },
        durationSeconds = durationSeconds,
        ringDurationSeconds = ringDurationSeconds,
        isInternal = isInternal,
        nativeLastModifiedAt = nativeLastModifiedAtEpochMillis?.let { Instant.ofEpochMilli(it).toString() },
    )

    private fun estimateBytes(item: CallSyncItem): Int {
        val strings = listOfNotNull(
            item.localId,
            item.nativeCallId,
            item.simCardId,
            item.phoneNumber,
            item.contactName,
            item.startedAt,
            item.answeredAt,
            item.endedAt,
            item.nativeLastModifiedAt,
        )
        return ITEM_OVERHEAD_BYTES + strings.sumOf { it.toByteArray(Charsets.UTF_8).size }
    }

    private companion object {
        const val BASE_BATCH_BYTES = 512
        const val ITEM_OVERHEAD_BYTES = 384
    }
}
