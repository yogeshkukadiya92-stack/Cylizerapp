package co.callora.mobile.data.local

import co.callora.mobile.core.model.DeviceCredentials
import co.callora.mobile.core.protocol.ProtocolPhase

internal sealed interface LeadMutationEnqueueGateDecision {
    data class Open(val credentials: DeviceCredentials) : LeadMutationEnqueueGateDecision
    data object Closed : LeadMutationEnqueueGateDecision
}
/** Pure gate evaluated while collectionMutex is held immediately before durable enqueue. */
internal object LeadMutationEnqueueGate {
    fun evaluate(
        phase: ProtocolPhase?,
        hasPolicy: Boolean,
        hasConsent: Boolean,
        disclosureAccepted: Boolean,
        consentStale: Boolean,
        revoked: Boolean,
        credentials: DeviceCredentials?,
    ): LeadMutationEnqueueGateDecision {
        val open = phase == ProtocolPhase.IDLE && hasPolicy && hasConsent && disclosureAccepted &&
            !consentStale && !revoked && credentials != null
        return if (open) LeadMutationEnqueueGateDecision.Open(credentials) else LeadMutationEnqueueGateDecision.Closed
    }
}
