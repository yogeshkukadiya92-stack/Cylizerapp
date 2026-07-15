package co.callora.mobile.sync

import co.callora.mobile.core.model.DeviceCredentials
import co.callora.mobile.data.api.LeadUpdateCommand
import co.callora.mobile.data.api.LeadUpdateReceipt
import co.callora.mobile.data.api.MobileApiException
import co.callora.mobile.data.local.LeadMutationEntity
import co.callora.mobile.data.local.LeadMutationStatus
import co.callora.mobile.data.local.LeadMutationStore
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LeadMutationProcessorTest {
    private val credentials = DeviceCredentials(
        organizationId = "org-1",
        employeeId = "employee-1",
        deviceId = "device-1",
        sessionToken = "cls_token",
        expiresAt = "2026-07-16T00:00:00Z",
    )

    @Test
    fun `successful command is marked synced with the same request id`() = runBlocking {
        val store = FakeStore(entity(), command())
        val processor = LeadMutationProcessor(store, LeadMutationSender { _, value ->
            LeadUpdateReceipt(value.requestId, replayed = false, appliedLeadVersion = 5)
        }) { 10_000L }

        val result = processor.run(credentials)

        assertEquals(1, result.synced)
        assertTrue(store.synced)
        assertFalse(store.retried)
    }

    @Test
    fun `retryable server response keeps immutable command for replay`() = runBlocking {
        val store = FakeStore(entity(), command())
        val processor = LeadMutationProcessor(store, LeadMutationSender { _, _ ->
            throw MobileApiException(503, "TEMPORARILY_UNAVAILABLE", retryable = true)
        }) { 20_000L }

        val result = processor.run(credentials)

        assertEquals(1, result.retrying)
        assertTrue(store.retried)
        assertEquals("TEMPORARILY_UNAVAILABLE", store.errorCode)
        assertFalse(store.synced)
    }

    @Test
    fun `conflict is terminal and visible instead of silently rebased`() = runBlocking {
        val store = FakeStore(entity(), command())
        val processor = LeadMutationProcessor(store, LeadMutationSender { _, _ ->
            throw MobileApiException(409, "LEAD_VERSION_CONFLICT", retryable = false)
        }) { 30_000L }

        val result = processor.run(credentials)

        assertEquals(1, result.conflicts)
        assertTrue(store.conflicted)
        assertFalse(store.retried)
    }

    @Test
    fun `consent failure stops the lane and requests fail closed transition`() = runBlocking {
        val store = FakeStore(entity(), command())
        val processor = LeadMutationProcessor(store, LeadMutationSender { _, _ ->
            throw MobileApiException(403, "CONSENT_REQUIRED", retryable = false)
        }) { 40_000L }

        val result = processor.run(credentials)

        assertEquals(LeadMutationSecurityAction.REQUIRE_CONSENT, result.securityAction)
        assertTrue(store.retried)
    }

    @Test
    fun `another enrollment can never replay a queued command`() = runBlocking {
        var sent = false
        val store = FakeStore(entity().copy(deviceId = "other-device"), command())
        val processor = LeadMutationProcessor(store, LeadMutationSender { _, value ->
            sent = true
            LeadUpdateReceipt(value.requestId, false, 5)
        }) { 50_000L }

        val result = processor.run(credentials)

        assertEquals(1, result.rejected)
        assertFalse(sent)
        assertTrue(store.rejected)
        assertEquals("IDENTITY_MISMATCH", store.errorCode)
    }

    private fun entity() = LeadMutationEntity(
        requestId = "request-1",
        organizationId = "org-1",
        employeeId = "employee-1",
        deviceId = "device-1",
        leadId = "lead-1",
        activeLeadKey = "org-1:employee-1:lead-1",
        encryptedCommand = "encrypted",
        createdAtEpochMillis = 1,
        updatedAtEpochMillis = 1,
    )

    private fun command() = LeadUpdateCommand(
        requestId = "request-1",
        leadId = "lead-1",
        expectedLeadVersion = 4,
        occurredAt = "2026-07-15T12:30:00Z",
        noteBody = "Call completed",
    )

    private class FakeStore(
        private val entity: LeadMutationEntity,
        private val command: LeadUpdateCommand,
    ) : LeadMutationStore {
        var synced = false
        var retried = false
        var conflicted = false
        var rejected = false
        var errorCode: String? = null
        private var inFlight = false

        override suspend fun due(nowEpochMillis: Long, limit: Int): List<LeadMutationEntity> = listOf(entity)

        override suspend fun markInFlight(requestId: String, at: Long): Int {
            inFlight = true
            return 1
        }

        override suspend fun markSynced(requestId: String, at: Long): Int {
            check(inFlight)
            synced = true
            return 1
        }

        override suspend fun scheduleRetry(
            requestId: String,
            availableAt: Long,
            at: Long,
            errorCode: String,
        ): Int {
            retried = true
            this.errorCode = errorCode
            return 1
        }

        override suspend fun markConflict(requestId: String, at: Long, errorCode: String): Int {
            conflicted = true
            this.errorCode = errorCode
            return 1
        }

        override suspend fun markRejected(requestId: String, at: Long, errorCode: String): Int {
            rejected = true
            this.errorCode = errorCode
            return 1
        }

        override suspend fun recoverInterrupted(at: Long): Int = 0
        override suspend fun pruneSynced(olderThan: Long): Int = 0
        override fun decode(entity: LeadMutationEntity): LeadUpdateCommand = command
    }
}
