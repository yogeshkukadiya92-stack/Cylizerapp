package co.callora.mobile.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import co.callora.mobile.CalloraApplication
import co.callora.mobile.core.logging.SafeLog
import co.callora.mobile.core.protocol.ProtocolPhase
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.withLock

class LeadMutationWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    private val container = (appContext.applicationContext as CalloraApplication).container
    private val security = MobileSecurityTransitions(applicationContext, container)

    override suspend fun doWork(): Result = container.collectionMutex.withLock {
        val protocol = runCatching { container.protocolVault.read() }.getOrElse {
            security.invalidateSessionForRepair()
            container.preferences.recordError("lead_mutation_protocol", "Encrypted protocol journal unreadable")
            return@withLock Result.failure()
        }
        val credentials = container.credentialVault.read()
        if (credentials == null) {
            if (container.preferences.disclosureAccepted) security.invalidateSessionForRepair()
            return@withLock Result.success()
        }
        if (protocol.phase != ProtocolPhase.IDLE || protocol.policy == null || protocol.consent == null ||
            !security.collectionGateOpen()
        ) return@withLock Result.success()
        val expiry = runCatching { Instant.parse(credentials.expiresAt) }.getOrNull()
        if (expiry?.isAfter(Instant.now()) != true) {
            security.invalidateSessionForRepair()
            container.preferences.recordError("lead_mutation_session", "Session credential expired")
            return@withLock Result.failure()
        }
        try {
            val result = container.leadMutationProcessor.run(credentials)
            when (result.securityAction) {
                LeadMutationSecurityAction.REQUIRE_CONSENT -> {
                    security.requireFreshConsent(credentials)
                    Result.success()
                }
                LeadMutationSecurityAction.REVOKE_SESSION -> {
                    security.revokeLocally()
                    Result.success()
                }
                LeadMutationSecurityAction.NONE -> if (result.retrying > 0) Result.retry() else Result.success()
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            container.preferences.recordError("lead_mutation_sync", error::class.java.simpleName)
            SafeLog.warn(TAG, "Lead mutation sync failed: ${error::class.java.simpleName}", error)
            if (RetryPolicy.forAttempt(runAttemptCount).retry) Result.retry() else Result.failure()
        }
    }

    private companion object {
        const val TAG = "CalloraLeadSync"
    }
}
