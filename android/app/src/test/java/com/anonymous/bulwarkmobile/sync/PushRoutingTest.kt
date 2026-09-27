package com.anonymous.bulwarkmobile.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PushRoutingTest {
    private val contacts = "com.android.contacts"
    private val calendar = "com.android.calendar"

    private val routes = PushRouting.parseRoutes(
        """
        {
          "c": [{ "accountName": "alice@example.org", "authorities": ["$contacts", "$calendar"] }],
          "team": [
            { "accountName": "alice@example.org", "authorities": ["$contacts"] },
            { "accountName": "alice-work", "authorities": ["$calendar"] }
          ]
        }
        """.trimIndent(),
        strict = true,
    )

    private fun stateChange(changed: String) = mapOf(
        "kind" to "jmap-state-change",
        "accountLabel" to "alice",
        "accountId" to "c",
        "emailIds" to "[]",
        "changed" to changed,
    )

    @Test
    fun `a contact change requests a contacts sync and no mail task`() {
        val decision = PushRouting.decide(stateChange("""{"c":{"ContactCard":"s1"}}"""), routes)
        assertEquals(setOf("alice@example.org" to contacts), decision.syncs)
        assertFalse(decision.startMailTask)
    }

    @Test
    fun `calendar types request calendar syncs of the routed accounts only`() {
        val decision = PushRouting.decide(stateChange("""{"team":{"Calendar":"s1","CalendarEvent":"s2"}}"""), routes)
        assertEquals(setOf("alice-work" to calendar), decision.syncs)
        assertFalse(decision.startMailTask)
    }

    @Test
    fun `every account key is routed, not only the one repeated as accountId`() {
        val decision = PushRouting.decide(
            stateChange("""{"c":{"AddressBook":"s1"},"team":{"ContactCard":"s2","CalendarEvent":"s3"}}"""),
            routes,
        )
        // alice@example.org's contacts sync is requested once.
        assertEquals(setOf("alice@example.org" to contacts, "alice-work" to calendar), decision.syncs)
    }

    @Test
    fun `mail anywhere in the map starts the mail task, next to the syncs`() {
        val decision = PushRouting.decide(
            stateChange("""{"team":{"CalendarEvent":"s1"},"c":{"EmailDelivery":"s2","Email":"s3"}}"""),
            routes,
        )
        assertTrue(decision.startMailTask)
        assertEquals(setOf("alice-work" to calendar), decision.syncs)
    }

    @Test
    fun `an email push always starts the mail task`() {
        val data = mapOf("kind" to "jmap-email-push", "accountId" to "c", "changed" to """{"c":{"EmailDelivery":"s"}}""")
        assertTrue(PushRouting.decide(data, routes).startMailTask)
        assertTrue(PushRouting.decide(mapOf("kind" to "jmap-email-push"), routes).startMailTask)
    }

    @Test
    fun `payloads without a readable map are legacy mail pushes`() {
        for (changed in listOf(null, "", "{}", "not json", "[1]", """{"c":{}}""")) {
            val data = stateChange(changed ?: "").let { if (changed == null) it - "changed" else it }
            val decision = PushRouting.decide(data, routes)
            assertTrue("changed=$changed", decision.startMailTask)
            assertTrue("changed=$changed", decision.syncs.isEmpty())
        }
    }

    @Test
    fun `an unreadable account entry may be mail`() {
        val decision = PushRouting.decide(stateChange("""{"c":"garbled","team":{"ContactCard":"s"}}"""), routes)
        assertTrue(decision.startMailTask)
        assertEquals(setOf("alice@example.org" to contacts), decision.syncs)
    }

    @Test
    fun `accounts without routes are ignored`() {
        val decision = PushRouting.decide(stateChange("""{"elsewhere":{"ContactCard":"s"}}"""), routes)
        assertTrue(decision.syncs.isEmpty())
        assertFalse(decision.startMailTask)
        assertTrue(PushRouting.decide(stateChange("""{"c":{"ContactCard":"s"}}"""), emptyMap()).syncs.isEmpty())
    }

    @Test
    fun `stored routes are validated strictly and read leniently`() {
        val bad = listOf(
            "[]",
            """{"c":{}}""",
            """{"c":[{"authorities":["$contacts"]}]}""",
            """{"c":[{"accountName":"a","authorities":["com.example.tasks"]}]}""",
        )
        for (json in bad) {
            try {
                PushRouting.parseRoutes(json, strict = true)
                throw AssertionError("accepted $json")
            } catch (e: IllegalArgumentException) {
                // expected
            }
        }
        assertEquals(emptyMap<String, List<PushRouting.Route>>(), PushRouting.parseRoutes("[]"))
        assertEquals(
            mapOf("c" to listOf(PushRouting.Route("a", setOf(contacts)))),
            PushRouting.parseRoutes("""{"c":[{"accountName":"a","authorities":["$contacts","com.example.tasks"]},{"x":1}]}"""),
        )
        assertEquals(emptyMap<String, List<PushRouting.Route>>(), PushRouting.parseRoutes(null))
    }
}
