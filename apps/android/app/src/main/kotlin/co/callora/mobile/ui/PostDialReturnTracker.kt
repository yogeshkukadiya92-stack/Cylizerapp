package co.callora.mobile.ui

/** Tracks only app/dialer navigation. It deliberately makes no claim that a call occurred. */
internal class PostDialReturnTracker {
    private var pendingLeadId: String? = null
    private var leftApp = false

    fun launched(leadId: String) {
        pendingLeadId = leadId
        leftApp = false
    }

    fun hostStopped() {
        if (pendingLeadId != null) leftApp = true
    }

    fun hostResumed(): String? {
        if (!leftApp) return null
        val result = pendingLeadId
        pendingLeadId = null
        leftApp = false
        return result
    }

    fun failed() {
        pendingLeadId = null
        leftApp = false
    }
}
