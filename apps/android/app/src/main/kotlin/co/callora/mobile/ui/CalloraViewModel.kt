package co.callora.mobile.ui

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import co.callora.mobile.AppContainer
import co.callora.mobile.BuildConfig
import co.callora.mobile.calls.VariantCapabilities
import co.callora.mobile.core.logging.SafeLog
import co.callora.mobile.core.model.DeviceCredentials
import co.callora.mobile.core.model.DevicePermissionReport
import co.callora.mobile.core.model.PermissionState
import co.callora.mobile.core.onboarding.OnboardingSnapshot
import co.callora.mobile.core.onboarding.OnboardingStage
import co.callora.mobile.core.protocol.AuthoritativePolicyDocument
import co.callora.mobile.core.protocol.AuthoritativePolicyValidator
import co.callora.mobile.core.protocol.ConsentReceipt
import co.callora.mobile.core.protocol.MobileProtocolState
import co.callora.mobile.core.protocol.PolicyValidationException
import co.callora.mobile.core.protocol.ProtocolRecoveryPlanner
import co.callora.mobile.core.protocol.ProtocolPhase
import co.callora.mobile.core.protocol.RotationConcurrencyGate
import co.callora.mobile.data.api.BootstrapCredential
import co.callora.mobile.data.api.AssignedLead
import co.callora.mobile.data.api.AssignedLeadSummary
import co.callora.mobile.data.api.DeviceRegistration
import co.callora.mobile.data.api.LeadUpdateDraft
import co.callora.mobile.data.api.MobileLeadStatus
import co.callora.mobile.data.api.MobileApiException
import co.callora.mobile.data.local.LeadMutationEnqueueResult
import co.callora.mobile.data.local.LeadMutationEnqueueGate
import co.callora.mobile.data.local.LeadMutationEnqueueGateDecision
import co.callora.mobile.data.local.QueueCounts
import co.callora.mobile.data.local.LocalCallItem
import co.callora.mobile.sync.SyncScheduler
import java.time.Instant
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

enum class ReadySection { CALLS, LEADS, STATUS, DIAGNOSTICS, SETTINGS }

data class LeadUpdateComposer(
    val lead: AssignedLead,
    val postCall: Boolean,
)

data class CalloraUiState(
    val onboarding: OnboardingSnapshot = OnboardingSnapshot(
        permissionRequired = VariantCapabilities.requiresCallLogPermission,
    ),
    val pairingCode: String = "",
    val policy: AuthoritativePolicyDocument? = null,
    val busy: Boolean = false,
    val message: String? = null,
    val errorCode: String? = null,
    val section: ReadySection = ReadySection.CALLS,
    val recentCalls: List<LocalCallItem> = emptyList(),
    val assignedLeads: List<AssignedLead> = emptyList(),
    val leadSummary: AssignedLeadSummary = AssignedLeadSummary(0, 0, 0, 0),
    val leadsLoading: Boolean = false,
    val leadsErrorCode: String? = null,
    val leadsGeneratedAt: String? = null,
    val leadStatuses: List<MobileLeadStatus> = emptyList(),
    val pendingLeadMutationIds: Set<String> = emptySet(),
    val conflictedLeadMutationIds: Set<String> = emptySet(),
    val rejectedLeadMutationIds: Set<String> = emptySet(),
    val leadUpdateComposer: LeadUpdateComposer? = null,
    val leadMutationSaving: Boolean = false,
    val queueCounts: QueueCounts = QueueCounts(0, 0, 0),
    val lastSuccessfulSyncAt: String? = null,
    val recentErrors: List<String> = emptyList(),
    val apiBaseUrl: String = BuildConfig.DEFAULT_API_BASE_URL,
    val sessionExpiresAt: String? = null,
    val revocationPending: Boolean = false,
    /** Non-null exactly once per policy hash, immediately after enterprise activation. */
    val permissionPromptKey: String? = null,
)

class CalloraViewModel(
    application: Application,
    private val container: AppContainer,
) : AndroidViewModel(application) {
    private val _state = MutableStateFlow(CalloraUiState())
    val state: StateFlow<CalloraUiState> = _state.asStateFlow()
    private val protocolMutex = Mutex()
    private val postDialReturn = PostDialReturnTracker()

    init {
        viewModelScope.launch {
            var protocol = readProtocolOrFailClosed()
            var startupCredential = container.credentialVault.read()
            if (ProtocolRecoveryPlanner.requiresLocalRevocationPurge(
                    revocationPending = container.preferences.revocationPending,
                    state = protocol,
                    hasActiveCredential = startupCredential != null,
                )
            ) {
                container.preferences.disclosureAccepted = false
                container.preferences.disclosureAcceptedAt = null
                container.preferences.consentStale = true
                container.preferences.revoked = true
                // Publish the fail-closed intent before erasing the journal. If the
                // process dies anywhere in the purge, the next launch repairs again.
                container.preferences.revocationPending = true
                container.preferences.permissionPromptedPolicyHash = null
                SyncScheduler.cancel(getApplication())
                withContext(Dispatchers.IO) {
                    container.collectionMutex.withLock {
                        container.credentialVault.clear(destroyKey = true)
                        container.protocolVault.clear(destroyKey = true)
                        container.purgeLocalCallData()
                        container.preferences.clearOperationalState()
                    }
                }
                container.preferences.consentStale = false
                container.preferences.regenerateInstallationId()
                container.preferences.revocationPending = false
                protocol = MobileProtocolState()
                startupCredential = null
            }
            if (ProtocolRecoveryPlanner.requiresAuthoritativePolicyFetch(protocol, startupCredential != null)) {
                protocol = MobileProtocolState(
                    phase = ProtocolPhase.RECONSENT_POLICY_PENDING,
                    operationCredentials = startupCredential,
                )
                container.protocolVault.write(protocol)
                stopCollectionForReconsent()
            }
            refreshNow()
            if (protocol.hasPendingMutation || protocol.phase == ProtocolPhase.RECONSENT_POLICY_PENDING) {
                executeProtocol { resumeProtocol(protocol) }
            }
        }
        viewModelScope.launch {
            var previousPending = emptySet<String>()
            container.leadMutations.observeQueueState().collect { queueState ->
                val completed = previousPending - queueState.pendingLeadIds
                previousPending = queueState.pendingLeadIds
                _state.update {
                    it.copy(
                        pendingLeadMutationIds = queueState.pendingLeadIds,
                        conflictedLeadMutationIds = queueState.conflictedLeadIds,
                        rejectedLeadMutationIds = queueState.rejectedLeadIds,
                    )
                }
                if (completed.isNotEmpty() && state.value.onboarding.stage == OnboardingStage.READY &&
                    !state.value.leadsLoading
                ) {
                    container.credentialVault.read()?.let { loadAssignedLeads(it) }
                }
            }
        }
    }

    fun updatePairingCode(value: String) {
        val normalized = value.uppercase(Locale.ROOT).filter { it.isLetterOrDigit() || it == '-' }.take(32)
        _state.update { it.copy(pairingCode = normalized, errorCode = null) }
    }

    /** Pair first; this operation reads no call metadata and fetches the authoritative policy. */
    fun pairAndFetchPolicy() {
        val code = state.value.pairingCode.trim()
        if (code.length < 6) {
            _state.update { it.copy(errorCode = "PAIRING_CODE_INVALID") }
            return
        }
        launchProtocol {
            val existing = readProtocolOrFailClosed()
            val pendingCode = existing.pairingCode
            val pending = existing.phase == ProtocolPhase.REDEEM_PENDING &&
                pendingCode != null && pendingCode == code
            val protocol = if (pending) existing else beginFreshPairing(code)
            performRedeem(protocol)
            "Device identity confirmed. Review the organization policy before activation."
        }
    }

    fun retryPolicyFetch() {
        launchProtocol {
            val protocol = readProtocolOrFailClosed()
            when (protocol.phase) {
                ProtocolPhase.ACTIVATION_POLICY_PENDING -> performActivationPolicyFetch(protocol)
                ProtocolPhase.RECONSENT_POLICY_PENDING -> performReconsentPolicyFetch(protocol)
                else -> error("No policy fetch is pending")
            }
            "Updated organization policy loaded."
        }
    }

    fun retrySecureRecovery() {
        launchProtocol {
            val protocol = readProtocolOrFailClosed()
            check(protocol.hasPendingMutation) { "No secure recovery operation is pending" }
            resumeProtocol(protocol)
        }
    }

    /** The click is journaled before activation/re-consent is attempted. */
    fun acceptPolicyAndContinue() {
        launchProtocol {
            val protocol = readProtocolOrFailClosed()
            when (protocol.phase) {
                ProtocolPhase.DISCLOSURE_READY -> {
                    if (performActivation(beginActivation(protocol))) {
                        "Policy accepted and device activated."
                    } else {
                        "The organization policy changed after activation. Review the current disclosure."
                    }
                }
                ProtocolPhase.ACTIVATION_PENDING -> {
                    if (performActivation(protocol)) {
                        "Activation response reconciled."
                    } else {
                        "Activation reconciled; review the current organization policy."
                    }
                }
                ProtocolPhase.RECONSENT_READY -> {
                    performReconsent(beginReconsent(protocol))
                    "Updated policy accepted."
                }
                ProtocolPhase.RECONSENT_PENDING -> {
                    performReconsent(protocol)
                    "Consent response reconciled."
                }
                else -> error("No authoritative policy is ready for acceptance")
            }
        }
    }

    fun permissionRequestStarted(policyHash: String) {
        if (state.value.permissionPromptKey != policyHash) return
        // Commit before invoking Android so process death cannot create a prompt loop.
        container.preferences.permissionPromptedPolicyHash = policyHash
        _state.update { it.copy(permissionPromptKey = null) }
    }

    fun permissionObserved(granted: Boolean) {
        refresh(message = if (granted) "Call-log access granted." else "Permission denied. Collection remains off.")
        if (granted) SyncScheduler.runNow(getApplication())
    }

    fun selectSection(section: ReadySection) {
        _state.update { it.copy(section = section) }
        if (section == ReadySection.LEADS) refreshAssignedLeads()
        if (section == ReadySection.CALLS) refresh()
    }

    fun refreshAssignedLeads() {
        viewModelScope.launch {
            val credentials = container.credentialVault.read()
            if (credentials == null) {
                _state.update { it.copy(leadsLoading = false, leadsErrorCode = "UNAUTHENTICATED") }
                return@launch
            }
            loadAssignedLeads(credentials)
        }
    }

    fun openLeadUpdate(leadId: String, postCall: Boolean = false) {
        val lead = state.value.assignedLeads.firstOrNull { it.id == leadId }
        if (lead == null) {
            _state.update { it.copy(errorCode = "LEAD_NOT_AVAILABLE") }
            return
        }
        if (leadId in state.value.pendingLeadMutationIds) {
            _state.update { it.copy(message = "An update for this lead is already waiting to sync.") }
            return
        }
        _state.update {
            it.copy(
                leadUpdateComposer = LeadUpdateComposer(lead, postCall),
                errorCode = null,
            )
        }
    }

    fun dismissLeadUpdate() {
        if (!state.value.leadMutationSaving) _state.update { it.copy(leadUpdateComposer = null) }
    }

    fun submitLeadUpdate(draft: LeadUpdateDraft) {
        if (state.value.leadMutationSaving) return
        _state.update { it.copy(leadMutationSaving = true, errorCode = null, message = null) }
        viewModelScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    container.collectionMutex.withLock {
                        val protocol = runCatching { container.protocolVault.read() }.getOrNull()
                        val decision = LeadMutationEnqueueGate.evaluate(
                            phase = protocol?.phase,
                            hasPolicy = protocol?.policy != null,
                            hasConsent = protocol?.consent != null,
                            disclosureAccepted = container.preferences.disclosureAccepted,
                            consentStale = container.preferences.consentStale,
                            revoked = container.preferences.revoked,
                            credentials = container.credentialVault.read(),
                        )
                        when (decision) {
                            is LeadMutationEnqueueGateDecision.Open ->
                                container.leadMutations.enqueue(decision.credentials, draft)
                            LeadMutationEnqueueGateDecision.Closed -> error("LEAD_UPDATE_GATE_CLOSED")
                        }
                    }
                }
                SyncScheduler.runLeadMutationsNow(getApplication())
                _state.update {
                    it.copy(
                        leadMutationSaving = false,
                        leadUpdateComposer = null,
                        message = when (result) {
                            is LeadMutationEnqueueResult.Queued -> "Lead update queued securely."
                            is LeadMutationEnqueueResult.AlreadyPending ->
                                "An update for this lead is already waiting to sync."
                        },
                    )
                }
            } catch (error: Throwable) {
                SafeLog.warn("CalloraUi", "Lead update enqueue failed", error)
                val code = error.message?.takeIf { value -> value.matches(Regex("^[A-Z0-9_]+$")) }
                    ?: "LEAD_UPDATE_INVALID"
                _state.update {
                    it.copy(
                        leadMutationSaving = false,
                        leadUpdateComposer = if (code == "LEAD_UPDATE_GATE_CLOSED") null else it.leadUpdateComposer,
                        errorCode = code,
                    )
                }
            }
        }
    }

    /** Called immediately before ACTION_DIAL; it does not imply that a call occurred. */
    fun markDialerLaunch(leadId: String) {
        postDialReturn.launched(leadId)
    }

    fun onHostStopped() {
        postDialReturn.hostStopped()
    }

    fun onHostResumed() {
        postDialReturn.hostResumed()?.let { openLeadUpdate(it, postCall = true) }
    }

    fun dialLaunchFailed() {
        postDialReturn.failed()
        _state.update { it.copy(errorCode = "DIAL_UNAVAILABLE") }
    }

    fun syncNow() {
        SyncScheduler.runNow(getApplication())
        SyncScheduler.runLeadMutationsNow(getApplication())
        refresh(message = "Sync scheduled when a network is available.")
    }

    fun saveApiBaseUrl(value: String) {
        runCatching { container.preferences.apiBaseUrl = value }
            .onSuccess { refresh(message = "API address saved.") }
            .onFailure { _state.update { current -> current.copy(errorCode = "API_URL_INVALID") } }
    }

    fun rotateSession() {
        launchProtocol {
            check(readProtocolOrFailClosed().phase == ProtocolPhase.IDLE) {
                "Another mobile protocol operation is pending"
            }
            SyncScheduler.cancel(getApplication())
            val pending = withContext(Dispatchers.IO) {
                RotationConcurrencyGate.drainAndCommit(container.collectionMutex) {
                    // Re-read after draining: a worker that owned the mutex may have
                    // closed consent/revocation while this action was waiting.
                    val protocol = container.protocolVault.read()
                    check(protocol.phase == ProtocolPhase.IDLE) {
                        "Another mobile protocol operation is pending"
                    }
                    val current = checkNotNull(container.credentialVault.read()) { "No session credential" }
                    protocol.copy(
                        phase = ProtocolPhase.ROTATION_PREPARE_PENDING,
                        requestId = UUID.randomUUID().toString(),
                        prepareRequestId = null,
                        proposedSessionToken = container.credentialGenerator.session(),
                        proposedSessionExpiresAt = null,
                        preparedAt = null,
                        operationCredentials = current,
                    ).also(container.protocolVault::write)
                }
            }
            performRotationPrepare(pending)
            "Session credential rotated with two-phase confirmation."
        }
    }

    fun revokeAndWithdrawConsent() {
        launchProtocol {
            val existing = readProtocolOrFailClosed()
            val current = container.credentialVault.read()
            if (current == null) {
                completeLocalOnlyRevocation()
                return@launchProtocol "Collection stopped locally; no server credential remained."
            }
            val pending = if (existing.phase == ProtocolPhase.REVOKE_PENDING) {
                existing
            } else {
                existing.copy(
                    phase = ProtocolPhase.REVOKE_PENDING,
                    requestId = UUID.randomUUID().toString(),
                    operationCredentials = current,
                ).also(container.protocolVault::write)
            }
            stopCollectionForRevocation()
            performRevocation(pending)
            "Consent withdrawn and device revoked."
        }
    }

    fun retryServerRevocation() {
        launchProtocol {
            val pending = readProtocolOrFailClosed()
            check(pending.phase == ProtocolPhase.REVOKE_PENDING) { "No server revocation is pending" }
            performRevocation(pending)
            "Server revocation completed."
        }
    }

    fun resetRevokedDevice() {
        if (container.preferences.revocationPending) {
            _state.update { it.copy(errorCode = "REVOCATION_PENDING") }
            return
        }
        viewModelScope.launch {
            protocolMutex.withLock {
                SyncScheduler.cancel(getApplication())
                withContext(Dispatchers.IO) {
                    container.collectionMutex.withLock {
                        container.credentialVault.clear(destroyKey = true)
                        container.protocolVault.clear(destroyKey = true)
                        container.purgeLocalCallData()
                        container.preferences.clearOperationalState()
                    }
                }
                container.preferences.revoked = false
                container.preferences.consentStale = false
                container.preferences.disclosureAccepted = false
                container.preferences.disclosureAcceptedAt = null
                container.preferences.permissionPromptedPolicyHash = null
                container.preferences.regenerateInstallationId()
                refreshNow()
            }
        }
    }

    fun dismissMessage() {
        _state.update { it.copy(message = null, errorCode = null) }
    }

    private suspend fun beginFreshPairing(code: String): MobileProtocolState {
        SyncScheduler.cancel(getApplication())
        withContext(Dispatchers.IO) {
            container.collectionMutex.withLock {
                container.credentialVault.clear(destroyKey = true)
                container.protocolVault.clear(destroyKey = true)
                container.purgeLocalCallData()
                container.preferences.clearOperationalState()
            }
        }
        container.preferences.disclosureAccepted = false
        container.preferences.disclosureAcceptedAt = null
        container.preferences.consentStale = false
        container.preferences.revoked = false
        container.preferences.revocationPending = false
        container.preferences.permissionPromptedPolicyHash = null
        val installationId = container.preferences.regenerateInstallationId()
        val protocol = MobileProtocolState(
            phase = ProtocolPhase.REDEEM_PENDING,
            requestId = UUID.randomUUID().toString(),
            installationId = installationId,
            pairingCode = code,
            proposedBootstrapToken = container.credentialGenerator.bootstrap(),
        )
        container.protocolVault.write(protocol)
        return protocol
    }

    private suspend fun performRedeem(protocol: MobileProtocolState) {
        check(protocol.phase == ProtocolPhase.REDEEM_PENDING)
        val requestId = checkNotNull(protocol.requestId)
        val installationId = checkNotNull(protocol.installationId)
        val proposedBootstrap = checkNotNull(protocol.proposedBootstrapToken)
        val bootstrap = container.api.redeemBootstrap(
            registration = DeviceRegistration(
                pairingCode = checkNotNull(protocol.pairingCode),
                installationId = installationId,
                manufacturer = Build.MANUFACTURER.orEmpty(),
                model = Build.MODEL.orEmpty(),
                osVersion = Build.VERSION.RELEASE.orEmpty(),
                appVersion = BuildConfig.VERSION_NAME,
                collectionMode = BuildConfig.COLLECTION_MODE,
                permissions = currentPermissionReport(),
            ),
            requestId = requestId,
            proposedBootstrapToken = proposedBootstrap,
        )
        val policy = container.api.fetchCollectionPolicy(proposedBootstrap)
        AuthoritativePolicyValidator.requireCompatible(policy, BuildConfig.COLLECTION_MODE)
        container.protocolVault.write(
            protocol.copy(
                phase = ProtocolPhase.DISCLOSURE_READY,
                requestId = null,
                pairingCode = null,
                bootstrapOrganizationId = bootstrap.organizationId,
                bootstrapEmployeeId = bootstrap.employeeId,
                bootstrapDeviceId = bootstrap.deviceId,
                bootstrapExpiresAt = bootstrap.expiresAt,
                policy = policy,
            ),
        )
    }

    private fun beginActivation(protocol: MobileProtocolState): MobileProtocolState {
        val policy = protocol.requirePolicy()
        val acceptedAt = Instant.now().toString()
        return protocol.copy(
            phase = ProtocolPhase.ACTIVATION_PENDING,
            requestId = UUID.randomUUID().toString(),
            proposedSessionToken = container.credentialGenerator.session(),
            collectionStartsAtEpochMillis = System.currentTimeMillis(),
            consent = ConsentReceipt(
                policyId = policy.id,
                contentHash = policy.contentHash,
                acceptedAt = acceptedAt,
                locale = Locale.getDefault().toLanguageTag(),
            ),
        ).also(container.protocolVault::write)
    }

    /** Returns true only when the acknowledged consent is still authoritative now. */
    private suspend fun performActivation(protocol: MobileProtocolState): Boolean {
        check(protocol.phase == ProtocolPhase.ACTIVATION_PENDING)
        val policy = protocol.requirePolicy()
        val consent = checkNotNull(protocol.consent)
        AuthoritativePolicyValidator.requireCompatible(policy, BuildConfig.COLLECTION_MODE)
        require(consent.policyId == policy.id && consent.contentHash == policy.contentHash) {
            "POLICY_HASH_MISMATCH"
        }
        val bootstrap = BootstrapCredential(
            organizationId = checkNotNull(protocol.bootstrapOrganizationId),
            employeeId = checkNotNull(protocol.bootstrapEmployeeId),
            deviceId = checkNotNull(protocol.bootstrapDeviceId),
            token = checkNotNull(protocol.proposedBootstrapToken),
            expiresAt = checkNotNull(protocol.bootstrapExpiresAt),
        )
        val credentials = container.api.activateBootstrap(
            bootstrap = bootstrap,
            requestId = checkNotNull(protocol.requestId),
            proposedSessionToken = checkNotNull(protocol.proposedSessionToken),
            consent = consent,
            permissions = currentPermissionReport(),
        )
        container.credentialVault.write(credentials)
        // Exact activation replay may remain valid after policy rollover. Journal a
        // fail-closed new-session preflight before the old disclosure can open the
        // enterprise permission prompt or collection gate.
        val preflight = MobileProtocolState(
            phase = ProtocolPhase.RECONSENT_POLICY_PENDING,
            operationCredentials = credentials,
        )
        container.protocolVault.write(preflight)
        stopCollectionForReconsent()
        val currentPolicy = container.api.fetchCollectionPolicy(credentials.sessionToken)
        AuthoritativePolicyValidator.requireCompatible(currentPolicy, BuildConfig.COLLECTION_MODE)
        if (ProtocolRecoveryPlanner.requiresReconsentAfterActivation(consent, currentPolicy)) {
            container.protocolVault.write(
                preflight.copy(
                    phase = ProtocolPhase.RECONSENT_READY,
                    policy = currentPolicy,
                ),
            )
            return false
        }
        val acknowledged = protocol.copy(policy = currentPolicy)
        // IDLE is written before the local gate opens. A crash between these commits is
        // repaired from this acknowledged journal without repeating user consent.
        commitIdleJournal(acknowledged.toIdle())
        commitAcknowledgedConsent(acknowledged)
        return true
    }

    private suspend fun performActivationPolicyFetch(protocol: MobileProtocolState) {
        check(protocol.phase == ProtocolPhase.ACTIVATION_POLICY_PENDING)
        stopCollectionForReconsent()
        val policy = container.api.fetchCollectionPolicy(checkNotNull(protocol.proposedBootstrapToken))
        AuthoritativePolicyValidator.requireCompatible(policy, BuildConfig.COLLECTION_MODE)
        container.protocolVault.write(
            protocol.copy(
                phase = ProtocolPhase.DISCLOSURE_READY,
                requestId = null,
                policy = policy,
                expectedPolicyId = null,
                expectedPolicyHash = null,
                proposedSessionToken = null,
                proposedSessionExpiresAt = null,
                preparedAt = null,
                collectionStartsAtEpochMillis = null,
                consent = null,
                operationCredentials = null,
            ),
        )
    }

    private fun beginReconsent(protocol: MobileProtocolState): MobileProtocolState {
        val policy = protocol.requirePolicy()
        return protocol.copy(
            phase = ProtocolPhase.RECONSENT_PENDING,
            requestId = UUID.randomUUID().toString(),
            collectionStartsAtEpochMillis = System.currentTimeMillis(),
            consent = ConsentReceipt(
                policyId = policy.id,
                contentHash = policy.contentHash,
                acceptedAt = Instant.now().toString(),
                locale = Locale.getDefault().toLanguageTag(),
            ),
        ).also(container.protocolVault::write)
    }

    private suspend fun performReconsentPolicyFetch(protocol: MobileProtocolState) {
        stopCollectionForReconsent()
        val credentials = protocol.operationCredentials ?: checkNotNull(container.credentialVault.read())
        val policy = container.api.fetchCollectionPolicy(credentials.sessionToken)
        AuthoritativePolicyValidator.requireCompatible(
            policy = policy,
            collectionMode = BuildConfig.COLLECTION_MODE,
            expectedId = protocol.expectedPolicyId,
            expectedHash = protocol.expectedPolicyHash,
        )
        container.protocolVault.write(
            protocol.copy(
                phase = ProtocolPhase.RECONSENT_READY,
                requestId = null,
                policy = policy,
            ),
        )
    }

    private suspend fun performReconsent(protocol: MobileProtocolState) {
        check(protocol.phase == ProtocolPhase.RECONSENT_PENDING)
        val credentials = protocol.operationCredentials ?: checkNotNull(container.credentialVault.read())
        val policy = protocol.requirePolicy()
        val consent = checkNotNull(protocol.consent)
        AuthoritativePolicyValidator.requireCompatible(
            policy,
            BuildConfig.COLLECTION_MODE,
            protocol.expectedPolicyId,
            protocol.expectedPolicyHash,
        )
        container.api.reconsent(
            credentials = credentials,
            requestId = checkNotNull(protocol.requestId),
            consent = consent,
            permissions = currentPermissionReport(),
        )
        commitIdleJournal(protocol.toIdle())
        commitAcknowledgedConsent(protocol)
    }

    private suspend fun performRotationPrepare(protocol: MobileProtocolState) {
        check(protocol.phase == ProtocolPhase.ROTATION_PREPARE_PENDING)
        val current = checkNotNull(protocol.operationCredentials)
        val requestId = checkNotNull(protocol.requestId)
        val proposed = checkNotNull(protocol.proposedSessionToken)
        val preparation = container.api.prepareSessionRotation(current, requestId, proposed)
        val confirming = protocol.copy(
            phase = ProtocolPhase.ROTATION_CONFIRM_PENDING,
            requestId = UUID.randomUUID().toString(),
            prepareRequestId = requestId,
            proposedSessionExpiresAt = preparation.expiresAt,
            preparedAt = preparation.preparedAt,
        )
        container.protocolVault.write(confirming)
        performRotationConfirm(confirming)
    }

    private suspend fun performRotationConfirm(protocol: MobileProtocolState) {
        check(protocol.phase == ProtocolPhase.ROTATION_CONFIRM_PENDING)
        val current = checkNotNull(protocol.operationCredentials)
        val pending = current.copy(
            sessionToken = checkNotNull(protocol.proposedSessionToken),
            expiresAt = checkNotNull(protocol.proposedSessionExpiresAt),
        )
        val confirmed = container.api.confirmSessionRotation(
            pendingCredentials = pending,
            requestId = checkNotNull(protocol.requestId),
            prepareRequestId = checkNotNull(protocol.prepareRequestId),
        )
        container.credentialVault.write(confirmed)
        commitIdleJournal(protocol.toIdle())
        if (ProtocolRecoveryPlanner.requiresImmediatePreflightAfter(protocol.phase)) {
            SyncScheduler.runNow(getApplication())
        }
    }

    private suspend fun stopCollectionForReconsent() {
        container.preferences.disclosureAccepted = false
        container.preferences.disclosureAcceptedAt = null
        container.preferences.consentStale = true
        container.preferences.permissionPromptedPolicyHash = null
        SyncScheduler.cancel(getApplication())
        withContext(Dispatchers.IO) {
            container.collectionMutex.withLock {
                container.purgeLocalCallData()
                container.preferences.clearOperationalState()
            }
        }
    }

    private suspend fun stopCollectionForRevocation() {
        container.preferences.disclosureAccepted = false
        container.preferences.disclosureAcceptedAt = null
        container.preferences.consentStale = true
        container.preferences.revoked = true
        container.preferences.revocationPending = true
        container.preferences.permissionPromptedPolicyHash = null
        SyncScheduler.cancel(getApplication())
        withContext(Dispatchers.IO) {
            container.collectionMutex.withLock {
                container.purgeLocalCallData()
                container.preferences.clearOperationalState()
            }
        }
    }

    private suspend fun performRevocation(protocol: MobileProtocolState) {
        check(protocol.phase == ProtocolPhase.REVOKE_PENDING)
        val credentials = checkNotNull(protocol.operationCredentials)
        container.api.revokeSession(credentials, checkNotNull(protocol.requestId))
        container.credentialVault.clear(destroyKey = true)
        container.protocolVault.clear(destroyKey = true)
        container.preferences.consentStale = false
        container.preferences.regenerateInstallationId()
        // Final synchronous commit: startup can repair every earlier crash boundary.
        container.preferences.revocationPending = false
    }

    private suspend fun completeLocalOnlyRevocation() {
        val local = MobileProtocolState(
            phase = ProtocolPhase.REVOKE_PENDING,
            requestId = UUID.randomUUID().toString(),
        )
        container.protocolVault.write(local)
        stopCollectionForRevocation()
        container.protocolVault.clear(destroyKey = true)
        container.preferences.consentStale = false
        container.preferences.regenerateInstallationId()
        container.preferences.revocationPending = false
    }

    private suspend fun resumeProtocol(protocol: MobileProtocolState): String = when (protocol.phase) {
        ProtocolPhase.REDEEM_PENDING -> {
            performRedeem(protocol)
            "Pairing response reconciled. Review the organization policy."
        }
        ProtocolPhase.ACTIVATION_PENDING -> {
            if (performActivation(protocol)) {
                "Activation response reconciled."
            } else {
                "Activation reconciled; review the current organization policy."
            }
        }
        ProtocolPhase.ACTIVATION_POLICY_PENDING -> {
            performActivationPolicyFetch(protocol)
            "Current organization policy loaded."
        }
        ProtocolPhase.RECONSENT_POLICY_PENDING -> {
            performReconsentPolicyFetch(protocol)
            "Updated organization policy loaded."
        }
        ProtocolPhase.RECONSENT_PENDING -> {
            performReconsent(protocol)
            "Consent response reconciled."
        }
        ProtocolPhase.ROTATION_PREPARE_PENDING -> {
            performRotationPrepare(protocol)
            "Session rotation reconciled."
        }
        ProtocolPhase.ROTATION_CONFIRM_PENDING -> {
            performRotationConfirm(protocol)
            "Session rotation confirmation reconciled."
        }
        ProtocolPhase.REVOKE_PENDING -> {
            stopCollectionForRevocation()
            performRevocation(protocol)
            "Server revocation reconciled."
        }
        else -> error("No retryable protocol operation")
    }

    private fun MobileProtocolState.toIdle(): MobileProtocolState = copy(
        phase = ProtocolPhase.IDLE,
        requestId = null,
        prepareRequestId = null,
        installationId = null,
        pairingCode = null,
        proposedBootstrapToken = null,
        bootstrapOrganizationId = null,
        bootstrapEmployeeId = null,
        bootstrapDeviceId = null,
        bootstrapExpiresAt = null,
        expectedPolicyId = null,
        expectedPolicyHash = null,
        proposedSessionToken = null,
        proposedSessionExpiresAt = null,
        preparedAt = null,
        operationCredentials = null,
    )

    /** Destroy the key that protected completed pending secrets before storing public policy state. */
    private fun commitIdleJournal(idle: MobileProtocolState) {
        container.protocolVault.clear(destroyKey = true)
        container.protocolVault.write(idle)
    }

    private fun commitAcknowledgedConsent(protocol: MobileProtocolState) {
        val consent = checkNotNull(protocol.consent)
        container.preferences.disclosureAcceptedAt = consent.acceptedAt
        container.preferences.lastScanEpochMillis = checkNotNull(protocol.collectionStartsAtEpochMillis)
        container.preferences.consentStale = false
        container.preferences.disclosureAccepted = true
        container.preferences.revoked = false
        container.preferences.revocationPending = false
    }

    private fun launchProtocol(operation: suspend () -> String) {
        viewModelScope.launch { executeProtocol(operation) }
    }

    private suspend fun executeProtocol(operation: suspend () -> String) {
        protocolMutex.withLock {
            _state.update { it.copy(busy = true, errorCode = null, message = null) }
            try {
                val success = operation()
                refreshNow(success)
            } catch (error: Throwable) {
                var reportedError = error
                if (error is MobileApiException && error.code == "CONSENT_REQUIRED") {
                    try {
                        if (recoverFromConsentRequired()) {
                            refreshNow("The organization policy changed. Review the current disclosure.")
                            return@withLock
                        }
                    } catch (recoveryError: Throwable) {
                        // The transition journal is already durable. Policy-loading UI
                        // now exposes retry without replaying the stale mutation.
                        reportedError = recoveryError
                    }
                }
                val code = when (reportedError) {
                    is MobileApiException -> reportedError.code
                    is PolicyValidationException -> reportedError.message ?: "POLICY_MISMATCH"
                    else -> reportedError.message?.takeIf { it.startsWith("POLICY_") } ?: "OPERATION_FAILED"
                }
                SafeLog.warn("CalloraUi", "Protocol operation failed: $code", reportedError)
                refreshNow()
                _state.update { it.copy(busy = false, errorCode = code) }
            }
        }
    }

    private suspend fun recoverFromConsentRequired(): Boolean {
        val protocol = readProtocolOrFailClosed()
        return when (ProtocolRecoveryPlanner.consentRequiredTargetPhase(protocol.phase)) {
            ProtocolPhase.ACTIVATION_POLICY_PENDING -> {
                val pending = protocol.copy(
                    phase = ProtocolPhase.ACTIVATION_POLICY_PENDING,
                    requestId = null,
                    policy = null,
                    expectedPolicyId = null,
                    expectedPolicyHash = null,
                    proposedSessionToken = null,
                    proposedSessionExpiresAt = null,
                    preparedAt = null,
                    collectionStartsAtEpochMillis = null,
                    consent = null,
                    operationCredentials = null,
                )
                container.protocolVault.write(pending)
                performActivationPolicyFetch(pending)
                true
            }
            ProtocolPhase.RECONSENT_POLICY_PENDING -> {
                val credentials = protocol.operationCredentials ?: checkNotNull(container.credentialVault.read())
                val pending = MobileProtocolState(
                    phase = ProtocolPhase.RECONSENT_POLICY_PENDING,
                    operationCredentials = credentials,
                )
                container.protocolVault.write(pending)
                performReconsentPolicyFetch(pending)
                true
            }
            else -> false
        }
    }

    private fun refresh(message: String? = null) {
        viewModelScope.launch { refreshNow(message) }
    }

    private suspend fun refreshNow(message: String? = null) {
        val protocol = readProtocolOrFailClosed()
        val credentials = container.credentialVault.read()
        if (
            protocol.phase == ProtocolPhase.IDLE && protocol.policy != null && protocol.consent != null &&
            credentials != null && !container.preferences.revoked &&
            (!container.preferences.disclosureAccepted || container.preferences.consentStale)
        ) {
            commitAcknowledgedConsent(protocol)
        }
        val sessionValid = credentials?.expiresAt?.let {
            runCatching { Instant.parse(it).isAfter(Instant.now()) }.getOrDefault(false)
        } == true
        val permissionGranted = !VariantCapabilities.requiresCallLogPermission ||
            ContextCompat.checkSelfPermission(
                getApplication(),
                Manifest.permission.READ_CALL_LOG,
            ) == PackageManager.PERMISSION_GRANTED
        val policy = protocol.policy
        val consentTransition = protocol.phase in setOf(
            ProtocolPhase.ACTIVATION_POLICY_PENDING,
            ProtocolPhase.RECONSENT_POLICY_PENDING,
            ProtocolPhase.RECONSENT_READY,
            ProtocolPhase.RECONSENT_PENDING,
        )
        val snapshot = OnboardingSnapshot(
            hasAuthoritativePolicy = policy != null,
            policyLoading = protocol.phase == ProtocolPhase.ACTIVATION_POLICY_PENDING ||
                protocol.phase == ProtocolPhase.RECONSENT_POLICY_PENDING,
            activationPending = protocol.phase == ProtocolPhase.ACTIVATION_PENDING,
            protocolIdle = protocol.phase == ProtocolPhase.IDLE,
            disclosureAccepted = container.preferences.disclosureAccepted && !consentTransition,
            hasDeviceCredential = sessionValid,
            permissionRequired = VariantCapabilities.requiresCallLogPermission,
            permissionGranted = permissionGranted,
            consentStale = container.preferences.consentStale || consentTransition,
            revoked = container.preferences.revoked,
        )
        val (counts, recentCalls) = withContext(Dispatchers.IO) {
            container.queue.counts() to container.queue.recent()
        }
        val promptKey = policy?.contentHash?.takeIf {
            snapshot.stage == OnboardingStage.PERMISSION &&
                container.preferences.permissionPromptedPolicyHash != it
        }
        _state.update {
            it.copy(
                onboarding = snapshot,
                pairingCode = protocol.pairingCode ?: it.pairingCode,
                policy = policy,
                busy = false,
                message = message ?: it.message,
                queueCounts = counts,
                recentCalls = if (snapshot.stage == OnboardingStage.READY) recentCalls else emptyList(),
                lastSuccessfulSyncAt = container.preferences.lastSuccessfulSyncAt,
                recentErrors = container.preferences.recentErrors(),
                apiBaseUrl = container.preferences.apiBaseUrl,
                sessionExpiresAt = credentials?.expiresAt,
                revocationPending = protocol.phase == ProtocolPhase.REVOKE_PENDING ||
                    container.preferences.revocationPending,
                permissionPromptKey = promptKey,
                assignedLeads = if (snapshot.stage == OnboardingStage.READY) it.assignedLeads else emptyList(),
                leadSummary = if (snapshot.stage == OnboardingStage.READY) it.leadSummary
                else AssignedLeadSummary(0, 0, 0, 0),
                leadsGeneratedAt = if (snapshot.stage == OnboardingStage.READY) it.leadsGeneratedAt else null,
                leadStatuses = if (snapshot.stage == OnboardingStage.READY) it.leadStatuses else emptyList(),
                leadsLoading = if (snapshot.stage == OnboardingStage.READY) it.leadsLoading else false,
                leadsErrorCode = if (snapshot.stage == OnboardingStage.READY) it.leadsErrorCode else null,
                leadUpdateComposer = if (snapshot.stage == OnboardingStage.READY) it.leadUpdateComposer else null,
                leadMutationSaving = if (snapshot.stage == OnboardingStage.READY) it.leadMutationSaving else false,
            )
        }
        if (snapshot.stage == OnboardingStage.READY) {
            SyncScheduler.ensurePeriodic(getApplication())
            if (state.value.section == ReadySection.LEADS && credentials != null &&
                state.value.assignedLeads.isEmpty() && !state.value.leadsLoading
            ) {
                loadAssignedLeads(credentials)
            }
        }
    }

    private suspend fun loadAssignedLeads(credentials: DeviceCredentials) {
        _state.update { it.copy(leadsLoading = true, leadsErrorCode = null) }
        try {
            val statuses = container.api.listLeadStatuses(credentials)
            val page = container.api.listAssignedLeads(credentials)
            _state.update {
                it.copy(
                    assignedLeads = page.items,
                    leadSummary = page.summary,
                    leadStatuses = statuses,
                    leadsGeneratedAt = page.generatedAt,
                    leadsLoading = false,
                    leadsErrorCode = null,
                )
            }
        } catch (error: Throwable) {
            val code = (error as? MobileApiException)?.code ?: "LEADS_UNAVAILABLE"
            SafeLog.warn("CalloraUi", "Assigned lead refresh failed: $code", error)
            _state.update {
                val mustClear = code == "UNAUTHENTICATED" || code == "CONSENT_REQUIRED"
                it.copy(
                    assignedLeads = if (mustClear) emptyList() else it.assignedLeads,
                    leadSummary = if (mustClear) AssignedLeadSummary(0, 0, 0, 0) else it.leadSummary,
                    leadStatuses = if (mustClear) emptyList() else it.leadStatuses,
                    leadsGeneratedAt = if (mustClear) null else it.leadsGeneratedAt,
                    leadsLoading = false,
                    leadsErrorCode = code,
                )
            }
        }
    }

    private suspend fun readProtocolOrFailClosed(): MobileProtocolState = try {
        container.protocolVault.read()
    } catch (error: Throwable) {
        SafeLog.warn("CalloraUi", "Encrypted protocol journal is unreadable", error)
        SyncScheduler.cancel(getApplication())
        withContext(Dispatchers.IO) {
            container.collectionMutex.withLock {
                container.credentialVault.clear(destroyKey = true)
                container.protocolVault.clear(destroyKey = true)
                container.purgeLocalCallData()
                container.preferences.clearOperationalState()
            }
        }
        container.preferences.disclosureAccepted = false
        container.preferences.disclosureAcceptedAt = null
        container.preferences.consentStale = false
        container.preferences.revoked = true
        container.preferences.revocationPending = false
        MobileProtocolState()
    }

    private fun currentPermissionReport(): DevicePermissionReport {
        val callLog = if (!VariantCapabilities.requiresCallLogPermission) {
            PermissionState.UNKNOWN
        } else if (ContextCompat.checkSelfPermission(
                getApplication(),
                Manifest.permission.READ_CALL_LOG,
            ) == PackageManager.PERMISSION_GRANTED
        ) {
            PermissionState.GRANTED
        } else {
            PermissionState.DENIED
        }
        return DevicePermissionReport(callLog = callLog)
    }

    class Factory(
        private val application: Application,
        private val container: AppContainer,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            CalloraViewModel(application, container) as T
    }
}
