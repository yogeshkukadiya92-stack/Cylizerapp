package co.callora.mobile.data.local

import co.callora.mobile.data.api.LeadFollowUpDraft
import co.callora.mobile.data.api.LeadUpdateCommand
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.nio.charset.StandardCharsets
import java.util.Base64

/** Deterministic, length-prefixed command encoding that is safe in local JVM tests. */
object LeadMutationPayloadCodec {
    private const val VERSION = 1
    private const val MAX_FIELD_BYTES = 40_000
    private const val MAX_PAYLOAD_BYTES = 80_000

    fun encode(command: LeadUpdateCommand): String {
        val output = ByteArrayOutputStream()
        DataOutputStream(output).use { data ->
            data.writeInt(VERSION)
            data.writeInt(command.schemaVersion)
            data.writeString(command.requestId)
            data.writeString(command.leadId)
            data.writeLong(command.expectedLeadVersion)
            data.writeString(command.occurredAt)
            data.writeNullableString(command.statusId)
            data.writeNullableString(command.noteBody)
            data.writeBoolean(command.followUp != null)
            command.followUp?.let { followUp ->
                data.writeString(followUp.title)
                data.writeNullableString(followUp.notes)
                data.writeString(followUp.dueAt)
                data.writeNullableString(followUp.reminderAt)
                data.writeString(followUp.priority)
            }
        }
        val bytes = output.toByteArray()
        require(bytes.size <= MAX_PAYLOAD_BYTES) { "Lead mutation payload is too large" }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    fun decode(encoded: String): LeadUpdateCommand {
        val bytes = Base64.getUrlDecoder().decode(encoded)
        require(bytes.size <= MAX_PAYLOAD_BYTES) { "Lead mutation payload is too large" }
        return DataInputStream(ByteArrayInputStream(bytes)).use { data ->
            require(data.readInt() == VERSION) { "Unsupported lead mutation payload version" }
            val schemaVersion = data.readInt()
            val requestId = data.readString()
            val leadId = data.readString()
            val expectedVersion = data.readLong()
            val occurredAt = data.readString()
            val statusId = data.readNullableString()
            val noteBody = data.readNullableString()
            val followUp = if (data.readBoolean()) {
                LeadFollowUpDraft(
                    title = data.readString(),
                    notes = data.readNullableString(),
                    dueAt = data.readString(),
                    reminderAt = data.readNullableString(),
                    priority = data.readString(),
                )
            } else {
                null
            }
            require(data.available() == 0) { "Trailing lead mutation payload data" }
            LeadUpdateCommand(
                schemaVersion = schemaVersion,
                requestId = requestId,
                leadId = leadId,
                expectedLeadVersion = expectedVersion,
                occurredAt = occurredAt,
                statusId = statusId,
                noteBody = noteBody,
                followUp = followUp,
            )
        }
    }

    private fun DataOutputStream.writeString(value: String) {
        val bytes = value.toByteArray(StandardCharsets.UTF_8)
        require(bytes.size <= MAX_FIELD_BYTES) { "Lead mutation field is too large" }
        writeInt(bytes.size)
        write(bytes)
    }

    private fun DataOutputStream.writeNullableString(value: String?) {
        writeBoolean(value != null)
        if (value != null) writeString(value)
    }

    private fun DataInputStream.readString(): String {
        val size = readInt()
        require(size in 0..MAX_FIELD_BYTES && size <= available()) { "Invalid lead mutation field length" }
        return String(ByteArray(size).also(::readFully), StandardCharsets.UTF_8)
    }

    private fun DataInputStream.readNullableString(): String? = if (readBoolean()) readString() else null
}
