package co.callora.mobile.calls

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog
import androidx.core.content.ContextCompat
import co.callora.mobile.core.model.CallDirection
import co.callora.mobile.core.model.CallDisposition
import co.callora.mobile.core.model.ObservedCall
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object VariantCapabilities {
    const val displaysSyntheticData = false
    const val requiresCallLogPermission = true
    const val runtimePermission: String = Manifest.permission.READ_CALL_LOG
}

object VariantCallLogSourceFactory {
    fun create(context: Context, disclosureAccepted: () -> Boolean): CallLogSource =
        EnterpriseCallLogSource(context.applicationContext, disclosureAccepted)
}

private class EnterpriseCallLogSource(
    private val context: Context,
    private val disclosureAccepted: () -> Boolean,
) : CallLogSource {
    override suspend fun read(sinceEpochMillisExclusive: Long, limit: Int): List<ObservedCall> =
        withContext(Dispatchers.IO) {
            if (!disclosureAccepted()) return@withContext emptyList()
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALL_LOG) !=
                PackageManager.PERMISSION_GRANTED
            ) return@withContext emptyList()

            val boundedLimit = limit.coerceIn(1, MAX_SOURCE_READ)
            val projection = arrayOf(
                CallLog.Calls._ID,
                CallLog.Calls.NUMBER,
                CallLog.Calls.CACHED_NAME,
                CallLog.Calls.TYPE,
                CallLog.Calls.DATE,
                CallLog.Calls.DURATION,
                CallLog.Calls.LAST_MODIFIED,
            )
            val rows = mutableListOf<ObservedCall>()
            context.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                projection,
                "${CallLog.Calls.DATE} > ?",
                arrayOf(sinceEpochMillisExclusive.toString()),
                // CallLogProvider enables strict SQL grammar on current Android
                // versions and rejects LIMIT inside sortOrder. The activation
                // checkpoint already bounds eligible history; enforce the batch
                // limit while iterating the ordered cursor below.
                "${CallLog.Calls.DATE} ASC",
            )?.use { cursor ->
                val idIndex = cursor.getColumnIndexOrThrow(CallLog.Calls._ID)
                val numberIndex = cursor.getColumnIndexOrThrow(CallLog.Calls.NUMBER)
                val nameIndex = cursor.getColumnIndexOrThrow(CallLog.Calls.CACHED_NAME)
                val typeIndex = cursor.getColumnIndexOrThrow(CallLog.Calls.TYPE)
                val dateIndex = cursor.getColumnIndexOrThrow(CallLog.Calls.DATE)
                val durationIndex = cursor.getColumnIndexOrThrow(CallLog.Calls.DURATION)
                val modifiedIndex = cursor.getColumnIndexOrThrow(CallLog.Calls.LAST_MODIFIED)
                while (cursor.moveToNext() && rows.size < boundedLimit) {
                    val type = cursor.getInt(typeIndex)
                    val direction = direction(type) ?: continue
                    val phone = cursor.getString(numberIndex)?.trim()?.takeIf(String::isNotEmpty) ?: continue
                    val startedAt = cursor.getLong(dateIndex)
                    val duration = cursor.getLong(durationIndex).coerceAtLeast(0)
                    rows += ObservedCall(
                        nativeCallId = cursor.getLong(idIndex).toString(),
                        simCardId = null,
                        phoneNumber = phone,
                        contactName = cursor.getString(nameIndex)?.trim()?.takeIf(String::isNotEmpty),
                        direction = direction,
                        disposition = disposition(type, duration),
                        startedAtEpochMillis = startedAt,
                        answeredAtEpochMillis = null,
                        endedAtEpochMillis = startedAt + duration * 1_000,
                        durationSeconds = duration,
                        ringDurationSeconds = null,
                        nativeLastModifiedAtEpochMillis = cursor.getLong(modifiedIndex).takeIf { it > 0 },
                    )
                }
            }
            rows
        }

    private fun direction(type: Int): CallDirection? = when (type) {
        CallLog.Calls.OUTGOING_TYPE -> CallDirection.OUTGOING
        CallLog.Calls.INCOMING_TYPE,
        CallLog.Calls.MISSED_TYPE,
        CallLog.Calls.REJECTED_TYPE,
        CallLog.Calls.BLOCKED_TYPE,
        CallLog.Calls.VOICEMAIL_TYPE,
        CallLog.Calls.ANSWERED_EXTERNALLY_TYPE,
        -> CallDirection.INCOMING
        else -> null
    }

    private fun disposition(type: Int, duration: Long): CallDisposition = when (type) {
        CallLog.Calls.MISSED_TYPE -> CallDisposition.MISSED
        CallLog.Calls.REJECTED_TYPE -> CallDisposition.REJECTED
        CallLog.Calls.BLOCKED_TYPE -> CallDisposition.BLOCKED
        CallLog.Calls.VOICEMAIL_TYPE -> CallDisposition.VOICEMAIL
        CallLog.Calls.INCOMING_TYPE,
        CallLog.Calls.OUTGOING_TYPE,
        CallLog.Calls.ANSWERED_EXTERNALLY_TYPE,
        -> if (duration > 0) CallDisposition.ANSWERED else CallDisposition.UNKNOWN
        else -> CallDisposition.UNKNOWN
    }
}
