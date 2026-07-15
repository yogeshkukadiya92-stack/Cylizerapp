package co.callora.mobile.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val CalloraLightColors = lightColorScheme(
    primary = Color(0xFF3156D3),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDDE4FF),
    onPrimaryContainer = Color(0xFF0B245F),
    secondary = Color(0xFF316B59),
    surface = Color(0xFFFBFCFF),
    surfaceVariant = Color(0xFFE7E9EF),
    error = Color(0xFFBA1A1A),
)

private val CalloraDarkColors = darkColorScheme(
    primary = Color(0xFFB7C4FF),
    onPrimary = Color(0xFF002A78),
    primaryContainer = Color(0xFF173E9B),
    onPrimaryContainer = Color(0xFFDDE4FF),
    secondary = Color(0xFF9FD5C0),
    surface = Color(0xFF111318),
    surfaceVariant = Color(0xFF44464F),
    error = Color(0xFFFFB4AB),
)

@Composable
fun CalloraTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) CalloraDarkColors else CalloraLightColors,
        content = content,
    )
}
