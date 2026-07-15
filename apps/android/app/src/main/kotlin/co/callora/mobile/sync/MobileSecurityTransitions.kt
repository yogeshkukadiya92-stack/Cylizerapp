package co.callora.mobile.sync

import android.content.Context
import co.callora.mobile.AppContainer
import co.callora.mobile.BuildConfig
import co.callora.mobile.core.model.DeviceCredentials
import co.callora.mobile.core.protocol.AuthoritativePolicyValidator
import co.callora.mobile.core.protocol.MobileProtocolState
import co.callora.mobile.core.protocol.ProtocolPhase

/** Shared fail-closed transitions for background workers that own mobile credentials. */
class MobileSecurityTransitions(
    private val context: Context,
    private val container: AppContainer,
) {
    fun collectionGateOpen(): Boolean {
        val preferences = container.preferences
        val protocolReady = runCatching {
            container.protocolVault.read().let {
                it.phase == ProtocolPhase.IDLE && it.policy != null && it.consent != null
            }
        }.getOrDefault(false)
        return protocolReady && preferences.disclosureAccepted && !preferences.consentStale &&
            !preferences.revoked
    }

    suspend fun requireFreshConsent(
        credentials: DeviceCredentials,
        expectedPolicyId: String? = null,
        expectedPolicyHash: String? = null,
    ) {
        val pending = MobileProtocolState(
            phase = ProtocolPhase.RECONSENT_POLICY_PENDING,
            expectedPolicyId = expectedPolicyId,
            expectedPolicyHash = expectedPolicyHash,
            operationCredentials = credentials,
        )
        container.protocolVault.write(pending)
        closeLocalGateForConsent()
        runCatching {
            val policy = container.api.fetchCollectionPolicy(credentials.sessionToken)
            AuthoritativePolicyValidator.requireCompatible(
                policy = policy,
                collectionMode = BuildConfig.COLLECTION_MODE,
                expectedId = expectedPolicyId,
                expectedHash = expectedPolicyHash,
            )
            container.protocolVault.write(pending.copy(phase = ProtocolPhase.RECONSENT_READY, policy = policy))
        }.onFailure {
            container.preferences.recordError("policy_refresh", it::class.java.simpleName)
        }
    }

    fun closeLocalGateForConsent() {
        container.preferences.consentStale = true
        container.preferences.disclosureAccepted = false
        container.preferences.disclosureAcceptedAt = null
        container.preferences.permissionPromptedPolicyHash = null
        SyncScheduler.cancel(context)
        container.purgeLocalCallData()
        container.preferences.clearOperationalState()
    }

    fun revokeLocally() {
        container.preferences.revocationPending = true
        container.preferences.revoked = true
        container.preferences.disclosureAccepted = false
        container.preferences.disclosureAcceptedAt = null
        container.preferences.consentStale = false
        container.preferences.permissionPromptedPolicyHash = null
        SyncScheduler.cancel(context)
        container.credentialVault.clear(destroyKey = true)
        container.protocolVault.clear(destroyKey = true)
        container.purgeLocalCallData()
        container.preferences.clearOperationalState()
        container.preferences.revocationPending = false
    }

    fun invalidateSessionForRepair() {
        container.preferences.revocationPending = true
        container.preferences.disclosureAccepted = false
        container.preferences.disclosureAcceptedAt = null
        container.preferences.consentStale = false
        container.preferences.permissionPromptedPolicyHash = null
        container.preferences.revoked = true
        SyncScheduler.cancel(context)
        container.credentialVault.clear(destroyKey = true)
        container.protocolVault.clear(destroyKey = true)
        container.purgeLocalCallData()
        container.preferences.clearOperationalState()
        container.preferences.regenerateInstallationId()
        container.preferences.revocationPending = false
    }
}
