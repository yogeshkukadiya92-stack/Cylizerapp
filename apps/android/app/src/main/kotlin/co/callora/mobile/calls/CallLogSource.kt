package co.callora.mobile.calls

import co.callora.mobile.core.model.ObservedCall

interface CallLogSource {
    /** Implementations must not return more than [limit] rows. */
    suspend fun read(sinceEpochMillisExclusive: Long, limit: Int): List<ObservedCall>
}

const val MAX_SOURCE_READ = 500

