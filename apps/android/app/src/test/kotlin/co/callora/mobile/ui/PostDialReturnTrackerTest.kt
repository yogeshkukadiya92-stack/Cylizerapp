package co.callora.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PostDialReturnTrackerTest {
    @Test
    fun `resume prompts once only after the dialer took the app off screen`() {
        val tracker = PostDialReturnTracker()
        tracker.launched("lead-1")

        assertNull(tracker.hostResumed())
        tracker.hostStopped()
        assertEquals("lead-1", tracker.hostResumed())
        assertNull(tracker.hostResumed())
    }

    @Test
    fun `failed dial launch clears pending prompt`() {
        val tracker = PostDialReturnTracker()
        tracker.launched("lead-1")
        tracker.hostStopped()
        tracker.failed()

        assertNull(tracker.hostResumed())
    }
}
