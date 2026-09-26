package com.anonymous.bulwarkmobile.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Debug builds only: lets adb set up device sync accounts without the settings
 * UI, for the device tests in docs/device-sync.md ("Testing"). Protected by
 * android.permission.DUMP, which only the shell and the system hold. Syncs
 * themselves are triggered with `adb shell requestsync`.
 *
 *     adb shell am broadcast -n com.anonymous.bulwarkmobile/.sync.DeviceSyncDebugReceiver \
 *       --es cmd ensure --es name usera@example.org --es registry usera@example.org@10.0.2.2 \
 *       --es enable contacts,calendar
 *
 * Commands: `ensure` (name, registry, optional enable), `enable` (name,
 * authority, optional --ez on false), `remove` (name) and `list`.
 */
class DeviceSyncDebugReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val result = try {
            val name = intent.getStringExtra("name")
            when (intent.getStringExtra("cmd")) {
                "ensure" -> {
                    val created = DeviceSyncAccounts.ensure(context, name!!, intent.getStringExtra("registry")!!)
                    for (which in intent.getStringExtra("enable").orEmpty().split(',').filter { it.isNotBlank() }) {
                        DeviceSyncAccounts.setSyncEnabled(context, name, authority(which), true)
                    }
                    "created=$created"
                }
                "enable" -> {
                    val on = intent.getBooleanExtra("on", true)
                    DeviceSyncAccounts.setSyncEnabled(context, name!!, authority(intent.getStringExtra("authority")!!), on)
                    "enabled=$on"
                }
                "remove" -> "removed=${DeviceSyncAccounts.remove(context, name!!)}"
                "list" -> DeviceSyncAccounts.list(context).joinToString(";") { (account, registryId) -> "${account.name}=$registryId" }
                else -> "unknown cmd"
            }
        } catch (e: Exception) {
            "error: ${e.javaClass.simpleName}: ${e.message}"
        }
        Log.i(TAG, "debug command: $result")
        resultData = result
    }

    private fun authority(which: String) = when (which) {
        "contacts" -> DeviceSyncAccounts.CONTACTS_AUTHORITY
        "calendar" -> DeviceSyncAccounts.CALENDAR_AUTHORITY
        else -> which
    }

    companion object {
        private const val TAG = "BulwarkDeviceSync"
    }
}
