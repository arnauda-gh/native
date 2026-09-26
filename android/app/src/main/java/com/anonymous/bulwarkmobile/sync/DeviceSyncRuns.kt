package com.anonymous.bulwarkmobile.sync

import com.facebook.react.interfaces.TaskInterface
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicReference

/**
 * The device sync runs an adapter is waiting for, keyed by a random run id.
 *
 * A run ends on the first of: JS calling finishRun, the headless task ending
 * (JS settled, timed out or was reloaded away), React refusing or failing to
 * start, the adapter's deadline, or a cancel. Headless task ids restart at 1
 * with every React context, so they never identify a run; the run id does,
 * and a report for a run nobody waits for any more is ignored.
 */
object DeviceSyncRuns {
    const val NO_TASK = -1

    class Run(val runId: String, val accountName: String, val authority: String) {
        val done = CountDownLatch(1)
        val report = AtomicReference<String?>(null)
        val endReason = AtomicReference<String?>(null)
        @Volatile var cancelled = false
        @Volatile var boot: TaskInterface<Void>? = null
        /** Written and compared on the UI thread only. */
        @Volatile var taskId = NO_TASK
        @Volatile private var tasks: HeadlessJsTaskContext? = null
        @Volatile private var listener: HeadlessJsTaskEventListener? = null

        /** Releases the waiting adapter. Idempotent: the first reason wins. */
        fun end(reason: String) {
            endReason.compareAndSet(null, reason)
            done.countDown()
        }

        fun attach(tasks: HeadlessJsTaskContext, listener: HeadlessJsTaskEventListener) {
            this.tasks = tasks
            this.listener = listener
            tasks.addTaskEventListener(listener)
        }

        fun detach() {
            val tasks = tasks ?: return
            listener?.let { tasks.removeTaskEventListener(it) }
            this.tasks = null
            this.listener = null
        }
    }

    private val runs = ConcurrentHashMap<String, Run>()

    fun open(accountName: String, authority: String): Run =
        Run(UUID.randomUUID().toString(), accountName, authority).also { runs[it.runId] = it }

    /** Forgets the run: a late finishRun is then ignored and isCancelled answers true. */
    fun close(run: Run) {
        run.cancelled = true
        runs.remove(run.runId)
    }

    /** From JS. Returns false when nothing waits for this run (stale, duplicate or finished). */
    fun finish(runId: String, reportJson: String): Boolean {
        val run = runs[runId] ?: return false
        if (!run.report.compareAndSet(null, reportJson)) return false
        run.end("reported")
        return true
    }

    /** Unknown runs count as cancelled: the adapter has stopped waiting for them. */
    fun isCancelled(runId: String): Boolean = runs[runId]?.cancelled ?: true

    fun cancel(runId: String) {
        runs[runId]?.cancelled = true
    }

    /** Runs currently waited for, newest last; for status and the push router's "sync again" flag. */
    fun active(): List<Run> = runs.values.toList()
}
