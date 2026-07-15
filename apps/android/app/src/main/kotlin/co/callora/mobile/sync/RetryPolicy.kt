package co.callora.mobile.sync

import kotlin.math.pow

data class RetryDecision(
    val retry: Boolean,
    val delayMillis: Long,
)

object RetryPolicy {
    const val maxAttempts = 8
    private const val BASE_DELAY_MILLIS = 30_000L
    private const val MAX_DELAY_MILLIS = 6 * 60 * 60 * 1_000L

    fun forAttempt(attempt: Int): RetryDecision {
        if (attempt >= maxAttempts) return RetryDecision(retry = false, delayMillis = 0)
        val exponent = attempt.coerceAtLeast(0).coerceAtMost(20)
        val delay = (BASE_DELAY_MILLIS * 2.0.pow(exponent.toDouble())).toLong()
            .coerceAtMost(MAX_DELAY_MILLIS)
        return RetryDecision(retry = true, delayMillis = delay)
    }
}
