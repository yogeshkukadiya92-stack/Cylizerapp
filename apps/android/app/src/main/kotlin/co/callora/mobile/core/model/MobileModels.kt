package co.callora.mobile.core.model

data class DeviceCredentials(
    val organizationId: String,
    val employeeId: String,
    val deviceId: String,
    /** One opaque, client-generated device session credential. */
    val sessionToken: String,
    val expiresAt: String,
)

enum class PermissionState(val wireName: String) {
    UNKNOWN("unknown"),
    GRANTED("granted"),
    DENIED("denied"),
    RESTRICTED("restricted"),
}

/** Exact six-field permissions shape shared with the API contract. */
data class DevicePermissionReport(
    val callLog: PermissionState,
    val phoneState: PermissionState = PermissionState.UNKNOWN,
    val contacts: PermissionState = PermissionState.DENIED,
    val notifications: PermissionState = PermissionState.UNKNOWN,
    val recordingFiles: PermissionState = PermissionState.DENIED,
    val backgroundExecution: PermissionState = PermissionState.UNKNOWN,
)

enum class CallDirection(val wireName: String) {
    INCOMING("incoming"),
    OUTGOING("outgoing"),
}

enum class CallDisposition(val wireName: String) {
    ANSWERED("answered"),
    MISSED("missed"),
    REJECTED("rejected"),
    BUSY("busy"),
    BLOCKED("blocked"),
    VOICEMAIL("voicemail"),
    UNKNOWN("unknown"),
}

data class ObservedCall(
    val nativeCallId: String?,
    val simCardId: String?,
    val phoneNumber: String,
    val contactName: String?,
    val direction: CallDirection,
    val disposition: CallDisposition,
    val startedAtEpochMillis: Long,
    val answeredAtEpochMillis: Long?,
    val endedAtEpochMillis: Long?,
    val durationSeconds: Long,
    val ringDurationSeconds: Long?,
    val isInternal: Boolean = false,
    val nativeLastModifiedAtEpochMillis: Long? = null,
)

data class CallSyncItem(
    val localId: String,
    val nativeCallId: String?,
    val simCardId: String?,
    val phoneNumber: String,
    val contactName: String?,
    val direction: CallDirection,
    val disposition: CallDisposition,
    val startedAt: String,
    val answeredAt: String?,
    val endedAt: String?,
    val durationSeconds: Long,
    val ringDurationSeconds: Long?,
    val isInternal: Boolean,
    val nativeLastModifiedAt: String?,
)

data class CallSyncBatch(
    val schemaVersion: Int = 1,
    val batchId: String,
    val collectionMode: String,
    val organizationId: String,
    val employeeId: String,
    val deviceId: String,
    val sentAt: String,
    val previousCursor: String?,
    val items: List<CallSyncItem>,
)

data class CallSyncItemResult(
    val localId: String,
    val outcome: String,
    val callLogId: String? = null,
    val code: String? = null,
    val retryable: Boolean? = null,
)

data class CallSyncResult(
    val batchId: String,
    val acceptedAt: String,
    val nextCursor: String,
    val items: List<CallSyncItemResult>,
    val serverTime: String,
)

data class Heartbeat(
    val organizationId: String,
    val employeeId: String,
    val deviceId: String,
    val observedAt: String,
    val appVersion: String,
    val osVersion: String,
    val pendingCallCount: Int,
    val syncState: String,
    val permissions: DevicePermissionReport,
)

sealed interface MobileDirective {
    data class SyncNow(val reason: String?) : MobileDirective
    data object RefreshConfiguration : MobileDirective
    data class ConsentRequired(
        val policyId: String,
        val contentHash: String,
        val reason: String,
    ) : MobileDirective
    data class UpdateRequired(val minimumVersion: String, val storeUrl: String) : MobileDirective
    data class PauseRecordingUploads(val until: String?, val reason: String) : MobileDirective
    data class DeviceRevoked(val reason: String) : MobileDirective
}

data class HeartbeatAcknowledgement(
    val serverTime: String,
    val nextHeartbeatAfterSeconds: Long,
    val directives: List<MobileDirective>,
)
