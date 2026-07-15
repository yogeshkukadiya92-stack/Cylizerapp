package co.callora.mobile.data.api

import co.callora.mobile.core.model.CallSyncBatch
import co.callora.mobile.core.model.CallSyncResult
import co.callora.mobile.core.model.DeviceCredentials
import co.callora.mobile.core.model.DevicePermissionReport
import co.callora.mobile.core.model.Heartbeat
import co.callora.mobile.core.model.HeartbeatAcknowledgement
import co.callora.mobile.core.protocol.AuthoritativePolicyDocument
import co.callora.mobile.core.protocol.ConsentReceipt

/** Client-proposed bootstrap token plus the identity descriptor returned by the API. */
data class BootstrapCredential(
    val organizationId: String,
    val employeeId: String,
    val deviceId: String,
    val token: String,
    val expiresAt: String,
)

data class DeviceRegistration(
    val pairingCode: String,
    val installationId: String,
    val manufacturer: String,
    val model: String,
    val osVersion: String,
    val appVersion: String,
    val collectionMode: String,
    val permissions: DevicePermissionReport,
)

data class RotationPreparation(
    val requestId: String,
    val expiresAt: String,
    val preparedAt: String,
)

data class RevocationReceipt(
    val deviceId: String,
    val revokedAt: String,
    val consentWithdrawnAt: String,
)

interface MobileApi {
    suspend fun redeemBootstrap(
        registration: DeviceRegistration,
        requestId: String,
        proposedBootstrapToken: String,
    ): BootstrapCredential

    suspend fun fetchCollectionPolicy(bearerToken: String): AuthoritativePolicyDocument

    suspend fun activateBootstrap(
        bootstrap: BootstrapCredential,
        requestId: String,
        proposedSessionToken: String,
        consent: ConsentReceipt,
        permissions: DevicePermissionReport,
    ): DeviceCredentials

    suspend fun reconsent(
        credentials: DeviceCredentials,
        requestId: String,
        consent: ConsentReceipt,
        permissions: DevicePermissionReport,
    ): String

    suspend fun heartbeat(credentials: DeviceCredentials, heartbeat: Heartbeat): HeartbeatAcknowledgement

    suspend fun uploadCallBatch(credentials: DeviceCredentials, batch: CallSyncBatch): CallSyncResult

    suspend fun listAssignedLeads(
        credentials: DeviceCredentials,
        queue: String = "all",
        search: String? = null,
    ): AssignedLeadPage

    suspend fun prepareSessionRotation(
        credentials: DeviceCredentials,
        requestId: String,
        proposedSessionToken: String,
    ): RotationPreparation

    suspend fun confirmSessionRotation(
        pendingCredentials: DeviceCredentials,
        requestId: String,
        prepareRequestId: String,
    ): DeviceCredentials

    suspend fun revokeSession(credentials: DeviceCredentials, requestId: String): RevocationReceipt
}

object MobileRoutes {
    const val REDEEM_BOOTSTRAP = "/v1/device-pairings/redeem"
    const val COLLECTION_POLICY = "/v1/mobile/collection-policy"
    const val ACTIVATE = "/v1/mobile/activate"
    const val RECONSENT = "/v1/mobile/reconsent"
    const val HEARTBEAT = "/v1/mobile/heartbeat"
    const val CALL_BATCHES = "/v1/mobile/call-batches"
    const val LEADS = "/v1/mobile/leads"
    const val ROTATION_PREPARE = "/v1/mobile/session/rotation/prepare"
    const val ROTATION_CONFIRM = "/v1/mobile/session/rotation/confirm"
    const val REVOKE_SESSION = "/v1/mobile/session"
}

class MobileApiException(
    val statusCode: Int,
    val code: String,
    val retryable: Boolean,
    val retryAfterSeconds: Long? = null,
) : RuntimeException("Mobile API request failed ($code)")
