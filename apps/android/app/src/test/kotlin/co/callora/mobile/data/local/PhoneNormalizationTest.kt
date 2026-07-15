package co.callora.mobile.data.local

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhoneNormalizationTest {
    @Test
    fun `only explicit bounded E164 numbers enter the queue`() {
        assertEquals("+919876543210", CallQueueRepository.normalizeE164("+91 98765-43210"))
        assertNull(CallQueueRepository.normalizeE164("9876543210"))
        assertNull(CallQueueRepository.normalizeE164("Private number"))
        assertNull(CallQueueRepository.normalizeE164("+00000000"))
    }
}

