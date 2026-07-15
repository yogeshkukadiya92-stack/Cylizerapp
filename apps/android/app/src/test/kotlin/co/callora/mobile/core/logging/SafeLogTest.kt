package co.callora.mobile.core.logging

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SafeLogTest {
    @Test
    fun `tokens pairing codes and phone numbers are redacted`() {
        val raw = "Authorization: Bearer secret.token pairing_code=ABCD2345 sessionToken=opaque-device-secret call +91 98765 43210"
        val safe = SafeLog.redact(raw)
        assertFalse(safe.contains("secret.token"))
        assertFalse(safe.contains("ABCD2345"))
        assertFalse(safe.contains("opaque-device-secret"))
        assertFalse(safe.contains("98765"))
        assertTrue(safe.contains("[REDACTED]"))
        assertTrue(safe.contains("[PHONE_REDACTED]"))
    }
}
