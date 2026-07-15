import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.net.URI

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.kapt)
}

fun String.asBuildConfigString(): String =
    "\"${replace("\\", "\\\\").replace("\"", "\\\"")}\""

val releaseApiBaseUrl = providers.gradleProperty("CALLORA_ANDROID_API_BASE_URL")
    .orElse(providers.environmentVariable("CALLORA_ANDROID_API_BASE_URL"))
    .orElse("https://api.callora.example")
    .get()
val releaseKeystorePath = providers.environmentVariable("CALLORA_ANDROID_KEYSTORE_PATH").orNull
val releaseKeystorePassword = providers.environmentVariable("CALLORA_ANDROID_KEYSTORE_PASSWORD").orNull
val releaseKeyAlias = providers.environmentVariable("CALLORA_ANDROID_KEY_ALIAS").orNull
val releaseKeyPassword = providers.environmentVariable("CALLORA_ANDROID_KEY_PASSWORD").orNull
val releaseSigningConfigured = listOf(
    releaseKeystorePath,
    releaseKeystorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { !it.isNullOrBlank() }

android {
    namespace = "co.callora.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "co.callora.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-alpha01"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
        buildConfigField("String", "DEFAULT_API_BASE_URL", releaseApiBaseUrl.asBuildConfigString())
    }

    flavorDimensions += "collectionMode"
    productFlavors {
        create("demo") {
            dimension = "collectionMode"
            applicationIdSuffix = ".demo"
            versionNameSuffix = "-demo"
            buildConfigField("boolean", "ENTERPRISE_CALL_LOG", "false")
            buildConfigField("String", "COLLECTION_MODE", "\"synthetic_demo\"")
        }
        create("enterprise") {
            dimension = "collectionMode"
            buildConfigField("boolean", "ENTERPRISE_CALL_LOG", "true")
            buildConfigField("String", "COLLECTION_MODE", "\"android_call_log\"")
        }
    }

    signingConfigs {
        if (releaseSigningConfigured) {
            create("calloraRelease") {
                storeFile = file(requireNotNull(releaseKeystorePath))
                storePassword = requireNotNull(releaseKeystorePassword)
                keyAlias = requireNotNull(releaseKeyAlias)
                keyPassword = requireNotNull(releaseKeyPassword)
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            buildConfigField("String", "DEFAULT_API_BASE_URL", "\"http://10.0.2.2:4100\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("calloraRelease")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }

    testOptions {
        unitTests.isIncludeAndroidResources = false
    }
}

val phase3dReleasePreflight by tasks.registering {
    group = "verification"
    description = "Fail closed unless the release API origin and external signing material are configured."

    doLast {
        val apiUri = runCatching { URI(releaseApiBaseUrl) }.getOrNull()
        val apiHost = apiUri?.host?.lowercase()
        val placeholderHosts = setOf(
            "localhost",
            "example",
            "example.com",
            "example.net",
            "example.org",
            "test",
            "invalid",
        )
        val usesPlaceholderHost = apiHost == null || placeholderHosts.any { placeholder ->
            apiHost == placeholder || apiHost.endsWith(".$placeholder")
        }
        // Mobile release origins must be deployed DNS names. Rejecting every IP
        // literal covers the complete 127/8 range, bracketed IPv6 loopback, and
        // other machine-local endpoints without relying on DNS resolution.
        val usesIpLiteral = apiHost?.contains(":") == true ||
            apiHost?.matches(Regex("""^\d{1,3}(?:\.\d{1,3}){3}$""")) == true
        check(
            apiUri?.scheme.equals("https", ignoreCase = true) &&
                apiUri?.rawUserInfo == null &&
                apiUri?.rawQuery == null &&
                apiUri?.rawFragment == null &&
                (apiUri?.rawPath.isNullOrEmpty() || apiUri?.rawPath == "/") &&
                !apiHost.isNullOrBlank() &&
                !usesIpLiteral &&
                !usesPlaceholderHost
        ) {
            "CALLORA_ANDROID_API_BASE_URL must be an exact deployed HTTPS origin."
        }
        check(releaseSigningConfigured) {
            "Release signing requires CALLORA_ANDROID_KEYSTORE_PATH, CALLORA_ANDROID_KEYSTORE_PASSWORD, " +
                "CALLORA_ANDROID_KEY_ALIAS, and CALLORA_ANDROID_KEY_PASSWORD in the process environment."
        }
        check(file(requireNotNull(releaseKeystorePath)).isFile) {
            "CALLORA_ANDROID_KEYSTORE_PATH must point to a readable external keystore file."
        }
    }
}

tasks.configureEach {
    if (name in setOf(
            "preDemoReleaseBuild",
            "preEnterpriseReleaseBuild",
            "assembleDemoRelease",
            "assembleEnterpriseRelease",
            "bundleDemoRelease",
            "bundleEnterpriseRelease",
        )
    ) {
        dependsOn(phase3dReleasePreflight)
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        freeCompilerArgs.add("-Xannotation-default-target=param-property")
    }
}

kapt {
    correctErrorTypes = true
    arguments {
        arg("room.schemaLocation", "$projectDir/schemas")
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    kapt(libs.androidx.room.compiler)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.kotlinx.coroutines.android)

    implementation(platform(libs.compose.bom))
    androidTestImplementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.compose.ui.test.junit4)
}
