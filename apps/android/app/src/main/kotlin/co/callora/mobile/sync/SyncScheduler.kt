package co.callora.mobile.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.time.Duration
import java.util.concurrent.TimeUnit

object SyncScheduler {
    private const val UNIQUE_NOW = "callora-call-sync-now"
    private const val UNIQUE_PERIODIC = "callora-call-sync-periodic"

    private val constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    fun runNow(context: Context) {
        val request = OneTimeWorkRequestBuilder<CallSyncWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            UNIQUE_NOW,
            ExistingWorkPolicy.KEEP,
            request,
        )
    }

    fun ensurePeriodic(context: Context) {
        // The tick never syncs directly. Manual and periodic triggers both funnel into
        // UNIQUE_NOW, so only one CallSyncWorker can own IN_FLIGHT rows at a time.
        val request = PeriodicWorkRequestBuilder<SyncTickWorker>(Duration.ofMinutes(15))
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            UNIQUE_PERIODIC,
            ExistingPeriodicWorkPolicy.UPDATE,
            request,
        )
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_NOW)
        WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_PERIODIC)
    }
}
