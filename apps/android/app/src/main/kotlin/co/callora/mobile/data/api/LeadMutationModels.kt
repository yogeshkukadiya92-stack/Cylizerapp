package co.callora.mobile.data.api

import java.time.Instant

data class MobileLeadStatus(
    val id: String,
    val name: String,
    val color: String,
    val position: Int,
    val isInitial: Boolean,
    val isWon: Boolean,
    val isLost: Boolean,
)

data class LeadFollowUpDraft(
    val title: String,
    val notes: String? = null,
    val dueAt: String,
    val reminderAt: String? = null,
    val priority: String = "normal",
)

/** UI-owned draft. A durable request ID and occurrence time are added exactly once at enqueue. */
data class LeadUpdateDraft(
    val leadId: String,
    val expectedLeadVersion: Long,
    val statusId: String? = null,
    val noteBody: String? = null,
    val followUp: LeadFollowUpDraft? = null,
)

/** Immutable replay payload. requestId must also be sent as Idempotency-Key. */
data class LeadUpdateCommand(
    val schemaVersion: Int = 1,
    val requestId: String,
    val leadId: String,
    val expectedLeadVersion: Long,
    val occurredAt: String,
    val statusId: String? = null,
    val noteBody: String? = null,
    val followUp: LeadFollowUpDraft? = null,
)

data class LeadUpdateReceipt(
    val requestId: String,
    val replayed: Boolean,
    val appliedLeadVersion: Long,
)

object LeadUpdateValidator {
    const val MAX_NOTE_LENGTH = 5_000
    private val priorities = setOf("low", "normal", "high", "urgent")

    fun normalized(draft: LeadUpdateDraft): LeadUpdateDraft {
        require(draft.leadId.isNotBlank() && draft.leadId.length <= 100) { "LEAD_ID_INVALID" }
        require(draft.expectedLeadVersion >= 1) { "LEAD_VERSION_INVALID" }
        val statusId = draft.statusId?.trim()?.takeIf(String::isNotEmpty)
        require(statusId == null || statusId.length <= 100) { "LEAD_STATUS_INVALID" }
        val note = draft.noteBody?.trim()?.takeIf(String::isNotEmpty)
        require(note == null || note.length <= MAX_NOTE_LENGTH) { "LEAD_NOTE_INVALID" }
        val followUp = draft.followUp?.let { value ->
            val title = value.title.trim()
            require(title.length in 1..200) { "FOLLOW_UP_TITLE_INVALID" }
            val notes = value.notes?.trim()?.takeIf(String::isNotEmpty)
            require(notes == null || notes.length <= MAX_NOTE_LENGTH) { "FOLLOW_UP_NOTES_INVALID" }
            require(runCatching { Instant.parse(value.dueAt) }.isSuccess) { "FOLLOW_UP_DUE_AT_INVALID" }
            value.reminderAt?.let {
                require(runCatching { Instant.parse(it) }.isSuccess) { "FOLLOW_UP_REMINDER_AT_INVALID" }
                require(Instant.parse(it) <= Instant.parse(value.dueAt)) { "FOLLOW_UP_REMINDER_AFTER_DUE" }
            }
            val priority = value.priority.lowercase()
            require(priority in priorities) { "FOLLOW_UP_PRIORITY_INVALID" }
            value.copy(title = title, notes = notes, priority = priority)
        }
        require(statusId != null || note != null || followUp != null) { "LEAD_UPDATE_EMPTY" }
        return draft.copy(statusId = statusId, noteBody = note, followUp = followUp)
    }
}
