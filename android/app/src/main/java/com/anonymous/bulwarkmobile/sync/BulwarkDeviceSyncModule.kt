package com.anonymous.bulwarkmobile.sync

import android.accounts.Account
import android.accounts.AccountManager
import android.accounts.OnAccountsUpdateListener
import android.content.ActivityNotFoundException
import android.content.ContentResolver
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter
import org.json.JSONObject

/**
 * `NativeModules.BulwarkDeviceSync`: Android accounts, sync settings and the
 * run handshake of device sync (#34). The contract is `DeviceSyncNativeModule`
 * in src/device-sync/types.ts; docs/device-sync.md explains it.
 */
class BulwarkDeviceSyncModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val accountsListener = OnAccountsUpdateListener {
        emit(ACCOUNTS_CHANGED_EVENT, null)
    }

    init {
        synchronized(BulwarkDeviceSyncModule::class.java) { currentInstance = this }
    }

    override fun getName(): String = NAME

    override fun initialize() {
        super.initialize()
        val manager = AccountManager.get(reactApplicationContext)
        val handler = Handler(Looper.getMainLooper())
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                manager.addOnAccountsUpdatedListener(accountsListener, handler, false, arrayOf(accountType()))
            } else {
                manager.addOnAccountsUpdatedListener(accountsListener, handler, false)
            }
        } catch (e: RuntimeException) {
            Log.w(TAG, "Account change listener not registered", e)
        }
    }

    override fun invalidate() {
        try {
            AccountManager.get(reactApplicationContext).removeOnAccountsUpdatedListener(accountsListener)
        } catch (e: RuntimeException) {
            // Not registered.
        }
        super.invalidate()
    }

    private fun accountType() = DeviceSyncAccounts.accountType(reactApplicationContext)

    // ── accounts ────────────────────────────────────────────────

    @ReactMethod
    fun getInfo(promise: Promise) {
        promise.resolve(Arguments.createMap().apply {
            putString("accountType", accountType())
            putInt("sdkInt", Build.VERSION.SDK_INT)
        })
    }

    @ReactMethod
    fun listAccounts(promise: Promise) = settle(promise) {
        Arguments.createArray().apply {
            for ((account, registryId) in DeviceSyncAccounts.list(reactApplicationContext)) {
                pushMap(Arguments.createMap().apply {
                    putString("name", account.name)
                    putString("registryId", registryId)
                })
            }
        }
    }

    @ReactMethod
    fun ensureAccount(name: String, registryId: String, promise: Promise) = settle(promise) {
        DeviceSyncAccounts.ensure(reactApplicationContext, name, registryId)
    }

    @ReactMethod
    fun removeAccount(name: String, promise: Promise) = settle(promise) {
        DeviceSyncAccounts.remove(reactApplicationContext, name)
    }

    // ── sync settings ───────────────────────────────────────────

    @ReactMethod
    fun getSyncSettings(name: String, promise: Promise) = settle(promise) {
        val account = DeviceSyncAccounts.account(reactApplicationContext, name)
        Arguments.createMap().apply {
            putBoolean("masterAutomatic", ContentResolver.getMasterSyncAutomatically())
            putMap("authorities", Arguments.createMap().apply {
                for (authority in DeviceSyncAccounts.AUTHORITIES) putMap(authority, authoritySettings(account, authority))
            })
        }
    }

    private fun authoritySettings(account: Account, authority: String): WritableMap = Arguments.createMap().apply {
        putInt("syncable", ContentResolver.getIsSyncable(account, authority))
        putBoolean("automatic", ContentResolver.getSyncAutomatically(account, authority))
        val periodic = ContentResolver.getPeriodicSyncs(account, authority).minOfOrNull { it.period } ?: 0L
        putDouble("periodicSeconds", periodic.toDouble())
        putBoolean("active", ContentResolver.isSyncActive(account, authority))
        putBoolean("pending", ContentResolver.isSyncPending(account, authority))
    }

    @ReactMethod
    fun setSyncEnabled(name: String, authority: String, enabled: Boolean, promise: Promise) = settle(promise) {
        DeviceSyncAccounts.setSyncEnabled(reactApplicationContext, name, authority, enabled)
        null
    }

    @ReactMethod
    fun setPeriodicSync(name: String, authority: String, seconds: Double, promise: Promise) = settle(promise) {
        DeviceSyncAccounts.setPeriodicSync(reactApplicationContext, name, authority, seconds.toLong())
        null
    }

    @ReactMethod
    fun requestSync(name: String, authority: String, optionsJson: String, promise: Promise) = settle(promise) {
        val options = JSONObject(optionsJson)
        val flags = SyncRequestFlags(
            manual = options.optBoolean("manual"),
            expedited = options.optBoolean("expedited"),
            upload = options.optBoolean("upload"),
            overrideTooManyDeletions = options.optBoolean("overrideTooManyDeletions"),
            discardLocalDeletions = options.optBoolean("discardLocalDeletions"),
        )
        DeviceSyncAccounts.requestSync(reactApplicationContext, name, authority, flags)
        null
    }

    /** The account's own sync screen where the platform has one, else the list of synced accounts. */
    @ReactMethod
    fun openAccountSettings(name: String, promise: Promise) = settle(promise) {
        val account = DeviceSyncAccounts.account(reactApplicationContext, name)
        val perAccount = Intent(ACTION_ACCOUNT_SYNC_SETTINGS).putExtra(EXTRA_ACCOUNT, account)
        val overview = Intent(Settings.ACTION_SYNC_SETTINGS)
            .putExtra(Settings.EXTRA_ACCOUNT_TYPES, arrayOf(account.type))
        val activity = reactApplicationContext.currentActivity
        for (intent in listOf(perAccount, overview)) {
            try {
                if (activity != null) {
                    activity.startActivity(intent)
                } else {
                    reactApplicationContext.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                return@settle null
            } catch (e: ActivityNotFoundException) {
                // Try the next one.
            }
        }
        throw IllegalStateException("No settings screen for sync accounts")
    }

    // ── run handshake ───────────────────────────────────────────

    @ReactMethod
    fun finishRun(runId: String, reportJson: String, promise: Promise) {
        val accepted = DeviceSyncRuns.finish(runId, reportJson)
        if (!accepted) Log.i(TAG, "Report for run $runId ignored: nothing waits for it")
        promise.resolve(accepted)
    }

    @ReactMethod
    fun isRunCancelled(runId: String, promise: Promise) {
        promise.resolve(DeviceSyncRuns.isCancelled(runId))
    }

    // NativeEventEmitter bookkeeping.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    private inline fun settle(promise: Promise, block: () -> Any?) {
        try {
            promise.resolve(block())
        } catch (e: SecurityException) {
            promise.reject("permission", e.message, e)
        } catch (e: IllegalArgumentException) {
            promise.reject("bad_args", e.message, e)
        } catch (e: Exception) {
            promise.reject("failed", e.message, e)
        }
    }

    companion object {
        const val NAME = "BulwarkDeviceSync"
        private const val TAG = "BulwarkDeviceSync"
        const val ACCOUNTS_CHANGED_EVENT = "BulwarkDeviceSync:accountsChanged"

        /** Settings' per-account sync screen; public on AOSP-based settings apps, but not in the SDK. */
        private const val ACTION_ACCOUNT_SYNC_SETTINGS = "android.settings.ACCOUNT_SYNC_SETTINGS"
        private const val EXTRA_ACCOUNT = "account"

        @Volatile private var currentInstance: BulwarkDeviceSyncModule? = null

        /** Dropped when no React instance or no JS listener is there, like BulwarkFcmModule.emit. */
        fun emit(eventName: String, params: WritableMap?) {
            val module = currentInstance ?: return
            val ctx = module.reactApplicationContext
            if (!ctx.hasActiveReactInstance()) return
            ctx.getJSModule(RCTDeviceEventEmitter::class.java).emit(eventName, params)
        }
    }
}
