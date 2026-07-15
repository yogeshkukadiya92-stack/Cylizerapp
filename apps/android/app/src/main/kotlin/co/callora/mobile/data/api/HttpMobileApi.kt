package co.callora.mobile.data.api

import co.callora.mobile.core.model.CallSyncBatch
import co.callora.mobile.core.model.CallSyncItem
import co.callora.mobile.core.model.CallSyncItemResult
import co.callora.mobile.core.model.CallSyncResult
import co.callora.mobile.core.model.DeviceCredentials
import co.callora.mobile.core.model.DevicePermissionReport
import co.callora.mobile.core.model.Heartbeat
import co.callora.mobile.core.model.HeartbeatAcknowledgement
import co.callora.mobile.core.model.MobileDirective
import co.callora.mobile.core.protocol.AuthoritativePolicyDocument
import co.callora.mobile.core.protocol.ConsentReceipt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class HttpMobileApi(
    private val baseUrl: () -> String,
) : MobileApi {
    override suspend fun redeemBootstrap(
        registration: DeviceRegistration,
        requestId: String,
        proposedBootstrapToken: String,
    ): BootstrapCredential {
        val body = JSONObject()
            .put("code", registration.pairingCode.trim().uppercase())
            .put("requestId", requestId)
            .put("proposedBootstrapCredential", proposedBootstrapToken)
            .put("installationId", registration.installationId)
            .put("platform", "android")
            .put("manufacturer", registration.manufacturer.take(100))
            .put("model", registration.model.take(100))
            .put("osVersion", registration.osVersion.take(50))
            .put("appVersion", registration.appVersion.take(50))
            .put("collectionMode", registration.collectionMode)
            .put("permissions", registration.permissions.toJson())
        val data = request("POST", MobileRoutes.REDEEM_BOOTSTRAP, body, null, requestId)
        val device = data.requireObject("device")
        val credential = data.requireObject("bootstrapCredential")
        requireBearer(credential)
        return BootstrapCredential(
            organizationId = device.requireString("organizationId"),
            employeeId = device.requireString("employeeId"),
            deviceId = device.requireString("id"),
            token = proposedBootstrapToken,
            expiresAt = credential.requireString("expiresAt"),
        )
    }

    override suspend fun fetchCollectionPolicy(bearerToken: String): AuthoritativePolicyDocument {
        val data = request("GET", MobileRoutes.COLLECTION_POLICY, null, bearerToken, null)
        return parsePolicy(data.requireObject("policy"))
    }

    override suspend fun activateBootstrap(
        bootstrap: BootstrapCredential,
        requestId: String,
        proposedSessionToken: String,
        consent: ConsentReceipt,
        permissions: DevicePermissionReport,
    ): DeviceCredentials {
        val consentJson = JSONObject()
            .put("acceptedAt", consent.acceptedAt)
            .put("purpose", "call_metadata")
        consent.locale?.let { consentJson.put("locale", it.take(35)) }
        val body = JSONObject()
            .put("requestId", requestId)
            .put("proposedSessionCredential", proposedSessionToken)
            .put(
                "policy",
                JSONObject().put("id", consent.policyId).put("contentHash", consent.contentHash),
            )
            .put("consent", consentJson)
            .put("permissions", permissions.toJson())
        val data = request("POST", MobileRoutes.ACTIVATE, body, bootstrap.token, requestId)
        val device = data.requireObject("device")
        val credential = data.requireObject("sessionCredential")
        val policy = data.requireObject("policy")
        requireBearer(credential)
        requireDeviceIdentity(device, bootstrap.organizationId, bootstrap.employeeId, bootstrap.deviceId)
        requirePolicyEcho(policy, consent)
        return DeviceCredentials(
            organizationId = device.requireString("organizationId"),
            employeeId = device.requireString("employeeId"),
            deviceId = device.requireString("id"),
            sessionToken = proposedSessionToken,
            expiresAt = credential.requireString("expiresAt"),
        )
    }

    override suspend fun reconsent(
        credentials: DeviceCredentials,
        requestId: String,
        consent: ConsentReceipt,
        permissions: DevicePermissionReport,
    ): String {
        val consentJson = JSONObject()
            .put("acceptedAt", consent.acceptedAt)
            .put("purpose", "call_metadata")
        consent.locale?.let { consentJson.put("locale", it.take(35)) }
        val body = JSONObject()
            .put("requestId", requestId)
            .put(
                "policy",
                JSONObject().put("id", consent.policyId).put("contentHash", consent.contentHash),
            )
            .put("consent", consentJson)
            .put("permissions", permissions.toJson())
        val data = request("POST", MobileRoutes.RECONSENT, body, credentials.sessionToken, requestId)
        requireDeviceIdentity(
            data.requireObject("device"),
            credentials.organizationId,
            credentials.employeeId,
            credentials.deviceId,
        )
        requirePolicyEcho(data.requireObject("policy"), consent)
        return data.requireString("consentedAt")
    }

    override suspend fun heartbeat(
        credentials: DeviceCredentials,
        heartbeat: Heartbeat,
    ): HeartbeatAcknowledgement {
        val body = JSONObject()
            .put("schemaVersion", 1)
            .put("organizationId", heartbeat.organizationId)
            .put("employeeId", heartbeat.employeeId)
            .put("deviceId", heartbeat.deviceId)
            .put("observedAt", heartbeat.observedAt)
            .put("appVersion", heartbeat.appVersion)
            .put("osVersion", heartbeat.osVersion)
            .put("pendingCallCount", heartbeat.pendingCallCount)
            .put("pendingRecordingCount", 0)
            .put("syncState", heartbeat.syncState)
            .put("permissions", heartbeat.permissions.toJson())
        val data = request("POST", MobileRoutes.HEARTBEAT, body, credentials.sessionToken, null)
        val directives = data.optJSONArray("directives") ?: JSONArray()
        return HeartbeatAcknowledgement(
            serverTime = data.requireString("serverTime"),
            nextHeartbeatAfterSeconds = data.requireLong("nextHeartbeatAfterSeconds"),
            directives = List(directives.length()) { index -> parseDirective(directives.getJSONObject(index)) },
        )
    }

    override suspend fun uploadCallBatch(
        credentials: DeviceCredentials,
        batch: CallSyncBatch,
    ): CallSyncResult {
        val body = batch.toJson()
        val data = request(
            method = "POST",
            path = MobileRoutes.CALL_BATCHES,
            body = body,
            bearerToken = credentials.sessionToken,
            idempotencyKey = batch.batchId,
        )
        val itemArray = data.getJSONArray("items")
        return CallSyncResult(
            batchId = data.requireString("batchId"),
            acceptedAt = data.requireString("acceptedAt"),
            nextCursor = data.requireString("nextCursor"),
            items = List(itemArray.length()) { index ->
                val item = itemArray.getJSONObject(index)
                CallSyncItemResult(
                    localId = item.requireString("localId"),
                    outcome = item.requireString("outcome"),
                    callLogId = item.optStringOrNull("callLogId"),
                    code = item.optStringOrNull("code"),
                    retryable = item.optBoolean("retryable").takeIf { item.has("retryable") },
                )
            },
            serverTime = data.requireString("serverTime"),
        )
    }

    override suspend fun listAssignedLeads(
        credentials: DeviceCredentials,
        queue: String,
        search: String?,
    ): AssignedLeadPage {
        require(queue in setOf("all", "not_contacted", "overdue", "unreturned_calls")) {
            "Unsupported lead queue"
        }
        val query = buildList {
            add("limit=100")
            add("queue=${URLEncoder.encode(queue, StandardCharsets.UTF_8.name())}")
            search?.trim()?.takeIf(String::isNotBlank)?.let {
                add("search=${URLEncoder.encode(it.take(160), StandardCharsets.UTF_8.name())}")
            }
        }.joinToString("&")
        val data = request("GET", "${MobileRoutes.LEADS}?$query", null, credentials.sessionToken, null)
        val itemsJson = data.getJSONArray("items")
        val items = List(itemsJson.length()) { index ->
            val item = itemsJson.getJSONObject(index)
            val lead = item.requireObject("lead")
            val status = item.requireObject("status")
            val nextFollowUp = item.optJSONObject("nextFollowUp")
            val firstName = lead.requireString("firstName")
            val lastName = lead.optStringOrNull("lastName")
            val companyName = lead.optStringOrNull("companyName")
            AssignedLead(
                id = lead.requireString("id"),
                version = lead.requireLong("version"),
                displayName = companyName ?: listOfNotNull(firstName, lastName).joinToString(" "),
                firstName = firstName,
                lastName = lastName,
                companyName = companyName,
                phoneNumber = lead.requireString("phoneNumber"),
                email = lead.optStringOrNull("email"),
                source = lead.requireString("source"),
                statusId = status.requireString("id"),
                statusName = status.requireString("name"),
                statusColor = status.requireString("color"),
                lastContactedAt = lead.optStringOrNull("lastContactedAt"),
                nextFollowUpAt = nextFollowUp?.optStringOrNull("dueAt")
                    ?: lead.optStringOrNull("nextFollowUpAt"),
                nextFollowUpTitle = nextFollowUp?.optStringOrNull("title"),
                overdueFollowUpCount = item.optInt("overdueFollowUpCount", 0),
                unreturnedMissedCallCount = item.optInt("unreturnedMissedCallCount", 0),
                createdAt = lead.requireString("createdAt"),
                updatedAt = lead.requireString("updatedAt"),
            )
        }
        val summary = data.requireObject("summary")
        val cursor = data.requireObject("cursorInfo")
        return AssignedLeadPage(
            items = items,
            summary = AssignedLeadSummary(
                total = summary.optInt("total", 0),
                notContacted = summary.optInt("notContacted", 0),
                overdue = summary.optInt("overdue", 0),
                unreturnedCalls = summary.optInt("unreturnedCalls", 0),
            ),
            generatedAt = data.requireString("generatedAt"),
            nextCursor = cursor.optStringOrNull("nextCursor"),
        )
    }

    override suspend fun prepareSessionRotation(
        credentials: DeviceCredentials,
        requestId: String,
        proposedSessionToken: String,
    ): RotationPreparation {
        val body = JSONObject()
            .put("requestId", requestId)
            .put("proposedSessionCredential", proposedSessionToken)
        val data = request("POST", MobileRoutes.ROTATION_PREPARE, body, credentials.sessionToken, requestId)
        require(data.requireString("requestId") == requestId) { "Rotation request ID mismatch" }
        val credential = data.requireObject("pendingCredential")
        requireBearer(credential)
        return RotationPreparation(
            requestId = requestId,
            expiresAt = credential.requireString("expiresAt"),
            preparedAt = data.requireString("preparedAt"),
        )
    }

    override suspend fun confirmSessionRotation(
        pendingCredentials: DeviceCredentials,
        requestId: String,
        prepareRequestId: String,
    ): DeviceCredentials {
        val body = JSONObject()
            .put("requestId", requestId)
            .put("prepareRequestId", prepareRequestId)
        val data = request(
            "POST",
            MobileRoutes.ROTATION_CONFIRM,
            body,
            pendingCredentials.sessionToken,
            requestId,
        )
        require(data.requireString("requestId") == requestId) { "Rotation request ID mismatch" }
        val credential = data.requireObject("credential")
        requireBearer(credential)
        return pendingCredentials.copy(expiresAt = credential.requireString("expiresAt"))
    }

    override suspend fun revokeSession(
        credentials: DeviceCredentials,
        requestId: String,
    ): RevocationReceipt {
        val data = request(
            "DELETE",
            MobileRoutes.REVOKE_SESSION,
            JSONObject().put("requestId", requestId),
            credentials.sessionToken,
            requestId,
        )
        val deviceId = data.requireString("deviceId")
        require(deviceId == credentials.deviceId) { "Revocation device mismatch" }
        return RevocationReceipt(
            deviceId = deviceId,
            revokedAt = data.requireString("revokedAt"),
            consentWithdrawnAt = data.requireString("consentWithdrawnAt"),
        )
    }

    private suspend fun request(
        method: String,
        path: String,
        body: JSONObject?,
        bearerToken: String?,
        idempotencyKey: String?,
    ): JSONObject = withContext(Dispatchers.IO) {
        val normalizedBase = ApiUrlPolicy.normalizeAndRequireAllowed(baseUrl())
        val connection = (URL(normalizedBase + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = CONNECT_TIMEOUT_MILLIS
            readTimeout = READ_TIMEOUT_MILLIS
            instanceFollowRedirects = false
            useCaches = false
            setRequestProperty("Accept", "application/json")
            bearerToken?.let { setRequestProperty("Authorization", "Bearer $it") }
            idempotencyKey?.let { setRequestProperty("Idempotency-Key", it) }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
        }
        try {
            body?.let {
                connection.outputStream.use { stream ->
                    stream.write(it.toString().toByteArray(StandardCharsets.UTF_8))
                }
            }
            val status = connection.responseCode
            val responseText = readBounded(
                if (status in 200..299) connection.inputStream else connection.errorStream,
            )
            val envelope = runCatching { JSONObject(responseText) }.getOrElse {
                throw MobileApiException(status, "INVALID_RESPONSE", retryable = status >= 500)
            }
            if (status !in 200..299 || !envelope.optBoolean("ok", false)) {
                val error = envelope.optJSONObject("error")
                val code = error?.optString("code")?.takeIf(String::isNotBlank) ?: "HTTP_$status"
                val retryAfter = error?.optLong("retryAfterSeconds", -1L)?.takeIf { it >= 0 }
                throw MobileApiException(
                    statusCode = status,
                    code = code,
                    retryable = status == 408 || status == 429 || status >= 500,
                    retryAfterSeconds = retryAfter,
                )
            }
            envelope.requireObject("data")
        } finally {
            connection.disconnect()
        }
    }

    private fun DevicePermissionReport.toJson(): JSONObject = JSONObject()
        .put("callLog", callLog.wireName)
        .put("phoneState", phoneState.wireName)
        .put("contacts", contacts.wireName)
        .put("notifications", notifications.wireName)
        .put("recordingFiles", recordingFiles.wireName)
        .put("backgroundExecution", backgroundExecution.wireName)

    private fun parseDirective(value: JSONObject): MobileDirective = when (val type = value.requireString("type")) {
        "sync_now" -> MobileDirective.SyncNow(value.optStringOrNull("reason"))
        "refresh_configuration" -> MobileDirective.RefreshConfiguration
        "consent_required" -> MobileDirective.ConsentRequired(
            policyId = value.requireString("policyId"),
            contentHash = value.requireString("contentHash"),
            reason = value.requireString("reason"),
        )
        "update_required" -> MobileDirective.UpdateRequired(
            minimumVersion = value.requireString("minimumVersion"),
            storeUrl = value.requireString("storeUrl"),
        )
        "pause_recording_uploads" -> MobileDirective.PauseRecordingUploads(
            until = value.optStringOrNull("until"),
            reason = value.requireString("reason"),
        )
        "device_revoked" -> MobileDirective.DeviceRevoked(value.requireString("reason"))
        else -> throw IllegalArgumentException("Unsupported directive type: $type")
    }

    private fun CallSyncBatch.toJson(): JSONObject = JSONObject()
        .put("schemaVersion", schemaVersion)
        .put("batchId", batchId)
        .put("collectionMode", collectionMode)
        .put("organizationId", organizationId)
        .put("employeeId", employeeId)
        .put("deviceId", deviceId)
        .put("sentAt", sentAt)
        .apply { previousCursor?.let { put("previousCursor", it) } }
        .put("items", JSONArray(items.map { it.toJson() }))

    private fun CallSyncItem.toJson(): JSONObject = JSONObject()
        .put("localId", localId)
        .apply {
            nativeCallId?.let { put("nativeCallId", it) }
            simCardId?.let { put("simCardId", it) }
        }
        .put("phoneNumber", phoneNumber)
        .apply { contactName?.let { put("contactName", it) } }
        .put("direction", direction.wireName)
        .put("disposition", disposition.wireName)
        .put("startedAt", startedAt)
        .apply {
            answeredAt?.let { put("answeredAt", it) }
            endedAt?.let { put("endedAt", it) }
        }
        .put("durationSeconds", durationSeconds)
        .apply {
            ringDurationSeconds?.let { put("ringDurationSeconds", it) }
            put("isInternal", isInternal)
            nativeLastModifiedAt?.let { put("nativeLastModifiedAt", it) }
        }

    private fun requireBearer(value: JSONObject) {
        require(value.requireString("tokenType") == "Bearer") { "Unsupported credential type" }
    }

    private fun parsePolicy(value: JSONObject): AuthoritativePolicyDocument {
        val hash = value.requireString("contentHash")
        require(hash.matches(Regex("^[0-9a-f]{64}$"))) { "Invalid policy content hash" }
        val disclosuresJson = value.optJSONArray("disclosures")
            ?: throw IllegalArgumentException("Missing response field: disclosures")
        require(disclosuresJson.length() in 1..64) { "Invalid policy disclosures" }
        val purpose = value.requireString("purpose")
        require(purpose == "call_metadata") { "Unsupported policy purpose" }
        return AuthoritativePolicyDocument(
            id = value.requireString("id"),
            contentHash = hash,
            policyVersion = value.requireString("policyVersion"),
            disclosureVersion = value.requireString("disclosureVersion"),
            collectionMode = value.requireString("collectionMode"),
            purpose = purpose,
            title = value.requireString("title"),
            summary = value.requireString("summary"),
            disclosures = List(disclosuresJson.length()) { index ->
                disclosuresJson.getString(index).takeIf(String::isNotBlank)
                    ?: throw IllegalArgumentException("Blank policy disclosure")
            },
            effectiveAt = value.requireString("effectiveAt"),
        )
    }

    private fun requirePolicyEcho(value: JSONObject, consent: ConsentReceipt) {
        require(value.requireString("id") == consent.policyId) { "Policy ID mismatch" }
        require(value.requireString("contentHash") == consent.contentHash) { "Policy hash mismatch" }
    }

    private fun requireDeviceIdentity(
        value: JSONObject,
        organizationId: String,
        employeeId: String,
        deviceId: String,
    ) {
        require(value.requireString("organizationId") == organizationId) { "Organization mismatch" }
        require(value.requireString("employeeId") == employeeId) { "Employee mismatch" }
        require(value.requireString("id") == deviceId) { "Device mismatch" }
    }

    private fun JSONObject.requireObject(name: String): JSONObject =
        optJSONObject(name) ?: throw IllegalArgumentException("Missing response object: $name")

    private fun JSONObject.requireString(name: String): String =
        optString(name).takeIf(String::isNotBlank)
            ?: throw IllegalArgumentException("Missing response field: $name")

    private fun JSONObject.requireLong(name: String): Long {
        require(has(name)) { "Missing response field: $name" }
        return getLong(name)
    }

    private fun JSONObject.optStringOrNull(name: String): String? =
        optString(name).takeIf(String::isNotBlank)

    private fun readBounded(stream: java.io.InputStream?): String {
        if (stream == null) return "{}"
        return stream.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8_192)
            var total = 0
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                total += read
                if (total > MAX_RESPONSE_BYTES) throw MobileApiException(
                    statusCode = 0,
                    code = "RESPONSE_TOO_LARGE",
                    retryable = false,
                )
                output.write(buffer, 0, read)
            }
            output.toString(StandardCharsets.UTF_8.name())
        }
    }

    private companion object {
        const val CONNECT_TIMEOUT_MILLIS = 15_000
        const val READ_TIMEOUT_MILLIS = 20_000
        const val MAX_RESPONSE_BYTES = 1_048_576
    }
}
