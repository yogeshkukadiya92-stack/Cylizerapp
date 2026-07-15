package co.callora.mobile.core.protocol

import co.callora.mobile.core.model.DeviceCredentials
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class AuthoritativePolicyDocument(
    val id: String,
    /** Opaque server SHA-256 identifier; the presentation JSON is not re-hashed on-device. */
    val contentHash: String,
    val policyVersion: String,
    val disclosureVersion: String,
    val collectionMode: String,
    val purpose: String,
    val title: String,
    val summary: String,
    val disclosures: List<String>,
    val effectiveAt: String,
)

data class ConsentReceipt(
    val policyId: String,
    val contentHash: String,
    val acceptedAt: String,
    val locale: String?,
)

enum class ProtocolPhase {
    IDLE,
    REDEEM_PENDING,
    DISCLOSURE_READY,
    ACTIVATION_PENDING,
    ACTIVATION_POLICY_PENDING,
    RECONSENT_POLICY_PENDING,
    RECONSENT_READY,
    RECONSENT_PENDING,
    ROTATION_PREPARE_PENDING,
    ROTATION_CONFIRM_PENDING,
    REVOKE_PENDING,
}

/**
 * One encrypted, crash-safe protocol journal. Every client secret and request UUID is committed
 * before its first network use, so a lost response is reconciled by replaying the exact request.
 */
data class MobileProtocolState(
    val phase: ProtocolPhase = ProtocolPhase.IDLE,
    val requestId: String? = null,
    /** Rotation-confirm binding to the separately idempotent prepare mutation. */
    val prepareRequestId: String? = null,
    val installationId: String? = null,
    val pairingCode: String? = null,
    val proposedBootstrapToken: String? = null,
    val bootstrapOrganizationId: String? = null,
    val bootstrapEmployeeId: String? = null,
    val bootstrapDeviceId: String? = null,
    val bootstrapExpiresAt: String? = null,
    val policy: AuthoritativePolicyDocument? = null,
    val expectedPolicyId: String? = null,
    val expectedPolicyHash: String? = null,
    val proposedSessionToken: String? = null,
    val proposedSessionExpiresAt: String? = null,
    val preparedAt: String? = null,
    /** Durable lower bound for collection; never moved earlier during replay. */
    val collectionStartsAtEpochMillis: Long? = null,
    val consent: ConsentReceipt? = null,
    /** Snapshot used only by retryable rotation, re-consent, or revocation. */
    val operationCredentials: DeviceCredentials? = null,
) {
    val hasPendingMutation: Boolean
        get() = phase in setOf(
            ProtocolPhase.REDEEM_PENDING,
            ProtocolPhase.ACTIVATION_PENDING,
            ProtocolPhase.ACTIVATION_POLICY_PENDING,
            ProtocolPhase.RECONSENT_PENDING,
            ProtocolPhase.ROTATION_PREPARE_PENDING,
            ProtocolPhase.ROTATION_CONFIRM_PENDING,
            ProtocolPhase.REVOKE_PENDING,
        )

    fun requirePolicy(): AuthoritativePolicyDocument = checkNotNull(policy) {
        "Authoritative policy is not available"
    }
}

/** JVM-testable binary codec; encryption and authenticated storage are handled by the vault. */
object MobileProtocolStateCodec {
    private const val VERSION = 2
    private const val MAX_STRING_BYTES = 256 * 1024
    private const val MAX_DISCLOSURES = 64

    fun encode(value: MobileProtocolState): ByteArray {
        val output = ByteArrayOutputStream()
        DataOutputStream(output).use { data ->
            data.writeInt(VERSION)
            data.writeString(value.phase.name)
            data.writeNullableString(value.requestId)
            data.writeNullableString(value.prepareRequestId)
            data.writeNullableString(value.installationId)
            data.writeNullableString(value.pairingCode)
            data.writeNullableString(value.proposedBootstrapToken)
            data.writeNullableString(value.bootstrapOrganizationId)
            data.writeNullableString(value.bootstrapEmployeeId)
            data.writeNullableString(value.bootstrapDeviceId)
            data.writeNullableString(value.bootstrapExpiresAt)
            data.writePolicy(value.policy)
            data.writeNullableString(value.expectedPolicyId)
            data.writeNullableString(value.expectedPolicyHash)
            data.writeNullableString(value.proposedSessionToken)
            data.writeNullableString(value.proposedSessionExpiresAt)
            data.writeNullableString(value.preparedAt)
            data.writeBoolean(value.collectionStartsAtEpochMillis != null)
            value.collectionStartsAtEpochMillis?.let { data.writeLong(it) }
            data.writeConsent(value.consent)
            data.writeCredentials(value.operationCredentials)
        }
        return output.toByteArray()
    }

    fun decode(encoded: ByteArray): MobileProtocolState = DataInputStream(ByteArrayInputStream(encoded)).use { data ->
        require(data.readInt() == VERSION) { "Unsupported protocol-state version" }
        val state = MobileProtocolState(
            phase = ProtocolPhase.valueOf(data.readString()),
            requestId = data.readNullableString(),
            prepareRequestId = data.readNullableString(),
            installationId = data.readNullableString(),
            pairingCode = data.readNullableString(),
            proposedBootstrapToken = data.readNullableString(),
            bootstrapOrganizationId = data.readNullableString(),
            bootstrapEmployeeId = data.readNullableString(),
            bootstrapDeviceId = data.readNullableString(),
            bootstrapExpiresAt = data.readNullableString(),
            policy = data.readPolicy(),
            expectedPolicyId = data.readNullableString(),
            expectedPolicyHash = data.readNullableString(),
            proposedSessionToken = data.readNullableString(),
            proposedSessionExpiresAt = data.readNullableString(),
            preparedAt = data.readNullableString(),
            collectionStartsAtEpochMillis = if (data.readBoolean()) data.readLong() else null,
            consent = data.readConsent(),
            operationCredentials = data.readCredentials(),
        )
        require(data.available() == 0) { "Unexpected trailing protocol-state data" }
        state
    }

    private fun DataOutputStream.writePolicy(value: AuthoritativePolicyDocument?) {
        writeBoolean(value != null)
        if (value == null) return
        writeString(value.id)
        writeString(value.contentHash)
        writeString(value.policyVersion)
        writeString(value.disclosureVersion)
        writeString(value.collectionMode)
        writeString(value.purpose)
        writeString(value.title)
        writeString(value.summary)
        writeInt(value.disclosures.size)
        value.disclosures.forEach { writeString(it) }
        writeString(value.effectiveAt)
    }

    private fun DataInputStream.readPolicy(): AuthoritativePolicyDocument? {
        if (!readBoolean()) return null
        val id = readString()
        val hash = readString()
        val policyVersion = readString()
        val disclosureVersion = readString()
        val collectionMode = readString()
        val purpose = readString()
        val title = readString()
        val summary = readString()
        val count = readInt()
        require(count in 0..MAX_DISCLOSURES) { "Invalid disclosure count" }
        val disclosures = List(count) { readString() }
        return AuthoritativePolicyDocument(
            id = id,
            contentHash = hash,
            policyVersion = policyVersion,
            disclosureVersion = disclosureVersion,
            collectionMode = collectionMode,
            purpose = purpose,
            title = title,
            summary = summary,
            disclosures = disclosures,
            effectiveAt = readString(),
        )
    }

    private fun DataOutputStream.writeConsent(value: ConsentReceipt?) {
        writeBoolean(value != null)
        if (value == null) return
        writeString(value.policyId)
        writeString(value.contentHash)
        writeString(value.acceptedAt)
        writeNullableString(value.locale)
    }

    private fun DataInputStream.readConsent(): ConsentReceipt? {
        if (!readBoolean()) return null
        return ConsentReceipt(readString(), readString(), readString(), readNullableString())
    }

    private fun DataOutputStream.writeCredentials(value: DeviceCredentials?) {
        writeBoolean(value != null)
        if (value == null) return
        writeString(value.organizationId)
        writeString(value.employeeId)
        writeString(value.deviceId)
        writeString(value.sessionToken)
        writeString(value.expiresAt)
    }

    private fun DataInputStream.readCredentials(): DeviceCredentials? {
        if (!readBoolean()) return null
        return DeviceCredentials(readString(), readString(), readString(), readString(), readString())
    }

    private fun DataOutputStream.writeNullableString(value: String?) {
        writeBoolean(value != null)
        if (value != null) writeString(value)
    }

    private fun DataInputStream.readNullableString(): String? = if (readBoolean()) readString() else null

    private fun DataOutputStream.writeString(value: String) {
        val bytes = value.toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_STRING_BYTES) { "Protocol-state string is too large" }
        writeInt(bytes.size)
        write(bytes)
    }

    private fun DataInputStream.readString(): String {
        val size = readInt()
        require(size in 0..MAX_STRING_BYTES) { "Invalid protocol-state string length" }
        val bytes = ByteArray(size)
        readFully(bytes)
        return String(bytes, Charsets.UTF_8)
    }
}

class PolicyValidationException(message: String) : IllegalStateException(message)

object AuthoritativePolicyValidator {
    fun requireCompatible(
        policy: AuthoritativePolicyDocument,
        collectionMode: String,
        expectedId: String? = null,
        expectedHash: String? = null,
    ) {
        if (policy.collectionMode != collectionMode) {
            throw PolicyValidationException("POLICY_COLLECTION_MODE_MISMATCH")
        }
        if (policy.purpose != "call_metadata") {
            throw PolicyValidationException("POLICY_PURPOSE_MISMATCH")
        }
        if (expectedId != null && policy.id != expectedId) {
            throw PolicyValidationException("POLICY_ID_MISMATCH")
        }
        if (expectedHash != null && policy.contentHash != expectedHash) {
            throw PolicyValidationException("POLICY_HASH_MISMATCH")
        }
    }
}

object ProtocolRecoveryPlanner {
    /** A valid session without its acknowledged policy journal must renew consent, never collect. */
    fun requiresAuthoritativePolicyFetch(state: MobileProtocolState, hasSessionCredential: Boolean): Boolean =
        hasSessionCredential && state.phase == ProtocolPhase.IDLE &&
            (state.policy == null || state.consent == null)

    fun requiresImmediatePreflightAfter(completedPhase: ProtocolPhase): Boolean =
        completedPhase == ProtocolPhase.ROTATION_CONFIRM_PENDING

    fun requiresReconsentAfterActivation(
        acknowledgedConsent: ConsentReceipt,
        currentPolicy: AuthoritativePolicyDocument,
    ): Boolean = acknowledgedConsent.policyId != currentPolicy.id ||
        acknowledgedConsent.contentHash != currentPolicy.contentHash

    /** Target a fresh authoritative policy instead of replaying a stale consent payload forever. */
    fun consentRequiredTargetPhase(currentPhase: ProtocolPhase): ProtocolPhase? = when (currentPhase) {
        ProtocolPhase.ACTIVATION_PENDING -> ProtocolPhase.ACTIVATION_POLICY_PENDING
        ProtocolPhase.RECONSENT_PENDING,
        ProtocolPhase.ROTATION_PREPARE_PENDING,
        -> ProtocolPhase.RECONSENT_POLICY_PENDING
        else -> null
    }

    /** A true result is an instruction to crypto-erase and purge before finalizing. */
    fun requiresLocalRevocationPurge(
        revocationPending: Boolean,
        state: MobileProtocolState,
        hasActiveCredential: Boolean,
    ): Boolean =
        // The journal is the first durable write in local-only revocation. It must
        // remain sufficient even when the process dies before the preference flag.
        (!hasActiveCredential && state.phase == ProtocolPhase.REVOKE_PENDING &&
            state.operationCredentials == null) ||
            // Worker revocation publishes this marker before credential erasure, so
            // startup must finish the purge even at that earliest crash boundary.
            (revocationPending && state.phase != ProtocolPhase.REVOKE_PENDING)

    fun canFinalizeLocalRevocation(
        revocationPending: Boolean,
        state: MobileProtocolState,
        hasActiveCredential: Boolean,
    ): Boolean = requiresLocalRevocationPurge(revocationPending, state, hasActiveCredential)
}

object RotationConcurrencyGate {
    /** Drain an existing collector and keep the pending-journal commit inside the same lock. */
    suspend fun <T> drainAndCommit(mutex: Mutex, commitPending: suspend () -> T): T =
        mutex.withLock { commitPending() }
}
