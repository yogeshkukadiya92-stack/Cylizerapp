package co.callora.mobile.data.preferences

import android.content.Context
import co.callora.mobile.BuildConfig
import co.callora.mobile.core.logging.SafeLog
import co.callora.mobile.data.api.ApiUrlPolicy
import java.util.UUID

class AppPreferences(context: Context) {
    private val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var disclosureAccepted: Boolean
        get() = preferences.getBoolean(KEY_DISCLOSURE, false)
        set(value) = preferences.edit().putBoolean(KEY_DISCLOSURE, value).apply()

    var disclosureAcceptedAt: String?
        get() = preferences.getString(KEY_DISCLOSURE_ACCEPTED_AT, null)
        set(value) = preferences.edit().putString(KEY_DISCLOSURE_ACCEPTED_AT, value).apply()

    var consentStale: Boolean
        get() = preferences.getBoolean(KEY_CONSENT_STALE, false)
        set(value) = preferences.edit().putBoolean(KEY_CONSENT_STALE, value).apply()

    var permissionPromptedPolicyHash: String?
        get() = preferences.getString(KEY_PERMISSION_PROMPTED_POLICY_HASH, null)
        set(value) {
            check(preferences.edit().putString(KEY_PERMISSION_PROMPTED_POLICY_HASH, value).commit()) {
                "Unable to persist permission-prompt state"
            }
        }

    var revoked: Boolean
        get() = preferences.getBoolean(KEY_REVOKED, false)
        set(value) = preferences.edit().putBoolean(KEY_REVOKED, value).apply()

    var revocationPending: Boolean
        get() = preferences.getBoolean(KEY_REVOCATION_PENDING, false)
        set(value) {
            check(preferences.edit().putBoolean(KEY_REVOCATION_PENDING, value).commit()) {
                "Unable to persist revocation state"
            }
        }

    var syncCursor: String?
        get() = preferences.getString(KEY_CURSOR, null)
        set(value) = preferences.edit().putString(KEY_CURSOR, value).apply()

    var lastScanEpochMillis: Long
        get() = preferences.getLong(KEY_LAST_SCAN, 0L)
        set(value) = preferences.edit().putLong(KEY_LAST_SCAN, value.coerceAtLeast(0L)).apply()

    var lastSuccessfulSyncAt: String?
        get() = preferences.getString(KEY_LAST_SYNC, null)
        set(value) = preferences.edit().putString(KEY_LAST_SYNC, value).apply()

    var apiBaseUrl: String
        get() = preferences.getString(KEY_API_BASE_URL, null) ?: BuildConfig.DEFAULT_API_BASE_URL
        set(value) {
            val normalized = ApiUrlPolicy.normalizeAndRequireAllowed(value)
            preferences.edit().putString(KEY_API_BASE_URL, normalized).apply()
        }

    val installationId: String
        get() {
            preferences.getString(KEY_INSTALLATION_ID, null)?.let { return it }
            val generated = UUID.randomUUID().toString()
            check(preferences.edit().putString(KEY_INSTALLATION_ID, generated).commit()) {
                "Unable to persist installation ID"
            }
            return generated
        }

    fun regenerateInstallationId(): String {
        val generated = UUID.randomUUID().toString()
        check(preferences.edit().putString(KEY_INSTALLATION_ID, generated).commit()) {
            "Unable to replace installation ID"
        }
        return generated
    }

    fun recentErrors(): List<String> = preferences.getString(KEY_RECENT_ERRORS, null)
        ?.lineSequence()
        ?.filter(String::isNotBlank)
        ?.take(MAX_ERRORS)
        ?.toList()
        .orEmpty()

    fun recordError(operation: String, message: String) {
        val entry = "${System.currentTimeMillis()}|${SafeLog.redact(operation)}|${SafeLog.redact(message)}"
        val updated = (listOf(entry) + recentErrors()).take(MAX_ERRORS).joinToString("\n")
        preferences.edit().putString(KEY_RECENT_ERRORS, updated).apply()
    }

    fun clearOperationalState() {
        preferences.edit()
            .remove(KEY_CURSOR)
            .remove(KEY_LAST_SCAN)
            .remove(KEY_LAST_SYNC)
            .remove(KEY_RECENT_ERRORS)
            .apply()
    }

    private companion object {
        const val PREFS = "callora_app_preferences"
        const val KEY_DISCLOSURE = "disclosure_accepted"
        const val KEY_DISCLOSURE_ACCEPTED_AT = "disclosure_accepted_at"
        const val KEY_CONSENT_STALE = "consent_stale"
        const val KEY_PERMISSION_PROMPTED_POLICY_HASH = "permission_prompted_policy_hash"
        const val KEY_REVOKED = "device_revoked"
        const val KEY_REVOCATION_PENDING = "revocation_pending"
        const val KEY_CURSOR = "sync_cursor"
        const val KEY_LAST_SCAN = "last_call_scan_epoch_millis"
        const val KEY_LAST_SYNC = "last_successful_sync_at"
        const val KEY_API_BASE_URL = "api_base_url"
        const val KEY_INSTALLATION_ID = "installation_id"
        const val KEY_RECENT_ERRORS = "recent_errors"
        const val MAX_ERRORS = 10
    }
}
