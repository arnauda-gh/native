package com.anonymous.bulwarkmobile

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class BulwarkNotificationActionService : HeadlessJsTaskService() {
    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val extras = intent?.extras ?: return null
        return HeadlessJsTaskConfig(
            "BulwarkNotificationAction",
            Arguments.fromBundle(extras),
            15000L,
            true // allowExecutionInForeground
        )
    }
}
