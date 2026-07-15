package co.callora.mobile.data.local

import co.callora.mobile.core.model.DeviceCredentials
import co.callora.mobile.core.protocol.ProtocolPhase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class LeadMutationEnqueueGateTest {
    private val credentials = DeviceCredentials(
        organizationId = "org-1",
        employeeId = "employee-1",
        deviceId = "device-1",
        sessionToken = "cls_token",
        expiresAt = "2026-07-16T00:00:00Z",
    )

    @Test
    fun `gate opens only for an idle current consent session`() {
        val decision = evaluate()

        val open = decision as LeadMutationEnqueueGateDecision.Open
        assertSame(credentials, open.credentials)
    }

    @Test
    fun `every identity policy and consent closure fails closed`() {
        val closed = listOf(
            evaluate(phase = ProtocolPhase.RECONSENT_PENDING),
            evaluate(hasPolicy = false),
            evaluate(hasConsent = false),
            evaluate(disclosureAccepted = false),
            evaluate(consentStale = true),
            evaluate(revoked = true),
            evaluate(credentials = null),
            evaluate(phase = null),
        )

        closed.forEach { assertEquals(LeadMutationEnqueueGateDecision.Closed, it) }
    }

    private fun evaluate(
        phase: ProtocolPhase? = ProtocolPhase.IDLE,
        hasPolicy: Boolean = true,
        hasConsent: Boolean = true,
        disclosureAccepted: Boolean = true,
        consentStale: Boolean = false,
        revoked: Boolean = false,
        credentials: DeviceCredentials? = this.credentials,
    ) = LeadMutationEnqueueGate.evaluate(
        phase = phase,
        hasPolicy = hasPolicy,
        hasConsent = hasConsent,
        disclosureAccepted = disclosureAccepted,
        consentStale = consentStale,
        revoked = revoked,
        credentials = credentials,
    )
}
