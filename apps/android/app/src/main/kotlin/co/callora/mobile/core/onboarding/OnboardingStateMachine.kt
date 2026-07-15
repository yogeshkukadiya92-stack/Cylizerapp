package co.callora.mobile.core.onboarding

enum class OnboardingStage {
    PAIRING,
    POLICY_LOADING,
    DISCLOSURE,
    ACTIVATING,
    RECOVERING,
    PERMISSION,
    READY,
    REVOKED,
}

data class OnboardingSnapshot(
    val hasAuthoritativePolicy: Boolean = false,
    val policyLoading: Boolean = false,
    val activationPending: Boolean = false,
    val protocolIdle: Boolean = true,
    val disclosureAccepted: Boolean = false,
    val hasDeviceCredential: Boolean = false,
    val permissionRequired: Boolean = true,
    val permissionGranted: Boolean = false,
    val consentStale: Boolean = false,
    val revoked: Boolean = false,
) {
    val stage: OnboardingStage
        get() = when {
            revoked -> OnboardingStage.REVOKED
            policyLoading -> OnboardingStage.POLICY_LOADING
            activationPending -> OnboardingStage.ACTIVATING
            !hasDeviceCredential && !hasAuthoritativePolicy -> OnboardingStage.PAIRING
            !hasAuthoritativePolicy || !disclosureAccepted || consentStale -> OnboardingStage.DISCLOSURE
            !hasDeviceCredential -> OnboardingStage.PAIRING
            !protocolIdle -> OnboardingStage.RECOVERING
            permissionRequired && !permissionGranted -> OnboardingStage.PERMISSION
            else -> OnboardingStage.READY
        }

    val collectionAllowed: Boolean
        get() = stage == OnboardingStage.READY && protocolIdle && hasAuthoritativePolicy && disclosureAccepted &&
            hasDeviceCredential && !consentStale && (!permissionRequired || permissionGranted)
}

sealed interface OnboardingEvent {
    data object PolicyFetchStarted : OnboardingEvent
    data object PolicyLoaded : OnboardingEvent
    data object DisclosureAccepted : OnboardingEvent
    data object ActivationStarted : OnboardingEvent
    data object DisclosureBecameStale : OnboardingEvent
    data object PairingActivated : OnboardingEvent
    data class PermissionObserved(val granted: Boolean) : OnboardingEvent
    data object DeviceRevoked : OnboardingEvent
    data object Reset : OnboardingEvent
}

object OnboardingStateMachine {
    fun reduce(state: OnboardingSnapshot, event: OnboardingEvent): OnboardingSnapshot = when (event) {
        OnboardingEvent.PolicyFetchStarted -> state.copy(policyLoading = true)
        OnboardingEvent.PolicyLoaded -> state.copy(hasAuthoritativePolicy = true, policyLoading = false)
        OnboardingEvent.DisclosureAccepted -> {
            if (!state.hasAuthoritativePolicy || state.revoked) state
            else state.copy(disclosureAccepted = true, consentStale = false)
        }
        OnboardingEvent.ActivationStarted -> {
            if (!state.hasAuthoritativePolicy || !state.disclosureAccepted || state.revoked) state
            else state.copy(activationPending = true)
        }
        OnboardingEvent.DisclosureBecameStale -> state.copy(
            disclosureAccepted = false,
            permissionGranted = false,
            consentStale = true,
        )
        OnboardingEvent.PairingActivated -> {
            if (!state.hasAuthoritativePolicy || !state.disclosureAccepted || state.revoked) state
            else state.copy(hasDeviceCredential = true, activationPending = false)
        }
        is OnboardingEvent.PermissionObserved -> {
            if (!state.disclosureAccepted || !state.hasDeviceCredential || state.consentStale || state.revoked) state
            else state.copy(permissionGranted = event.granted)
        }
        OnboardingEvent.DeviceRevoked -> state.copy(
            hasDeviceCredential = false,
            activationPending = false,
            permissionGranted = false,
            revoked = true,
        )
        OnboardingEvent.Reset -> OnboardingSnapshot(permissionRequired = state.permissionRequired)
    }
}
