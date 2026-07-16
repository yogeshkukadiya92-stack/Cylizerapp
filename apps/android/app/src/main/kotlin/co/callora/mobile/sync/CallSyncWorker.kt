package co.callora.mobile.sync

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import co.callora.mobile.BuildConfig
import co.callora.mobile.CalloraApplication
import co.callora.mobile.calls.MAX_SOURCE_READ
import co.callora.mobile.calls.VariantCapabilities
import co.callora.mobile.core.logging.SafeLog
import co.callora.mobile.core.model.DevicePermissionReport
import co.callora.mobile.core.model.Heartbeat
import co.callora.mobile.core.model.MobileDirective
import co.callora.mobile.core.model.PermissionState
import co.callora.mobile.core.protocol.AuthoritativePolicyValidator
import co.callora.mobile.core.protocol.MobileProtocolState
import co.callora.mobile.core.protocol.ProtocolPhase
import co.callora.mobile.core.security.CredentialDiagnostics
import co.callora.mobile.data.api.MobileApiException
import java.time.Instant
import kotlinx.coroutines.sync.withLock

class CallSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    private val container = (appContext.applicationContext as CalloraApplication).container
    private val dao = container.database.queuedCalls()

    override suspend fun doWork(): Result = container.collectionMutex.withLock {
        performSync()
    }

    private suspend fun performSync(): Result {
        val preferences = container.preferences
        val protocol = runCatching { container.protocolVault.read() }.getOrElse {
            invalidateSessionForRepair()
            preferences.recordError("protocol", "Encrypted protocol journal unreadable")
            return Result.failure()
        }
        val credentials = container.credentialVault.read()
        if (credentials == null) {
            // A missing or unreadable credential must never leave an old tenant's queue
            // available for a later enrollment.
            if (preferences.disclosureAccepted) invalidateSessionForRepair()
            return Result.success()
        }
        SafeLog.info(
            TAG,
            "Worker loaded credential ${CredentialDiagnostics.correlationId(credentials.sessionToken)}",
        )
        // Recover the local half of a stale-consent/revocation transition if the
        // process died immediately after its encrypted journal commit.
        if (protocol.phase in CONSENT_PHASES) {
            closeLocalGateForConsent()
            return Result.success()
        }
        if (protocol.phase == ProtocolPhase.REVOKE_PENDING) {
            closeLocalGateForRevocation()
            return Result.success()
        }
        // Other pending identity mutations also close collection until reconciled.
        if (protocol.phase != ProtocolPhase.IDLE || preferences.consentStale) return Result.success()
        // Upgrades from the Phase 3B Boolean-only consent model must re-consent before
        // any source read. An active session can fetch the exact current policy.
        if (protocol.policy == null || protocol.consent == null) {
            requireFreshConsent(credentials, null, null)
            return Result.success()
        }
        val now = Instant.now()
        if (!preferences.disclosureAccepted || preferences.consentStale || preferences.revoked) return Result.success()
        val expiry = runCatching { Instant.parse(credentials.expiresAt) }.getOrNull()
        if (expiry?.isAfter(now) != true) {
            invalidateSessionForRepair()
            preferences.recordError("session", "Session credential expired")
            return Result.failure()
        }
        val permissionReport = permissionReport()

        return try {
            dao.recoverInterruptedBatches()
            val preflightCounts = container.queue.counts()
            val preflight = container.api.heartbeat(
                credentials,
                Heartbeat(
                    organizationId = credentials.organizationId,
                    employeeId = credentials.employeeId,
                    deviceId = credentials.deviceId,
                    observedAt = Instant.now().toString(),
                    appVersion = BuildConfig.VERSION_NAME,
                    osVersion = Build.VERSION.RELEASE.orEmpty().take(50),
                    pendingCallCount = preflightCounts.pending + preflightCounts.retrying,
                    syncState = if (preflightCounts.retrying > 0) "degraded" else "idle",
                    permissions = permissionReport,
                ),
            )
            if (preflight.directives.any { it is MobileDirective.DeviceRevoked }) {
                revokeLocally()
                return Result.success()
            }
            preflight.directives.filterIsInstance<MobileDirective.ConsentRequired>().firstOrNull()?.let {
                requireFreshConsent(credentials, it.policyId, it.contentHash)
                return Result.success()
            }
            if (!collectionGateOpen()) return Result.success()
            if (VariantCapabilities.requiresCallLogPermission && permissionReport.callLog != PermissionState.GRANTED) {
                return Result.success()
            }
            val observed = container.source.read(preferences.lastScanEpochMillis, MAX_SOURCE_READ)
            if (!collectionGateOpen()) return Result.success()
            if (observed.isNotEmpty()) {
                // Encryption + one Room transaction must complete before the durable checkpoint moves.
                container.queue.enqueue(observed)
                preferences.lastScanEpochMillis = maxOf(
                    preferences.lastScanEpochMillis,
                    observed.maxOf { it.startedAtEpochMillis },
                )
            }

            val candidates = dao.due(System.currentTimeMillis(), MAX_BATCH_ITEMS)
            val batch = container.batchBuilder.build(
                candidates = candidates,
                credentials = credentials,
                previousCursor = preferences.syncCursor,
            )
            if (batch != null) {
                if (!collectionGateOpen()) return Result.success()
                val ids = batch.items.map { it.localId }
                check(dao.markInFlight(ids) == ids.size) { "Queue batch state changed concurrently" }
                try {
                    val response = container.api.uploadCallBatch(credentials, batch)
                    val accepted = response.items.filter {
                        it.outcome == "created" || it.outcome == "updated" || it.outcome == "duplicate"
                    }.map { it.localId }
                    val retryableRejected = response.items.filter {
                        it.outcome == "rejected" && it.retryable == true
                    }.map { it.localId }
                    val permanentRejected = response.items.filter {
                        it.outcome == "rejected" && it.retryable != true
                    }.map { it.localId }
                    if (accepted.isNotEmpty()) dao.markSynced(accepted)
                    if (permanentRejected.isNotEmpty()) dao.markRejected(permanentRejected)
                    if (retryableRejected.isNotEmpty()) {
                        val delay = RetryPolicy.forAttempt(runAttemptCount).delayMillis
                        dao.scheduleRetry(retryableRejected, System.currentTimeMillis() + delay)
                    }
                    preferences.syncCursor = response.nextCursor
                    preferences.lastSuccessfulSyncAt = response.serverTime
                } catch (error: Throwable) {
                    val decision = RetryPolicy.forAttempt(runAttemptCount)
                    val apiError = error as? MobileApiException
                    if (apiError?.statusCode == 401) {
                        throw error
                    }
                    val retryable = apiError?.retryable ?: (error is java.io.IOException)
                    if (retryable && decision.retry) {
                        val serverDelay = apiError?.retryAfterSeconds
                            ?.coerceIn(0, MAX_SERVER_RETRY_SECONDS)
                            ?.times(1_000)
                            ?: 0
                        dao.scheduleRetry(
                            ids,
                            System.currentTimeMillis() + maxOf(decision.delayMillis, serverDelay),
                        )
                    } else if (!retryable) {
                        dao.markRejected(ids)
                    }
                    throw error
                }
            }

            val counts = container.queue.counts()
            val heartbeat = container.api.heartbeat(
                credentials,
                Heartbeat(
                    organizationId = credentials.organizationId,
                    employeeId = credentials.employeeId,
                    deviceId = credentials.deviceId,
                    observedAt = Instant.now().toString(),
                    appVersion = BuildConfig.VERSION_NAME,
                    osVersion = Build.VERSION.RELEASE.orEmpty().take(50),
                    pendingCallCount = counts.pending + counts.retrying,
                    syncState = if (counts.retrying > 0) "degraded" else "idle",
                    permissions = permissionReport,
                ),
            )
            if (heartbeat.directives.any { it is MobileDirective.DeviceRevoked }) {
                revokeLocally()
                return Result.success()
            }
            heartbeat.directives.filterIsInstance<MobileDirective.ConsentRequired>().firstOrNull()?.let {
                requireFreshConsent(credentials, it.policyId, it.contentHash)
                return Result.success()
            }
            dao.pruneSynced(System.currentTimeMillis() - SYNCED_RETENTION_MILLIS)
            Result.success()
        } catch (error: Throwable) {
            val apiError = error as? MobileApiException
            when (SyncFailurePlanner.forApi(apiError)) {
                SyncFailureAction.REQUIRE_CONSENT -> {
                    requireFreshConsent(credentials, null, null)
                    return Result.success()
                }
                SyncFailureAction.REVOKE_SESSION -> revokeLocally()
                SyncFailureAction.NONE -> Unit
            }
            val retryable = apiError?.retryable ?: (error is java.io.IOException)
            preferences.recordError("call_sync", apiError?.code ?: error::class.java.simpleName)
            SafeLog.warn(TAG, "Call sync failed: ${apiError?.code ?: error::class.java.simpleName}")
            if (retryable && RetryPolicy.forAttempt(runAttemptCount).retry) Result.retry() else Result.failure()
        }
    }

    private fun collectionGateOpen(): Boolean {
        val preferences = container.preferences
        val protocolReady = runCatching {
            container.protocolVault.read().let {
                it.phase == ProtocolPhase.IDLE && it.policy != null && it.consent != null
            }
        }.getOrDefault(false)
        return protocolReady && preferences.disclosureAccepted && !preferences.consentStale &&
            !preferences.revoked
    }

    private suspend fun requireFreshConsent(
        credentials: co.callora.mobile.core.model.DeviceCredentials,
        expectedPolicyId: String?,
        expectedPolicyHash: String?,
    ) {
        // Commit the retry identity before closing the local gate. A crash at any later
        // point returns to this exact server policy fetch without exposing the old queue.
        val pending = MobileProtocolState(
            phase = ProtocolPhase.RECONSENT_POLICY_PENDING,
            expectedPolicyId = expectedPolicyId,
            expectedPolicyHash = expectedPolicyHash,
            operationCredentials = credentials,
        )
        container.protocolVault.write(pending)
        closeLocalGateForConsent()
        runCatching {
            val policy = container.api.fetchCollectionPolicy(credentials.sessionToken)
            AuthoritativePolicyValidator.requireCompatible(
                policy = policy,
                collectionMode = BuildConfig.COLLECTION_MODE,
                expectedId = expectedPolicyId,
                expectedHash = expectedPolicyHash,
            )
            container.protocolVault.write(pending.copy(phase = ProtocolPhase.RECONSENT_READY, policy = policy))
        }.onFailure {
            container.preferences.recordError("policy_refresh", it::class.java.simpleName)
        }
    }

    private fun closeLocalGateForConsent() {
        container.preferences.consentStale = true
        container.preferences.disclosureAccepted = false
        container.preferences.disclosureAcceptedAt = null
        container.preferences.permissionPromptedPolicyHash = null
        SyncScheduler.cancel(applicationContext)
        container.purgeLocalCallData()
        container.preferences.clearOperationalState()
    }

    private fun closeLocalGateForRevocation() {
        container.preferences.revoked = true
        container.preferences.revocationPending = true
        closeLocalGateForConsent()
    }

    private fun permissionReport(): DevicePermissionReport {
        val callLog = if (!VariantCapabilities.requiresCallLogPermission) {
            PermissionState.UNKNOWN
        } else if (ContextCompat.checkSelfPermission(
                applicationContext,
                VariantCapabilities.runtimePermission,
            ) == PackageManager.PERMISSION_GRANTED
        ) {
            PermissionState.GRANTED
        } else {
            PermissionState.DENIED
        }
        return DevicePermissionReport(callLog = callLog)
    }

    private suspend fun revokeLocally() {
        // Synchronous durable repair marker comes first. A process death after any
        // following crypto-erasure step must force startup through the queue purge.
        container.preferences.revocationPending = true
        container.preferences.revoked = true
        container.preferences.disclosureAccepted = false
        container.preferences.disclosureAcceptedAt = null
        container.preferences.consentStale = false
        container.preferences.permissionPromptedPolicyHash = null
        SyncScheduler.cancel(applicationContext)
        container.credentialVault.clear(destroyKey = true)
        container.protocolVault.clear(destroyKey = true)
        container.purgeLocalCallData()
        container.preferences.clearOperationalState()
        container.preferences.revocationPending = false
    }

    private suspend fun invalidateSessionForRepair() {
        // This repair performs the same destructive identity transition as local
        // revocation, so it uses the same crash-recovery marker and final commit.
        container.preferences.revocationPending = true
        container.preferences.disclosureAccepted = false
        container.preferences.disclosureAcceptedAt = null
        container.preferences.consentStale = false
        container.preferences.permissionPromptedPolicyHash = null
        container.preferences.revoked = true
        SyncScheduler.cancel(applicationContext)
        container.credentialVault.clear(destroyKey = true)
        container.protocolVault.clear(destroyKey = true)
        container.purgeLocalCallData()
        container.preferences.clearOperationalState()
        container.preferences.regenerateInstallationId()
        container.preferences.revocationPending = false
    }

    private companion object {
        const val TAG = "CalloraSync"
        const val MAX_BATCH_ITEMS = 100
        const val MAX_SERVER_RETRY_SECONDS = 6 * 60 * 60L
        const val SYNCED_RETENTION_MILLIS = 24 * 60 * 60 * 1_000L
        val CONSENT_PHASES = setOf(
            ProtocolPhase.RECONSENT_POLICY_PENDING,
            ProtocolPhase.RECONSENT_READY,
            ProtocolPhase.RECONSENT_PENDING,
        )
    }
}

internal enum class SyncFailureAction {
    NONE,
    REQUIRE_CONSENT,
    REVOKE_SESSION,
}

internal object SyncFailurePlanner {
    /** Consent rollover retains valid session credentials; only true auth failure revokes. */
    fun forApi(error: MobileApiException?): SyncFailureAction = when {
        error?.code == "CONSENT_REQUIRED" -> SyncFailureAction.REQUIRE_CONSENT
        error?.statusCode == 401 -> SyncFailureAction.REVOKE_SESSION
        else -> SyncFailureAction.NONE
    }
}
