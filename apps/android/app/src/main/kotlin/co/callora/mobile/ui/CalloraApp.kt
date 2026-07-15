package co.callora.mobile.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import co.callora.mobile.calls.VariantCapabilities
import co.callora.mobile.BuildConfig
import co.callora.mobile.core.onboarding.OnboardingStage
import co.callora.mobile.data.api.AssignedLead
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun CalloraApp(viewModel: CalloraViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
        viewModel::permissionObserved,
    )
    LaunchedEffect(state.permissionPromptKey) {
        state.permissionPromptKey?.let { policyHash ->
            viewModel.permissionRequestStarted(policyHash)
            permissionLauncher.launch(Manifest.permission.READ_CALL_LOG)
        }
    }
    val notice = state.errorCode?.let(::friendlyError) ?: state.message
    LaunchedEffect(notice) {
        notice?.let {
            snackbar.showSnackbar(it)
            viewModel.dismissMessage()
        }
    }

    Scaffold(
        modifier = Modifier.testTag("callora_root"),
        contentWindowInsets = WindowInsets.safeDrawing,
        topBar = { CalloraHeader(state.onboarding.stage, state.section) },
        bottomBar = {
            if (state.onboarding.stage == OnboardingStage.READY) {
                ReadyNavigation(state.section, viewModel::selectSection)
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { insets ->
        when (state.onboarding.stage) {
            OnboardingStage.PAIRING -> PairingScreen(
                modifier = Modifier.padding(insets),
                code = state.pairingCode,
                busy = state.busy,
                onCodeChange = viewModel::updatePairingCode,
                onPair = viewModel::pairAndFetchPolicy,
            )
            OnboardingStage.POLICY_LOADING -> PolicyLoadingScreen(
                modifier = Modifier.padding(insets),
                busy = state.busy,
                onRetry = viewModel::retryPolicyFetch,
            )
            OnboardingStage.DISCLOSURE -> PolicyDisclosureScreen(
                modifier = Modifier.padding(insets),
                policy = state.policy,
                busy = state.busy,
                activationPending = false,
                onAccept = viewModel::acceptPolicyAndContinue,
            )
            OnboardingStage.ACTIVATING -> PolicyDisclosureScreen(
                modifier = Modifier.padding(insets),
                policy = state.policy,
                busy = state.busy,
                activationPending = true,
                onAccept = viewModel::acceptPolicyAndContinue,
            )
            OnboardingStage.RECOVERING -> SecureRecoveryScreen(
                modifier = Modifier.padding(insets),
                busy = state.busy,
                onRetry = viewModel::retrySecureRecovery,
            )
            OnboardingStage.PERMISSION -> PermissionScreen(
                modifier = Modifier.padding(insets),
                policy = state.policy,
                onRequest = { permissionLauncher.launch(Manifest.permission.READ_CALL_LOG) },
                onOpenSettings = {
                    context.startActivity(
                        Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:${context.packageName}"),
                        ),
                    )
                },
            )
            OnboardingStage.READY -> ReadyScreen(
                modifier = Modifier.padding(insets),
                state = state,
                onSync = viewModel::syncNow,
                onRefreshLeads = viewModel::refreshAssignedLeads,
                onDialLead = { phoneNumber ->
                    context.startActivity(
                        Intent(Intent.ACTION_DIAL, Uri.parse("tel:${Uri.encode(phoneNumber)}")),
                    )
                },
                onSaveApiUrl = viewModel::saveApiBaseUrl,
                onRotate = viewModel::rotateSession,
                onRevoke = viewModel::revokeAndWithdrawConsent,
            )
            OnboardingStage.REVOKED -> RevokedScreen(
                modifier = Modifier.padding(insets),
                revocationPending = state.revocationPending,
                onRetryRevocation = viewModel::retryServerRevocation,
                onReset = viewModel::resetRevokedDevice,
            )
        }
    }
}

@Composable
private fun CalloraHeader(stage: OnboardingStage, section: ReadySection) {
    Surface(tonalElevation = 2.dp) {
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 20.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                Modifier.size(36.dp).background(MaterialTheme.colorScheme.primary, RoundedCornerShape(10.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text("C", color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.Bold)
            }
            Column(Modifier.weight(1f)) {
                Text("Callora", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(
                    when (stage) {
                        OnboardingStage.DISCLOSURE -> "Disclosure"
                        OnboardingStage.PAIRING -> "Pair device"
                        OnboardingStage.POLICY_LOADING -> "Policy update"
                        OnboardingStage.ACTIVATING -> "Activating"
                        OnboardingStage.RECOVERING -> "Secure recovery"
                        OnboardingStage.PERMISSION -> "Permission"
                        OnboardingStage.READY -> when (section) {
                            ReadySection.LEADS -> "Assigned leads"
                            ReadySection.STATUS -> "Collector status"
                            ReadySection.DIAGNOSTICS -> "Diagnostics"
                            ReadySection.SETTINGS -> "Settings"
                        }
                        OnboardingStage.REVOKED -> "Collection stopped"
                    },
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun SecureRecoveryScreen(modifier: Modifier, busy: Boolean, onRetry: () -> Unit) {
    ScreenList(modifier) {
        item { Heading("Session security recovery") }
        item {
            StatusBanner(
                "Collection is paused",
                "Callora is reconciling an interrupted credential operation with the server. No call metadata is read or uploaded until it completes.",
            )
        }
        item {
            Button(
                onClick = onRetry,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(10.dp))
                }
                Text(if (busy) "Reconciling…" else "Retry secure recovery")
            }
        }
    }
}

@Composable
private fun PolicyDisclosureScreen(
    modifier: Modifier,
    policy: co.callora.mobile.core.protocol.AuthoritativePolicyDocument?,
    busy: Boolean,
    activationPending: Boolean,
    onAccept: () -> Unit,
) {
    ScreenList(modifier.testTag("policy_disclosure_list")) {
        if (policy == null) {
            item { Heading("Organization policy unavailable") }
            item { StatusBanner("Collection remains off", "Reconnect and retry. No call metadata is read without the authoritative policy.") }
            return@ScreenList
        }
        item {
            Heading(policy.title)
            Text(policy.summary, style = MaterialTheme.typography.bodyLarge)
        }
        item {
            ElevatedCard {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Organization disclosure", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    policy.disclosures.forEach { disclosure ->
                        Text("• $disclosure", style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
        item {
            ElevatedCard(colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Authoritative policy", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    InfoRow("Policy version", policy.policyVersion)
                    InfoRow("Disclosure version", policy.disclosureVersion)
                    InfoRow("Effective", policy.effectiveAt)
                    InfoRow("Policy ID", policy.id)
                    InfoRow("Content SHA-256", policy.contentHash)
                    Text("The hash is compared exactly with the server during activation. The app does not substitute or rewrite this policy copy.")
                }
            }
        }
        item {
            Button(
                onClick = onAccept,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(10.dp))
                }
                Text(
                    when {
                        busy -> "Confirming…"
                        activationPending -> "Retry exact activation"
                        else -> "Accept policy and activate"
                    },
                )
            }
        }
    }
}

@Composable
private fun PolicyLoadingScreen(modifier: Modifier, busy: Boolean, onRetry: () -> Unit) {
    ScreenList(modifier) {
        item { Heading("Updated policy required") }
        item {
            StatusBanner(
                "Collection is off",
                "The server requires renewed consent. The previous queue was securely cleared before fetching the current policy.",
            )
        }
        item {
            Button(
                onClick = onRetry,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(10.dp))
                }
                Text(if (busy) "Loading policy…" else "Retry policy download")
            }
        }
    }
}

@Composable
private fun DisclosureCard(title: String, lines: List<String>) {
    ElevatedCard {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            lines.forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium) }
        }
    }
}

@Composable
private fun PairingScreen(
    modifier: Modifier,
    code: String,
    busy: Boolean,
    onCodeChange: (String) -> Unit,
    onPair: () -> Unit,
) {
    ScreenList(modifier) {
        item {
            Heading("Pair this installation")
            Text("Enter the short-lived code created for you by an organization administrator. Pairing confirms the organization first, then downloads its exact disclosure for your review.")
            Text("No call metadata is read during pairing.", fontWeight = FontWeight.Bold)
            Text("A new administrator-issued pairing code is required for every re-enrollment; a previously consumed code will not work.", fontWeight = FontWeight.Medium)
        }
        if (VariantCapabilities.displaysSyntheticData) {
            item { StatusBanner("Demo build", "Only synthetic call rows are generated. No device call log is requested or read.") }
        }
        item {
            OutlinedTextField(
                value = code,
                onValueChange = onCodeChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Pairing code") },
                supportingText = { Text("Codes expire and can be used once.") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.Characters,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(
                    onDone = { if (!busy && code.length >= 6) onPair() },
                ),
            )
        }
        item {
            Button(
                onClick = onPair,
                enabled = !busy && code.length >= 6,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(10.dp))
                }
                Text(if (busy) "Pairing…" else "Pair and load policy")
            }
        }
    }
}

@Composable
private fun PermissionScreen(
    modifier: Modifier,
    policy: co.callora.mobile.core.protocol.AuthoritativePolicyDocument?,
    onRequest: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    ScreenList(modifier) {
        item {
            Heading("Allow call-log access")
            Text(policy?.summary ?: "The organization policy remains unavailable, so collection stays off.")
            Text("Android’s Call logs permission is requested only after activation. Denying it keeps collection off and does not affect normal calling.")
        }
        policy?.let { current ->
            item { DisclosureCard("Organization disclosure", current.disclosures) }
        }
        item { PrimaryAction("Allow call-log access", onRequest) }
        item {
            OutlinedButton(
                onClick = onOpenSettings,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) { Text("Open app settings") }
        }
    }
}

@Composable
private fun ReadyScreen(
    modifier: Modifier,
    state: CalloraUiState,
    onSync: () -> Unit,
    onRefreshLeads: () -> Unit,
    onDialLead: (String) -> Unit,
    onSaveApiUrl: (String) -> Unit,
    onRotate: () -> Unit,
    onRevoke: () -> Unit,
) {
    when (state.section) {
        ReadySection.LEADS -> LeadsScreen(modifier, state, onRefreshLeads, onDialLead)
        ReadySection.STATUS -> StatusScreen(modifier, state, onSync)
        ReadySection.DIAGNOSTICS -> DiagnosticsScreen(modifier, state)
        ReadySection.SETTINGS -> SettingsScreen(modifier, state, onSaveApiUrl, onRotate, onRevoke)
    }
}

private enum class LeadQueue(val label: String) {
    ALL("All"),
    NOT_CONTACTED("Not contacted"),
    OVERDUE("Overdue"),
    UNRETURNED("Unreturned"),
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun LeadsScreen(
    modifier: Modifier,
    state: CalloraUiState,
    onRefresh: () -> Unit,
    onDial: (String) -> Unit,
) {
    var search by rememberSaveable { mutableStateOf("") }
    var queue by rememberSaveable { mutableStateOf(LeadQueue.ALL) }
    var selectedLead by remember { mutableStateOf<AssignedLead?>(null) }
    val normalizedSearch = search.trim().lowercase()
    val leads = state.assignedLeads.filter { lead ->
        val matchesQueue = when (queue) {
            LeadQueue.ALL -> true
            LeadQueue.NOT_CONTACTED -> lead.lastContactedAt == null
            LeadQueue.OVERDUE -> lead.overdueFollowUpCount > 0
            LeadQueue.UNRETURNED -> lead.unreturnedMissedCallCount > 0
        }
        matchesQueue && (normalizedSearch.isBlank() || listOfNotNull(
            lead.displayName,
            lead.companyName,
            lead.phoneNumber,
            lead.email,
        ).any { it.lowercase().contains(normalizedSearch) })
    }
    ScreenList(modifier.testTag("assigned_leads_list")) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Heading("Assigned leads")
                    Text("Call customers and keep due work visible.", style = MaterialTheme.typography.bodyMedium)
                }
                OutlinedButton(
                    onClick = onRefresh,
                    enabled = !state.leadsLoading,
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text(if (state.leadsLoading) "Loading…" else "Refresh") }
            }
        }
        item {
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val summary = state.leadSummary
                listOf(
                    LeadQueue.ALL to summary.total,
                    LeadQueue.NOT_CONTACTED to summary.notContacted,
                    LeadQueue.OVERDUE to summary.overdue,
                    LeadQueue.UNRETURNED to summary.unreturnedCalls,
                ).forEach { (candidate, count) ->
                    FilterChip(
                        selected = queue == candidate,
                        onClick = { queue = candidate },
                        label = { Text("${candidate.label} $count") },
                        modifier = Modifier.heightIn(min = 48.dp),
                    )
                }
            }
        }
        item {
            OutlinedTextField(
                value = search,
                onValueChange = { search = it.take(160) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Search assigned leads") },
                supportingText = { Text("Name, company, phone, or email") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            )
        }
        if (state.leadsLoading && state.assignedLeads.isEmpty()) {
            item {
                ElevatedCard {
                    Row(
                        Modifier.fillMaxWidth().padding(20.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                        Text("Loading assigned leads…")
                    }
                }
            }
        } else if (state.leadsErrorCode != null && state.assignedLeads.isEmpty()) {
            item {
                StatusBanner(
                    "Assigned leads unavailable",
                    friendlyError(state.leadsErrorCode),
                )
            }
            item { PrimaryAction("Try again", onRefresh) }
        } else if (leads.isEmpty()) {
            item {
                StatusBanner(
                    if (state.assignedLeads.isEmpty()) "No leads assigned" else "No leads match",
                    if (state.assignedLeads.isEmpty()) "New assigned work will appear here after refresh."
                    else "Change the queue or search text to see more leads.",
                )
            }
        } else {
            items(leads, key = AssignedLead::id) { lead ->
                LeadCard(lead, onOpen = { selectedLead = lead }, onDial = { onDial(lead.phoneNumber) })
            }
        }
        state.leadsGeneratedAt?.let { generatedAt ->
            item {
                Text(
                    "Updated ${formatLeadDate(generatedAt)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
    selectedLead?.let { lead ->
        ModalBottomSheet(onDismissRequest = { selectedLead = null }) {
            Column(
                Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 28.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text(lead.displayName, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                StatusPill(lead.statusName, lead.statusColor)
                InfoRow("Phone", lead.phoneNumber)
                lead.email?.let { InfoRow("Email", it) }
                InfoRow("Source", lead.source.replace('_', ' ').replaceFirstChar(Char::uppercase))
                InfoRow("Last contacted", lead.lastContactedAt?.let(::formatLeadDate) ?: "Not contacted")
                InfoRow("Next follow-up", lead.nextFollowUpAt?.let(::formatLeadDate) ?: "Not scheduled")
                lead.nextFollowUpTitle?.let { InfoRow("Next action", it) }
                Button(
                    onClick = { onDial(lead.phoneNumber) },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) { Text("Call ${lead.firstName}") }
            }
        }
    }
}

@Composable
private fun LeadCard(lead: AssignedLead, onOpen: () -> Unit, onDial: () -> Unit) {
    ElevatedCard(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        lead.displayName,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(lead.phoneNumber, style = MaterialTheme.typography.bodyMedium)
                }
                StatusPill(lead.statusName, lead.statusColor)
            }
            val followUp = lead.nextFollowUpAt
            if (followUp != null) {
                Text(
                    "${if (lead.overdueFollowUpCount > 0) "Overdue" else "Due"}: ${formatLeadDate(followUp)}" +
                        (lead.nextFollowUpTitle?.let { " · $it" } ?: ""),
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (lead.overdueFollowUpCount > 0) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Text("No follow-up scheduled", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onOpen, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                    Text("View")
                }
                Button(onClick = onDial, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                    Text("Call")
                }
            }
        }
    }
}

@Composable
private fun StatusPill(label: String, color: String) {
    val tint = runCatching { androidx.compose.ui.graphics.Color(android.graphics.Color.parseColor(color)) }
        .getOrElse { MaterialTheme.colorScheme.primary }
    Surface(color = tint.copy(alpha = 0.14f), shape = RoundedCornerShape(999.dp)) {
        Text(
            label,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            color = MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Bold,
        )
    }
}

private fun formatLeadDate(value: String): String = runCatching {
    DateTimeFormatter.ofPattern("dd MMM, h:mm a")
        .withZone(ZoneId.systemDefault())
        .format(Instant.parse(value))
}.getOrDefault(value)

@Composable
private fun StatusScreen(modifier: Modifier, state: CalloraUiState, onSync: () -> Unit) {
    ScreenList(modifier) {
        item {
            Heading(if (VariantCapabilities.displaysSyntheticData) "Demo collector ready" else "Call collector ready")
            StatusBanner(
                if (VariantCapabilities.displaysSyntheticData) "Synthetic source" else "Collection enabled",
                if (VariantCapabilities.displaysSyntheticData) "No call-log permission is present in this flavor."
                else "Consent, an active session, and call-log permission are present.",
            )
        }
        item {
            ElevatedCard {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Queue", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    InfoRow("Pending", state.queueCounts.pending.toString())
                    InfoRow("Waiting to retry", state.queueCounts.retrying.toString())
                    InfoRow("Rejected", state.queueCounts.rejected.toString())
                    HorizontalDivider()
                    InfoRow("Last successful sync", state.lastSuccessfulSyncAt ?: "Not yet synced")
                    state.policy?.let {
                        InfoRow("Accepted policy", it.policyVersion)
                        InfoRow("Policy hash", it.contentHash)
                    }
                }
            }
        }
        item { PrimaryAction("Sync now", onSync) }
    }
}

@Composable
private fun DiagnosticsScreen(modifier: Modifier, state: CalloraUiState) {
    ScreenList(modifier) {
        item {
            Heading("Diagnostics")
            Text("Logs contain only operation names and redacted error codes. Phone numbers, pairing codes, and credentials are never shown here.")
        }
        if (state.recentErrors.isEmpty()) {
            item { StatusBanner("No recent errors", "The collector has no stored diagnostic failures.") }
        } else {
            items(state.recentErrors) { error ->
                ElevatedCard {
                    Text(error, Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun SettingsScreen(
    modifier: Modifier,
    state: CalloraUiState,
    onSaveApiUrl: (String) -> Unit,
    onRotate: () -> Unit,
    onRevoke: () -> Unit,
) {
    var apiUrl by rememberSaveable(state.apiBaseUrl) { mutableStateOf(state.apiBaseUrl) }
    var confirmRevoke by remember { mutableStateOf(false) }
    ScreenList(modifier) {
        item {
            Heading("Settings")
            Text("Production builds require HTTPS. Debug builds additionally allow the Android emulator loopback address for local integration.")
        }
        if (BuildConfig.DEBUG) {
            item {
                OutlinedTextField(
                    value = apiUrl,
                    onValueChange = { apiUrl = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("API base URL") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                )
            }
            item { PrimaryAction("Save API address") { onSaveApiUrl(apiUrl) } }
        } else {
            item { InfoRow("API origin", state.apiBaseUrl) }
        }
        item {
            ElevatedCard {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Device session", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    InfoRow("Expires", state.sessionExpiresAt ?: "Unavailable")
                    Text("Rotation creates an encrypted pending credential, confirms it with the server, then promotes it without an authentication gap. Interrupted responses resume with the same request ID.")
                    OutlinedButton(
                        onClick = onRotate,
                        enabled = !state.busy,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    ) { Text("Rotate session credential") }
                }
            }
        }
        item {
            ElevatedCard(colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Stop collection", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text("This withdraws consent, stops scheduled work, and immediately clears queued call rows. The encrypted session credential is retained only when needed to retry server revocation, then deleted.")
                    Button(
                        onClick = { confirmRevoke = true },
                        enabled = !state.busy,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    ) { Text("Revoke device and withdraw consent") }
                }
            }
        }
    }
    if (confirmRevoke) {
        AlertDialog(
            onDismissRequest = { confirmRevoke = false },
            title = { Text("Stop all collection?") },
            text = { Text("Pending local call metadata will be deleted. This action cannot be undone from the phone.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmRevoke = false
                    onRevoke()
                }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Stop and revoke") }
            },
            dismissButton = {
                TextButton(onClick = { confirmRevoke = false }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("Cancel")
                }
            },
        )
    }
}

@Composable
private fun RevokedScreen(
    modifier: Modifier,
    revocationPending: Boolean,
    onRetryRevocation: () -> Unit,
    onReset: () -> Unit,
) {
    ScreenList(modifier) {
        item {
            Heading("Collection is stopped")
            Text("Scheduled sync is cancelled and the encrypted local call queue has been cleared. No new call metadata is read.")
        }
        item {
            StatusBanner(
                if (revocationPending) "Server revocation pending" else "Device revoked",
                if (revocationPending) "Collection is stopped locally. An encrypted session credential is retained only for the retry. Reconnect and retry, or ask an administrator to revoke the device."
                else "Ask an administrator for a new pairing code if this phone should be enrolled again.",
            )
        }
        if (revocationPending) item { PrimaryAction("Retry server revocation", onRetryRevocation) }
        item {
            Button(
                onClick = onReset,
                enabled = !revocationPending,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) { Text("Start a new setup") }
        }
    }
}

@Composable
private fun ReadyNavigation(selected: ReadySection, onSelected: (ReadySection) -> Unit) {
    NavigationBar {
        ReadySection.entries.forEach { section ->
            val label = when (section) {
                ReadySection.LEADS -> "Leads"
                ReadySection.STATUS -> "Status"
                ReadySection.DIAGNOSTICS -> "Health"
                ReadySection.SETTINGS -> "Settings"
            }
            NavigationBarItem(
                selected = selected == section,
                onClick = { onSelected(section) },
                icon = {
                    Box(
                        Modifier.size(8.dp)
                            .background(MaterialTheme.colorScheme.primary, CircleShape)
                            .semantics { contentDescription = "$label tab" },
                    )
                },
                label = { Text(label) },
            )
        }
    }
}

@Composable
private fun ScreenList(modifier: Modifier, content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit) {
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        content = content,
    )
}

@Composable
private fun Heading(text: String) {
    Text(
        text,
        modifier = Modifier.fillMaxWidth().semantics { heading() },
        style = MaterialTheme.typography.headlineSmall,
        fontWeight = FontWeight.Bold,
    )
}

@Composable
private fun StatusBanner(title: String, body: String) {
    ElevatedCard(colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text(body)
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun PrimaryAction(label: String, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
    ) { Text(label) }
}

private fun friendlyError(code: String): String = when (code) {
    "PAIRING_CODE_INVALID", "NOT_FOUND" -> "The pairing code is invalid or expired."
    "CONFLICT" -> "This code or installation has already been used."
    "RATE_LIMITED" -> "Too many attempts. Please wait and try again."
    "UNAUTHENTICATED" -> "The device session is no longer valid."
    "CONSENT_REQUIRED" -> "The organization requires the current policy to be accepted before collection can continue."
    "POLICY_COLLECTION_MODE_MISMATCH" -> "This policy is for a different app collection mode. Collection remains off."
    "POLICY_PURPOSE_MISMATCH" -> "This policy does not authorize call-metadata collection. Collection remains off."
    "POLICY_ID_MISMATCH", "POLICY_HASH_MISMATCH" -> "The policy changed during setup. Collection remains off; reload the authoritative policy."
    "API_URL_INVALID" -> "Enter an allowed API address. Production requires HTTPS."
    "REVOCATION_PENDING" -> "Complete server revocation before starting a new setup."
    "REVOCATION_CREDENTIAL_MISSING" -> "The local revocation credential is unavailable. Collection remains stopped; ask an administrator to revoke this device."
    else -> "The operation could not be completed ($code)."
}
