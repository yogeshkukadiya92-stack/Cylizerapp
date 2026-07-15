package co.callora.mobile.sync

import co.callora.mobile.data.api.MobileApiException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RetryPolicyTest {
    @Test
    fun `retry grows exponentially and stops at the attempt bound`() {
        val delays = (0 until RetryPolicy.maxAttempts).map { RetryPolicy.forAttempt(it).delayMillis }
        assertTrue(delays.zipWithNext().all { (first, second) -> second >= first })
        assertTrue(delays.all { it <= 6 * 60 * 60 * 1_000L })
        assertFalse(RetryPolicy.forAttempt(RetryPolicy.maxAttempts).retry)
    }

    @Test
    fun `ingest consent rollover reconsents without revoking valid session`() {
        assertEquals(
            SyncFailureAction.REQUIRE_CONSENT,
            SyncFailurePlanner.forApi(
                MobileApiException(
                    statusCode = 409,
                    code = "CONSENT_REQUIRED",
                    retryable = false,
                ),
            ),
        )
        assertEquals(
            SyncFailureAction.REVOKE_SESSION,
            SyncFailurePlanner.forApi(
                MobileApiException(
                    statusCode = 401,
                    code = "INVALID_SESSION",
                    retryable = false,
                ),
            ),
        )
    }
}
