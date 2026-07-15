package co.callora.mobile.data.local

import co.callora.mobile.data.api.LeadFollowUpDraft
import co.callora.mobile.data.api.LeadUpdateCommand
import co.callora.mobile.data.api.LeadUpdateDraft
import co.callora.mobile.data.api.LeadUpdateValidator
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class LeadMutationPayloadCodecTest {
    @Test
    fun `round trip preserves the exact replay command`() {
        val command = command()
        assertEquals(command, LeadMutationPayloadCodec.decode(LeadMutationPayloadCodec.encode(command)))
    }

    @Test
    fun `trailing or truncated payload data is rejected`() {
        val valid = Base64.getUrlDecoder().decode(LeadMutationPayloadCodec.encode(command()))
        val trailing = Base64.getUrlEncoder().withoutPadding().encodeToString(valid + byteArrayOf(1))
        val truncated = Base64.getUrlEncoder().withoutPadding().encodeToString(valid.copyOf(valid.size - 2))

        assertThrows(IllegalArgumentException::class.java) { LeadMutationPayloadCodec.decode(trailing) }
        assertThrows(Exception::class.java) { LeadMutationPayloadCodec.decode(truncated) }
    }

    @Test
    fun `validator trims values and requires at least one real mutation`() {
        val normalized = LeadUpdateValidator.normalized(
            LeadUpdateDraft(
                leadId = "lead-1",
                expectedLeadVersion = 2,
                noteBody = "  Spoke with customer  ",
            ),
        )
        assertEquals("Spoke with customer", normalized.noteBody)
        assertThrows(IllegalArgumentException::class.java) {
            LeadUpdateValidator.normalized(LeadUpdateDraft("lead-1", 2, noteBody = "   "))
        }
    }

    @Test
    fun `validator applies the five thousand character limit to both note fields`() {
        val exactLimit = "n".repeat(LeadUpdateValidator.MAX_NOTE_LENGTH)
        LeadUpdateValidator.normalized(
            LeadUpdateDraft("lead-1", 2, noteBody = exactLimit),
        )
        LeadUpdateValidator.normalized(
            LeadUpdateDraft(
                "lead-1",
                2,
                followUp = LeadFollowUpDraft(
                    title = "Call again",
                    notes = exactLimit,
                    dueAt = "2026-07-16T12:30:00Z",
                ),
            ),
        )

        assertThrows(IllegalArgumentException::class.java) {
            LeadUpdateValidator.normalized(
                LeadUpdateDraft("lead-1", 2, noteBody = exactLimit + "x"),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            LeadUpdateValidator.normalized(
                LeadUpdateDraft(
                    "lead-1",
                    2,
                    followUp = LeadFollowUpDraft(
                        title = "Call again",
                        notes = exactLimit + "x",
                        dueAt = "2026-07-16T12:30:00Z",
                    ),
                ),
            )
        }
    }

    private fun command() = LeadUpdateCommand(
        requestId = "67bfb73c-fd2e-46da-b9cb-d1a0cfb3c593",
        leadId = "lead-1",
        expectedLeadVersion = 4,
        occurredAt = "2026-07-15T12:30:00Z",
        statusId = "status-contacted",
        noteBody = "Customer said: ફરી કૉલ કરો",
        followUp = LeadFollowUpDraft(
            title = "Review pricing",
            notes = "Send the revised quote",
            dueAt = "2026-07-16T12:30:00Z",
            reminderAt = "2026-07-16T11:30:00Z",
            priority = "high",
        ),
    )
}
