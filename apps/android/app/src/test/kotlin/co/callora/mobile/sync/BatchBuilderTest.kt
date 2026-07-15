package co.callora.mobile.sync

import co.callora.mobile.core.model.DeviceCredentials
import co.callora.mobile.data.local.QueueStatus
import co.callora.mobile.data.local.QueuedCallEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BatchBuilderTest {
    private val credentials = DeviceCredentials(
        organizationId = "org-1",
        employeeId = "employee-1",
        deviceId = "device-1",
        sessionToken = "session-secret",
        expiresAt = "2026-07-22T00:00:00Z",
    )

    @Test
    fun `batch is bounded deterministic and omits SIM identity`() {
        val builder = BatchBuilder(
            decryptPhone = { it.encryptedPhoneNumber },
            decryptContact = { it.encryptedContactName },
            collectionMode = "synthetic_demo",
        )
        val candidates = (0 until 125).map(::entity)
        val first = requireNotNull(builder.build(candidates, credentials, "cursor-1"))
        val retry = requireNotNull(builder.build(candidates, credentials, "cursor-1"))

        assertEquals(100, first.items.size)
        assertEquals(first.batchId, retry.batchId)
        assertEquals(first, retry)
        assertEquals("synthetic_demo", first.collectionMode)
        first.items.forEach { assertNull(it.simCardId) }
    }

    @Test
    fun `different cursor creates a different idempotency boundary`() {
        val builder = BatchBuilder(
            decryptPhone = { it.encryptedPhoneNumber },
            decryptContact = { null },
            collectionMode = "android_call_log",
        )
        val item = listOf(entity(1))
        val first = requireNotNull(builder.build(item, credentials, "a"))
        val second = requireNotNull(builder.build(item, credentials, "b"))
        org.junit.Assert.assertNotEquals(first.batchId, second.batchId)
    }

    private fun entity(index: Int) = QueuedCallEntity(
        localId = "call-${index.toString().padStart(3, '0')}",
        nativeCallId = "native-$index",
        simCardId = "must-not-sync",
        encryptedPhoneNumber = "+91987654${index.toString().padStart(4, '0')}",
        encryptedContactName = "Demo $index",
        direction = "incoming",
        disposition = "answered",
        startedAtEpochMillis = 1_700_000_000_000 + index,
        answeredAtEpochMillis = null,
        endedAtEpochMillis = 1_700_000_001_000 + index,
        durationSeconds = 1,
        ringDurationSeconds = null,
        isInternal = false,
        nativeLastModifiedAtEpochMillis = null,
        status = QueueStatus.PENDING,
        createdAtEpochMillis = 1_700_000_000_000,
    )
}
