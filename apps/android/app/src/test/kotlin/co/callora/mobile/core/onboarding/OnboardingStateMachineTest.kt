package co.callora.mobile.core.onboarding

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OnboardingStateMachineTest {
    @Test
    fun `pairing and authoritative policy precede disclosure activation and permission`() {
        var state = OnboardingSnapshot(permissionRequired = true)
        assertEquals(OnboardingStage.PAIRING, state.stage)
        assertFalse(state.collectionAllowed)

        state = OnboardingStateMachine.reduce(state, OnboardingEvent.PolicyFetchStarted)
        assertEquals(OnboardingStage.POLICY_LOADING, state.stage)
        state = OnboardingStateMachine.reduce(state, OnboardingEvent.PolicyLoaded)
        assertEquals(OnboardingStage.DISCLOSURE, state.stage)

        state = OnboardingStateMachine.reduce(state, OnboardingEvent.DisclosureAccepted)
        assertFalse(state.hasDeviceCredential)
        assertFalse(state.collectionAllowed)
        assertFalse(state.stage == OnboardingStage.PERMISSION)

        state = OnboardingStateMachine.reduce(state, OnboardingEvent.ActivationStarted)
        assertEquals(OnboardingStage.ACTIVATING, state.stage)
        assertFalse(state.collectionAllowed)

        state = OnboardingStateMachine.reduce(state, OnboardingEvent.PairingActivated)
        assertEquals(OnboardingStage.PERMISSION, state.stage)
        state = OnboardingStateMachine.reduce(state, OnboardingEvent.PermissionObserved(true))
        assertEquals(OnboardingStage.READY, state.stage)
        assertTrue(state.collectionAllowed)
    }

    @Test
    fun `stale consent immediately returns an active device to disclosure`() {
        val ready = OnboardingSnapshot(
            hasAuthoritativePolicy = true,
            disclosureAccepted = true,
            hasDeviceCredential = true,
            permissionRequired = true,
            permissionGranted = true,
        )
        val stale = OnboardingStateMachine.reduce(ready, OnboardingEvent.DisclosureBecameStale)
        assertEquals(OnboardingStage.DISCLOSURE, stale.stage)
        assertTrue(stale.consentStale)
        assertFalse(stale.collectionAllowed)
    }

    @Test
    fun `non-idle secure protocol can never derive ready`() {
        val pendingRotation = OnboardingSnapshot(
            hasAuthoritativePolicy = true,
            disclosureAccepted = true,
            hasDeviceCredential = true,
            permissionRequired = false,
            permissionGranted = true,
            protocolIdle = false,
        )
        assertEquals(OnboardingStage.RECOVERING, pendingRotation.stage)
        assertFalse(pendingRotation.collectionAllowed)
    }

    @Test
    fun `revocation is terminal until reset and reset begins with pairing`() {
        val ready = OnboardingSnapshot(
            hasAuthoritativePolicy = true,
            disclosureAccepted = true,
            hasDeviceCredential = true,
            permissionRequired = true,
            permissionGranted = true,
        )
        val revoked = OnboardingStateMachine.reduce(ready, OnboardingEvent.DeviceRevoked)
        assertEquals(OnboardingStage.REVOKED, revoked.stage)
        assertFalse(revoked.collectionAllowed)
        assertEquals(
            OnboardingStage.REVOKED,
            OnboardingStateMachine.reduce(revoked, OnboardingEvent.DisclosureAccepted).stage,
        )
        assertEquals(OnboardingStage.PAIRING, OnboardingStateMachine.reduce(revoked, OnboardingEvent.Reset).stage)
    }
}
