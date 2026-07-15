package co.callora.mobile.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import co.callora.mobile.data.api.AssignedLead
import co.callora.mobile.data.api.LeadFollowUpDraft
import co.callora.mobile.data.api.LeadUpdateDraft
import co.callora.mobile.data.api.LeadUpdateValidator
import co.callora.mobile.data.api.MobileLeadStatus
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private enum class FollowUpDelay(val label: String, val duration: Duration) {
    TOMORROW("Tomorrow", Duration.ofDays(1)),
    THREE_DAYS("In 3 days", Duration.ofDays(3)),
    NEXT_WEEK("Next week", Duration.ofDays(7)),
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun PostCallUpdateSheet(
    lead: AssignedLead,
    statuses: List<MobileLeadStatus>,
    postCall: Boolean,
    saving: Boolean,
    onDismiss: () -> Unit,
    onSubmit: (LeadUpdateDraft) -> Unit,
) {
    var selectedStatusId by rememberSaveable(lead.id, lead.version) { mutableStateOf(lead.statusId) }
    var note by rememberSaveable(lead.id, lead.version) { mutableStateOf("") }
    var followUpEnabled by rememberSaveable(lead.id, lead.version) { mutableStateOf(false) }
    var followUpTitle by rememberSaveable(lead.id, lead.version) { mutableStateOf("") }
    var followUpNotes by rememberSaveable(lead.id, lead.version) { mutableStateOf("") }
    var delayName by rememberSaveable(lead.id, lead.version) { mutableStateOf(FollowUpDelay.TOMORROW.name) }
    var priority by rememberSaveable(lead.id, lead.version) { mutableStateOf("normal") }
    var submitted by rememberSaveable(lead.id, lead.version) { mutableStateOf(false) }
    val delay = FollowUpDelay.valueOf(delayName)
    val statusChanged = selectedStatusId != lead.statusId
    val noteValue = note.trim()
    val titleValue = followUpTitle.trim()
    val notesValue = followUpNotes.trim()
    val hasChanges = statusChanged || noteValue.isNotEmpty() || followUpEnabled
    val formValid = hasChanges && noteValue.length <= LeadUpdateValidator.MAX_NOTE_LENGTH &&
        notesValue.length <= LeadUpdateValidator.MAX_NOTE_LENGTH && (!followUpEnabled || titleValue.isNotEmpty())
    val validation = when {
        !submitted -> null
        !hasChanges -> "Choose a status, add a note, or schedule a follow-up."
        noteValue.length > LeadUpdateValidator.MAX_NOTE_LENGTH -> "Note must be 5,000 characters or fewer."
        followUpEnabled && titleValue.isEmpty() -> "Add a follow-up title."
        notesValue.length > LeadUpdateValidator.MAX_NOTE_LENGTH ->
            "Follow-up notes must be 5,000 characters or fewer."
        else -> null
    }

    ModalBottomSheet(onDismissRequest = { if (!saving) onDismiss() }) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, bottom = 28.dp)
                .testTag("lead_update_sheet"),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    if (postCall) "Back from Phone" else "Update lead",
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    if (postCall) {
                        "If you spoke to ${lead.firstName}, capture the outcome now. Opening the dialer does not confirm a call."
                    } else {
                        "Save the next useful CRM action for ${lead.displayName}."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Status", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                if (statuses.isEmpty()) {
                    Text(
                        "Statuses are unavailable. You can still add a note or follow-up.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Row(
                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        statuses.forEach { status ->
                            FilterChip(
                                selected = selectedStatusId == status.id,
                                onClick = { selectedStatusId = status.id },
                                label = { Text(status.name) },
                                enabled = !saving,
                                modifier = Modifier.heightIn(min = 48.dp),
                            )
                        }
                    }
                }
            }

            OutlinedTextField(
                value = note,
                onValueChange = { note = it.take(LeadUpdateValidator.MAX_NOTE_LENGTH + 1) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Call note") },
                supportingText = { Text("${note.length}/5,000 · encrypted before local storage") },
                minLines = 3,
                maxLines = 7,
                enabled = !saving,
                isError = submitted && noteValue.length > LeadUpdateValidator.MAX_NOTE_LENGTH,
            )

            FilterChip(
                selected = followUpEnabled,
                onClick = { followUpEnabled = !followUpEnabled },
                label = { Text(if (followUpEnabled) "Follow-up scheduled" else "Schedule follow-up") },
                enabled = !saving,
                modifier = Modifier.heightIn(min = 48.dp),
            )

            if (followUpEnabled) {
                OutlinedTextField(
                    value = followUpTitle,
                    onValueChange = { followUpTitle = it.take(200) },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Follow-up title") },
                    supportingText = { Text("Required · ${followUpTitle.length}/200") },
                    singleLine = true,
                    enabled = !saving,
                    isError = submitted && titleValue.isEmpty(),
                )
                OutlinedTextField(
                    value = followUpNotes,
                    onValueChange = { followUpNotes = it.take(LeadUpdateValidator.MAX_NOTE_LENGTH + 1) },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Follow-up notes (optional)") },
                    supportingText = { Text("${followUpNotes.length}/5,000") },
                    minLines = 2,
                    maxLines = 5,
                    enabled = !saving,
                    isError = submitted && notesValue.length > LeadUpdateValidator.MAX_NOTE_LENGTH,
                )
                Text("Due", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    FollowUpDelay.entries.forEach { candidate ->
                        FilterChip(
                            selected = delay == candidate,
                            onClick = { delayName = candidate.name },
                            label = { Text(candidate.label) },
                            enabled = !saving,
                            modifier = Modifier.heightIn(min = 48.dp),
                        )
                    }
                }
                Text(
                    "Due ${formatFollowUpDue(Instant.now().plus(delay.duration))}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text("Priority", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("normal" to "Normal", "high" to "High", "urgent" to "Urgent").forEach { option ->
                        FilterChip(
                            selected = priority == option.first,
                            onClick = { priority = option.first },
                            label = { Text(option.second) },
                            enabled = !saving,
                            modifier = Modifier.heightIn(min = 48.dp),
                        )
                    }
                }
            }

            validation?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
            Button(
                onClick = {
                    submitted = true
                    if (formValid) {
                        val dueAt = Instant.now().plus(delay.duration).toString()
                        onSubmit(
                            LeadUpdateDraft(
                                leadId = lead.id,
                                expectedLeadVersion = lead.version,
                                statusId = selectedStatusId.takeIf { it != lead.statusId },
                                noteBody = noteValue.takeIf(String::isNotEmpty),
                                followUp = if (followUpEnabled) {
                                    LeadFollowUpDraft(
                                        title = titleValue,
                                        notes = notesValue.takeIf(String::isNotEmpty),
                                        dueAt = dueAt,
                                        priority = priority,
                                    )
                                } else {
                                    null
                                },
                            ),
                        )
                    }
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("save_lead_update"),
                enabled = !saving,
            ) { Text(if (saving) "Saving securely…" else "Save update") }
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                enabled = !saving,
            ) { Text("Not now") }
        }
    }
}

private fun formatFollowUpDue(value: Instant): String = DateTimeFormatter.ofPattern("EEE, dd MMM · h:mm a")
    .withZone(ZoneId.systemDefault())
    .format(value)
