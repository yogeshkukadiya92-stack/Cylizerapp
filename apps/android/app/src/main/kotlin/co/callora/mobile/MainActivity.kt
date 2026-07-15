package co.callora.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import co.callora.mobile.ui.CalloraApp
import co.callora.mobile.ui.CalloraTheme
import co.callora.mobile.ui.CalloraViewModel

class MainActivity : ComponentActivity() {
    private val viewModel: CalloraViewModel by viewModels {
        CalloraViewModel.Factory(application, (application as CalloraApplication).container)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            CalloraTheme {
                CalloraApp(viewModel)
            }
        }
    }
}

