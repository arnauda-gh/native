package com.anonymous.bulwarkmobile

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BulwarkNotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val notificationId = intent.getStringExtra(BulwarkFcmModule.EXTRA_NOTIFICATION_ID)
        val action = intent.getStringExtra(BulwarkFcmModule.EXTRA_ACTION)
        val emailId = intent.getStringExtra(NotificationTapStore.EXTRA_EMAIL_ID)

        // Dismiss the notification immediately from the tray
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (notificationId != null) {
            manager.cancel(notificationId, notificationId.hashCode())
        }

        if (emailId.isNullOrBlank() || action.isNullOrBlank()) return

        // Dispatch background headless task to perform JMAP operations
        val serviceIntent = Intent(context, BulwarkNotificationActionService::class.java).apply {
            intent.extras?.let { putExtras(it) }
        }

        try {
            context.startService(serviceIntent)
        } catch (e: Exception) {
            Log.w("BulwarkNotifAction", "Failed to start action service: ${e.message}")
        }
    }
}
