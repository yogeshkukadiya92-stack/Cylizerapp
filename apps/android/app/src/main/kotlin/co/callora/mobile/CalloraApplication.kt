package co.callora.mobile

import android.app.Application
import co.callora.mobile.sync.SyncScheduler

class CalloraApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        SyncScheduler.ensurePeriodic(this)
    }
}

