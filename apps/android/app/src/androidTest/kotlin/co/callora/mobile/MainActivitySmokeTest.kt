package co.callora.mobile

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextInput
import androidx.test.platform.app.InstrumentationRegistry
import co.callora.mobile.data.preferences.AppPreferences
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MainActivitySmokeTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun freshInstallPairsBeforeDisplayingServerPolicy() {
        composeRule.onNodeWithText("Pair this installation").assertIsDisplayed()
        composeRule.onNodeWithText("No call metadata is read during pairing.").assertIsDisplayed()

        // Supplying this optional runner argument upgrades the smoke test into a
        // local API E2E without putting a short-lived pairing secret in source.
        val arguments = InstrumentationRegistry.getArguments()
        val pairingCode = arguments
            .getString("pairingCode")
            .orEmpty()
            .trim()
        if (pairingCode.isEmpty()) return

        arguments.getString("apiBaseUrl")
            ?.trim()
            ?.takeIf(String::isNotEmpty)
            ?.let { AppPreferences(InstrumentationRegistry.getInstrumentation().targetContext).apiBaseUrl = it }

        val pairingField = composeRule.onNodeWithText("Pairing code")
        pairingField.performTextInput(pairingCode)
        pairingField.performImeAction()
        composeRule.waitUntil(timeoutMillis = 30_000) {
            composeRule.onAllNodesWithTag("policy_disclosure_list")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        composeRule.onNodeWithTag("policy_disclosure_list").performScrollToIndex(3)
        composeRule.onNodeWithText("Accept policy and activate").performClick()
        composeRule.waitUntil(timeoutMillis = 30_000) {
            composeRule.onAllNodesWithText("Demo collector ready")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        composeRule.onNodeWithText("Demo collector ready").assertIsDisplayed()
    }
}
