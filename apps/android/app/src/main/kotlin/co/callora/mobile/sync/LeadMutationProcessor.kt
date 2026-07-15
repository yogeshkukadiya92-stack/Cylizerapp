package co.callora.mobile.sync

import co.callora.mobile.core.model.DeviceCredentials
import co.callora.mobile.data.api.LeadUpdateCommand
import co.callora.mobile.data.api.LeadUpdateReceipt
import co.callora.mobile.data.api.MobileApiException
import co.callora.mobile.data.local.LeadMutationEntity
import co.callora.mobile.data.local.LeadMutationStore
import java.io.IOException
import kotlinx.coroutines.CancellationException

fun interface LeadMutationSender {
    suspend fun send(credentials: DeviceCredentials, command: LeadUpdateCommand): LeadUpdateReceipt
}

enum class LeadMutationSecurityAction {
    NONE,
    REQUIRE_CONSENT,
    REVOKE_SESSION,
}

data class LeadMutationRunResult(
    val synced: Int = 0,
    val retrying: Int = 0,
    val conflicts: Int = 0,
    val rejected: Int = 0,
    val securityAction: LeadMutationSecurityAction = LeadMutationSecurityAction.NONE,
)

class LeadMutationProcessor(
    private val store: LeadMutationStore,
    private val sender: LeadMutationSender,
    private val now: () -> Long = System::currentTimeMillis,
) {
    suspend fun run(credentials: DeviceCredentials, limit: Int = 25): LeadMutationRunResult {
        val startedAt = now()
        store.recoverInterrupted(startedAt)
        var result = LeadMutationRunResult()
        for (entity in store.due(startedAt, limit.coerceIn(1, 25))) {
            if (!entity.belongsTo(credentials)) {
                store.markRejected(entity.requestId, now(), "IDENTITY_MISMATCH")
                result = result.copy(rejected = result.rejected + 1)
                continue
            }
            if (store.markInFlight(entity.requestId, now()) != 1) continue
            try {
                val command = store.decode(entity)
                val receipt = sender.send(credentials, command)
                require(receipt.requestId == entity.requestId) { "Lead mutation receipt mismatch" }
                check(store.markSynced(entity.requestId, now()) == 1) { "Lead mutation state changed concurrently" }
                result = result.copy(synced = result.synced + 1)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                val apiError = error as? MobileApiException
                val code = apiError?.code ?: error::class.java.simpleName.take(100)
                when {
                    apiError?.code == "CONSENT_REQUIRED" -> {
                        store.scheduleRetry(entity.requestId, now() + SECURITY_RETRY_MILLIS, now(), code)
                        return result.copy(
                            retrying = result.retrying + 1,
                            securityAction = LeadMutationSecurityAction.REQUIRE_CONSENT,
                        )
                    }
                    apiError?.statusCode == 401 -> {
                        store.scheduleRetry(entity.requestId, now() + SECURITY_RETRY_MILLIS, now(), code)
                        return result.copy(
                            retrying = result.retrying + 1,
                            securityAction = LeadMutationSecurityAction.REVOKE_SESSION,
                        )
                    }
                    apiError?.statusCode == 409 -> {
                        store.markConflict(entity.requestId, now(), code)
                        result = result.copy(conflicts = result.conflicts + 1)
                    }
                    shouldRetry(error, apiError, entity) -> {
                        val decision = RetryPolicy.forAttempt(entity.attemptCount)
                        val serverDelay = apiError?.retryAfterSeconds
                            ?.coerceIn(0, MAX_SERVER_RETRY_SECONDS)
                            ?.times(1_000)
                            ?: 0
                        store.scheduleRetry(
                            entity.requestId,
                            now() + maxOf(decision.delayMillis, serverDelay),
                            now(),
                            code,
                        )
                        result = result.copy(retrying = result.retrying + 1)
                    }
                    else -> {
                        store.markRejected(entity.requestId, now(), code)
                        result = result.copy(rejected = result.rejected + 1)
                    }
                }
            }
        }
        store.pruneSynced(now() - SYNCED_RETENTION_MILLIS)
        return result
    }

    private fun shouldRetry(
        error: Throwable,
        apiError: MobileApiException?,
        entity: LeadMutationEntity,
    ): Boolean {
        val retryable = apiError?.retryable ?: (error is IOException)
        return retryable && RetryPolicy.forAttempt(entity.attemptCount).retry
    }

    private fun LeadMutationEntity.belongsTo(credentials: DeviceCredentials): Boolean =
        organizationId == credentials.organizationId && employeeId == credentials.employeeId &&
            deviceId == credentials.deviceId

    private companion object {
        const val SECURITY_RETRY_MILLIS = 30_000L
        const val MAX_SERVER_RETRY_SECONDS = 6 * 60 * 60L
        const val SYNCED_RETENTION_MILLIS = 24 * 60 * 60 * 1_000L
    }
}
