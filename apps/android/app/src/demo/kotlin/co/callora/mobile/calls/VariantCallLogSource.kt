package co.callora.mobile.calls

import android.content.Context
import co.callora.mobile.core.model.CallDirection
import co.callora.mobile.core.model.CallDisposition
import co.callora.mobile.core.model.ObservedCall
import java.time.Instant
import java.time.ZoneOffset

object VariantCapabilities {
    const val displaysSyntheticData = true
    const val requiresCallLogPermission = false
    const val runtimePermission: String = ""
}

object VariantCallLogSourceFactory {
    fun create(context: Context, disclosureAccepted: () -> Boolean): CallLogSource =
        SyntheticCallLogSource(disclosureAccepted)
}

private class SyntheticCallLogSource(
    private val disclosureAccepted: () -> Boolean,
    private val now: () -> Long = System::currentTimeMillis,
) : CallLogSource {
    override suspend fun read(sinceEpochMillisExclusive: Long, limit: Int): List<ObservedCall> {
        if (!disclosureAccepted()) return emptyList()
        val boundedLimit = limit.coerceIn(1, MAX_SOURCE_READ)
        val current = now()
        val day = Instant.ofEpochMilli(current).atZone(ZoneOffset.UTC).toLocalDate().toEpochDay()
        val base = current - 90 * 60 * 1_000L
        return listOf(
            ObservedCall(
                nativeCallId = "demo-$day-1",
                simCardId = null,
                phoneNumber = "+919876543210",
                contactName = "Demo lead",
                direction = CallDirection.OUTGOING,
                disposition = CallDisposition.ANSWERED,
                startedAtEpochMillis = base,
                answeredAtEpochMillis = base + 8_000,
                endedAtEpochMillis = base + 128_000,
                durationSeconds = 120,
                ringDurationSeconds = 8,
            ),
            ObservedCall(
                nativeCallId = "demo-$day-2",
                simCardId = null,
                phoneNumber = "+919812345678",
                contactName = null,
                direction = CallDirection.INCOMING,
                disposition = CallDisposition.MISSED,
                startedAtEpochMillis = base + 900_000,
                answeredAtEpochMillis = null,
                endedAtEpochMillis = base + 925_000,
                durationSeconds = 0,
                ringDurationSeconds = 25,
            ),
            ObservedCall(
                nativeCallId = "demo-$day-3",
                simCardId = null,
                phoneNumber = "+919900112233",
                contactName = "Demo customer",
                direction = CallDirection.INCOMING,
                disposition = CallDisposition.ANSWERED,
                startedAtEpochMillis = base + 1_800_000,
                answeredAtEpochMillis = base + 1_812_000,
                endedAtEpochMillis = base + 1_872_000,
                durationSeconds = 60,
                ringDurationSeconds = 12,
            ),
        ).filter { it.startedAtEpochMillis > sinceEpochMillisExclusive }.take(boundedLimit)
    }
}
