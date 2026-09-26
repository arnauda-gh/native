package com.anonymous.bulwarkmobile.sync

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.content.Context
import android.os.Bundle
import android.provider.CalendarContract
import android.provider.ContactsContract
import com.anonymous.bulwarkmobile.R

/**
 * The Android accounts of device sync (#34) and their sync settings. One
 * account per app account that has device sync on; see docs/device-sync.md.
 *
 * Android's own sync settings are the source of truth for on/off: the
 * Contacts and Calendar toggles in Settings → Accounts are
 * `getSyncAutomatically`, and the app reads them back instead of keeping a
 * copy.
 */
object DeviceSyncAccounts {
    const val CONTACTS_AUTHORITY: String = ContactsContract.AUTHORITY
    const val CALENDAR_AUTHORITY: String = CalendarContract.AUTHORITY
    val AUTHORITIES = listOf(CONTACTS_AUTHORITY, CALENDAR_AUTHORITY)

    /** userData key holding the app account (`AccountEntry.id`) an Android account belongs to. */
    const val USER_DATA_REGISTRY_ID = "registryId"

    /** `<applicationId>.account`, set in build.gradle so the package name is never hard-coded. */
    fun accountType(context: Context): String = context.getString(R.string.device_sync_account_type)

    fun account(context: Context, name: String) = Account(name, accountType(context))

    fun list(context: Context): List<Pair<Account, String?>> {
        val manager = AccountManager.get(context)
        return manager.getAccountsByType(accountType(context)).map { it to manager.getUserData(it, USER_DATA_REGISTRY_ID) }
    }

    /**
     * Adds the account when it is missing and (re)writes its registry id.
     * Both authorities start syncable with automatic sync off; the app turns
     * on the ones the user picked. Returns true when the account was created.
     */
    fun ensure(context: Context, name: String, registryId: String): Boolean {
        val manager = AccountManager.get(context)
        val account = account(context, name)
        val exists = manager.getAccountsByType(account.type).any { it.name == name }
        if (exists) {
            manager.setUserData(account, USER_DATA_REGISTRY_ID, registryId)
            return false
        }
        val userData = Bundle().apply { putString(USER_DATA_REGISTRY_ID, registryId) }
        check(manager.addAccountExplicitly(account, null, userData)) { "Android refused to add the account" }
        for (authority in AUTHORITIES) {
            ContentResolver.setIsSyncable(account, authority, 1)
            ContentResolver.setSyncAutomatically(account, authority, false)
        }
        return true
    }

    /** Removes the account; the Contacts and Calendar providers drop all of its rows. */
    fun remove(context: Context, name: String): Boolean {
        val manager = AccountManager.get(context)
        val account = account(context, name)
        if (manager.getAccountsByType(account.type).none { it.name == name }) return false
        return manager.removeAccountExplicitly(account)
    }

    fun setSyncEnabled(context: Context, name: String, authority: String, enabled: Boolean) {
        requireAuthority(authority)
        val account = account(context, name)
        ContentResolver.setIsSyncable(account, authority, 1)
        ContentResolver.setSyncAutomatically(account, authority, enabled)
    }

    /** Replaces our periodic sync for the authority; 0 removes it. */
    fun setPeriodicSync(context: Context, name: String, authority: String, seconds: Long) {
        requireAuthority(authority)
        val account = account(context, name)
        for (periodic in ContentResolver.getPeriodicSyncs(account, authority)) {
            ContentResolver.removePeriodicSync(account, authority, periodic.extras)
        }
        if (seconds > 0) ContentResolver.addPeriodicSync(account, authority, Bundle.EMPTY, seconds)
    }

    fun requestSync(context: Context, name: String, authority: String, flags: SyncRequestFlags) {
        requireAuthority(authority)
        ContentResolver.requestSync(account(context, name), authority, flags.toExtras())
    }

    fun requireAuthority(authority: String) {
        require(authority in AUTHORITIES) { "Unknown authority $authority" }
    }
}

/** The SYNC_EXTRAS_* flags a request carries. Constant extras let repeated requests coalesce. */
data class SyncRequestFlags(
    val manual: Boolean = false,
    val expedited: Boolean = false,
    val upload: Boolean = false,
    val overrideTooManyDeletions: Boolean = false,
    val discardLocalDeletions: Boolean = false,
) {
    fun toExtras(): Bundle = Bundle().apply {
        if (manual) putBoolean(ContentResolver.SYNC_EXTRAS_MANUAL, true)
        if (expedited) putBoolean(ContentResolver.SYNC_EXTRAS_EXPEDITED, true)
        if (upload) putBoolean(ContentResolver.SYNC_EXTRAS_UPLOAD, true)
        if (overrideTooManyDeletions) putBoolean(ContentResolver.SYNC_EXTRAS_OVERRIDE_TOO_MANY_DELETIONS, true)
        if (discardLocalDeletions) putBoolean(ContentResolver.SYNC_EXTRAS_DISCARD_LOCAL_DELETIONS, true)
    }
}
