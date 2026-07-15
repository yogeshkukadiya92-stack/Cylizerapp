package co.callora.mobile.data.api

import co.callora.mobile.BuildConfig
import java.net.URI

object ApiUrlPolicy {
    private val debugHosts = setOf("10.0.2.2", "localhost", "127.0.0.1", "::1")

    fun normalizeAndRequireAllowed(value: String): String {
        val normalized = value.trim().trimEnd('/')
        val uri = runCatching { URI(normalized) }.getOrElse { throw IllegalArgumentException("Invalid API URL") }
        require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) {
            "API URL must not contain credentials, query, or fragment"
        }
        require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") {
            "API URL must be an origin without a path"
        }
        val secure = uri.scheme.equals("https", ignoreCase = true)
        val permittedDebugHttp = BuildConfig.DEBUG && uri.scheme.equals("http", ignoreCase = true) &&
            uri.host?.lowercase() in debugHosts
        require(secure || permittedDebugHttp) { "API URL must use HTTPS" }
        require(!uri.host.isNullOrBlank()) { "API URL must include a host" }
        if (!BuildConfig.DEBUG) {
            require(normalized == BuildConfig.DEFAULT_API_BASE_URL.trimEnd('/')) {
                "Release builds are pinned to the configured API origin"
            }
        }
        return normalized
    }
}
