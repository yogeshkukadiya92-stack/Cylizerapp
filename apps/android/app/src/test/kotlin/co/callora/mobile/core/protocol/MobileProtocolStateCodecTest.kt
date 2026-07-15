package co.callora.mobile.core.protocol

import co.callora.mobile.core.model.DeviceCredentials
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.yield

class MobileProtocolStateCodecTest {
    private val policy = AuthoritativePolicyDocument(
        id = "policy_android_2026_07",
        contentHash = "a".repeat(64),
        policyVersion = "2026-07",
        disclosureVersion = "call-metadata-v2",
        collectionMode = "android_call_log",
        purpose = "call_metadata",
        title = "Business call metadata",
        summary = "Exact organization-approved summary.",
        disclosures = listOf("First exact disclosure.", "બીજું exact disclosure."),
        effectiveAt = "2026-07-15T00:00:00Z",
    )

    @Test
    fun `pending activation journal round trips without losing replay identity`() {
        val state = MobileProtocolState(
            phase = ProtocolPhase.ACTIVATION_PENDING,
            requestId = "f4cbe9e0-80d6-4ca0-8d29-4346ef9d6d20",
            installationId = "installation",
            proposedBootstrapToken = "clb_${"b".repeat(43)}",
            bootstrapOrganizationId = "org",
            bootstrapEmployeeId = "employee",
            bootstrapDeviceId = "device",
            bootstrapExpiresAt = "2026-07-15T00:10:00Z",
            policy = policy,
            proposedSessionToken = "cls_${"c".repeat(43)}",
            collectionStartsAtEpochMillis = 1_752_537_600_000,
            consent = ConsentReceipt(
                policyId = policy.id,
                contentHash = policy.contentHash,
                acceptedAt = "2026-07-15T00:00:01Z",
                locale = "gu-IN",
            ),
        )

        assertEquals(state, MobileProtocolStateCodec.decode(MobileProtocolStateCodec.encode(state)))
    }

    @Test
    fun `rotation and revocation credential snapshot round trips`() {
        val state = MobileProtocolState(
            phase = ProtocolPhase.ROTATION_CONFIRM_PENDING,
            requestId = "8f66106d-b5a9-44bc-b709-d2a0c9881ae9",
            prepareRequestId = "91749a48-f3e0-4166-a6a5-9467650ae833",
            proposedSessionToken = "cls_${"d".repeat(43)}",
            proposedSessionExpiresAt = "2026-07-22T00:00:00Z",
            preparedAt = "2026-07-15T00:00:00Z",
            policy = policy,
            operationCredentials = DeviceCredentials(
                "org",
                "employee",
                "device",
                "cls_${"e".repeat(43)}",
                "2026-07-22T00:00:00Z",
            ),
        )
        assertEquals(state, MobileProtocolStateCodec.decode(MobileProtocolStateCodec.encode(state)))
    }

    @Test
    fun `codec rejects truncated journal`() {
        val encoded = MobileProtocolStateCodec.encode(MobileProtocolState(phase = ProtocolPhase.REDEEM_PENDING))
        assertThrows(Exception::class.java) {
            MobileProtocolStateCodec.decode(encoded.copyOf(encoded.size - 1))
        }
    }

    @Test
    fun `valid session with missing accepted policy journal requires fail-closed recovery`() {
        assertEquals(
            true,
            ProtocolRecoveryPlanner.requiresAuthoritativePolicyFetch(MobileProtocolState(), true),
        )
        assertEquals(
            false,
            ProtocolRecoveryPlanner.requiresAuthoritativePolicyFetch(
                MobileProtocolState(
                    phase = ProtocolPhase.IDLE,
                    policy = policy,
                    consent = ConsentReceipt(
                        policy.id,
                        policy.contentHash,
                        "2026-07-15T00:00:01Z",
                        "en-IN",
                    ),
                ),
                true,
            ),
        )
        assertEquals(
            false,
            ProtocolRecoveryPlanner.requiresAuthoritativePolicyFetch(MobileProtocolState(), false),
        )
    }

    @Test
    fun `confirmed rotation requires immediate policy preflight`() {
        assertEquals(
            true,
            ProtocolRecoveryPlanner.requiresImmediatePreflightAfter(ProtocolPhase.ROTATION_CONFIRM_PENDING),
        )
        assertEquals(
            false,
            ProtocolRecoveryPlanner.requiresImmediatePreflightAfter(ProtocolPhase.ROTATION_PREPARE_PENDING),
        )
    }

    @Test
    fun `activation replay opens gate only after current policy exact match`() {
        val receipt = ConsentReceipt(policy.id, policy.contentHash, "2026-07-15T00:00:01Z", "en-IN")
        assertFalse(ProtocolRecoveryPlanner.requiresReconsentAfterActivation(receipt, policy))
        assertTrue(
            ProtocolRecoveryPlanner.requiresReconsentAfterActivation(
                receipt,
                policy.copy(contentHash = "b".repeat(64)),
            ),
        )
    }

    @Test
    fun `rotation drains collector and commits pending journal before releasing mutex`() = runBlocking {
        val collectionMutex = Mutex(locked = true)
        var journalCommitted = false
        var commitObservedLockedMutex = false
        val rotation = launch {
            RotationConcurrencyGate.drainAndCommit(collectionMutex) {
                commitObservedLockedMutex = collectionMutex.isLocked
                journalCommitted = true
            }
        }

        yield()
        assertFalse(journalCommitted)
        collectionMutex.unlock()
        rotation.join()
        assertTrue(journalCommitted)
        assertTrue(commitObservedLockedMutex)
        assertFalse(collectionMutex.isLocked)
    }

    @Test
    fun `consent race transitions stale UI mutations to authoritative policy fetch`() {
        assertEquals(
            ProtocolPhase.ACTIVATION_POLICY_PENDING,
            ProtocolRecoveryPlanner.consentRequiredTargetPhase(ProtocolPhase.ACTIVATION_PENDING),
        )
        assertEquals(
            ProtocolPhase.RECONSENT_POLICY_PENDING,
            ProtocolRecoveryPlanner.consentRequiredTargetPhase(ProtocolPhase.RECONSENT_PENDING),
        )
        assertEquals(
            ProtocolPhase.RECONSENT_POLICY_PENDING,
            ProtocolRecoveryPlanner.consentRequiredTargetPhase(ProtocolPhase.ROTATION_PREPARE_PENDING),
        )
        assertEquals(
            null,
            ProtocolRecoveryPlanner.consentRequiredTargetPhase(ProtocolPhase.ROTATION_CONFIRM_PENDING),
        )
    }

    @Test
    fun `revocation finalization repairs cleared journal and local-only pending state`() {
        assertEquals(
            true,
            ProtocolRecoveryPlanner.canFinalizeLocalRevocation(
                revocationPending = true,
                state = MobileProtocolState(),
                hasActiveCredential = false,
            ),
        )
        assertEquals(
            true,
            ProtocolRecoveryPlanner.canFinalizeLocalRevocation(
                revocationPending = false,
                state = MobileProtocolState(phase = ProtocolPhase.REVOKE_PENDING),
                hasActiveCredential = false,
            ),
        )
        assertEquals(
            false,
            ProtocolRecoveryPlanner.canFinalizeLocalRevocation(
                revocationPending = false,
                state = MobileProtocolState(),
                hasActiveCredential = false,
            ),
        )
        assertEquals(
            false,
            ProtocolRecoveryPlanner.canFinalizeLocalRevocation(
                revocationPending = true,
                state = MobileProtocolState(
                    phase = ProtocolPhase.REVOKE_PENDING,
                    operationCredentials = DeviceCredentials(
                        "org",
                        "employee",
                        "device",
                        "cls_${"f".repeat(43)}",
                        "2026-07-22T00:00:00Z",
                    ),
                ),
                hasActiveCredential = false,
            ),
        )
    }

    @Test
    fun `worker crash after credential erase requires startup queue purge`() {
        // revokeLocally writes the durable pending flag before erasing the vault.
        // A crash at that boundary leaves no credential and an IDLE journal.
        assertEquals(
            true,
            ProtocolRecoveryPlanner.requiresLocalRevocationPurge(
                revocationPending = true,
                state = MobileProtocolState(),
                hasActiveCredential = false,
            ),
        )
        assertEquals(
            true,
            ProtocolRecoveryPlanner.requiresLocalRevocationPurge(
                revocationPending = true,
                state = MobileProtocolState(),
                hasActiveCredential = true,
            ),
        )
    }
}
