package co.callora.mobile.core.security

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileCredentialGeneratorTest {
    @Test
    fun `credentials use required prefixes and 256 bits of base64url entropy`() {
        val generator = MobileCredentialGenerator()
        val bootstrap = generator.bootstrap()
        val session = generator.session()

        assertTrue(bootstrap.matches(Regex("^clb_[A-Za-z0-9_-]{43}$")))
        assertTrue(session.matches(Regex("^cls_[A-Za-z0-9_-]{43}$")))
        assertEquals(32, java.util.Base64.getUrlDecoder().decode(bootstrap.removePrefix("clb_")).size)
        assertEquals(32, java.util.Base64.getUrlDecoder().decode(session.removePrefix("cls_")).size)
        assertNotEquals(session, generator.session())
    }
}
