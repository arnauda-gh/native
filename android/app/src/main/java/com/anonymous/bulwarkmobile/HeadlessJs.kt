package com.anonymous.bulwarkmobile

import android.app.Application
import androidx.annotation.MainThread
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.interfaces.TaskInterface
import com.facebook.react.internal.featureflags.ReactNativeNewArchitectureFeatureFlags
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Running a headless JS task without HeadlessJsTaskService: starting React
 * Native when the process was woken without any UI, and starting the task on
 * its context. Shared by the push job (BulwarkPushJobService) and the device
 * sync adapters.
 */
object HeadlessJs {
    /**
     * Calls [onReady] once with a React context whose JS instance is up,
     * starting React Native if the process was woken for this work.
     *
     * A context exists before its instance is ready, and a task started on
     * it then never reaches JS (HeadlessJsTaskContext only logs "CatalystInstance
     * not available" and waits for the timeout), which happened when several
     * pushes arrived while the app was starting. So the listener goes in
     * first and the ready check after it; whichever sees the ready instance
     * first runs the task.
     *
     * Call it on the main thread; [onReady] runs there too. MainApplication
     * creates the ReactHost on first use without a lock (ExpoReactHostFactory),
     * so a background caller racing MainActivity could create a second one,
     * with a second JS runtime.
     *
     * Returns React Native's start task when it had to be started, so a caller
     * can notice a start that fails (a debug build with no Metro to load the
     * bundle from), or null when the context was already up.
     */
    @MainThread
    fun withReadyReactContext(app: Application, onReady: (ReactContext) -> Unit): TaskInterface<Void>? {
        val done = AtomicBoolean(false)
        val runOnce = { context: ReactContext -> if (done.compareAndSet(false, true)) onReady(context) }
        val reactApp = app as ReactApplication
        if (ReactNativeNewArchitectureFeatureFlags.enableBridgelessArchitecture()) {
            val host = checkNotNull(reactApp.reactHost) { "ReactHost is not initialized in New Architecture" }
            val listener = object : ReactInstanceEventListener {
                override fun onReactContextInitialized(context: ReactContext) {
                    host.removeReactInstanceEventListener(this)
                    runOnce(context)
                }
            }
            host.addReactInstanceEventListener(listener)
            val current = host.currentReactContext
            if (current != null && current.hasActiveReactInstance()) {
                host.removeReactInstanceEventListener(listener)
                runOnce(current)
                return null
            }
            return host.start()
        }
        @Suppress("DEPRECATION")
        val manager = reactApp.reactNativeHost.reactInstanceManager
        val listener = object : ReactInstanceEventListener {
            override fun onReactContextInitialized(context: ReactContext) {
                manager.removeReactInstanceEventListener(this)
                runOnce(context)
            }
        }
        manager.addReactInstanceEventListener(listener)
        val current = manager.currentReactContext
        if (current != null && current.hasActiveReactInstance()) {
            manager.removeReactInstanceEventListener(listener)
            runOnce(current)
        } else if (!manager.hasStartedCreatingInitialContext()) {
            manager.createReactContextInBackground()
        }
        return null
    }

    /**
     * Starts [config] on the UI thread, where HeadlessJsTaskContext wants it.
     * [onStarted] gets the task id in that same UI-thread turn, so before any
     * finish callback (HeadlessJsTaskContext posts those to the UI thread).
     * [onRefused] gets the refusal when the context is resumed and [config]
     * isn't allowed in the foreground.
     */
    fun startTask(
        tasks: HeadlessJsTaskContext,
        config: HeadlessJsTaskConfig,
        onStarted: (taskId: Int) -> Unit,
        onRefused: (IllegalStateException) -> Unit,
    ) {
        UiThreadUtil.runOnUiThread {
            val taskId = try {
                tasks.startTask(config)
            } catch (e: IllegalStateException) {
                onRefused(e)
                return@runOnUiThread
            }
            onStarted(taskId)
        }
    }
}
