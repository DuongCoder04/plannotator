/**
 * The update results Plannotator tells apart (safe updates, step 1). One
 * definition for the server (packages/server/auto-update.ts), `plannotator
 * update`, and the Inbox's failure dialog, so the three never drift.
 */

/**
 * install.sh stopped because the binary did not match the checksum Plannotator
 * fetched, before it replaced anything. Recorded only when install.sh also
 * wrote the update wrapper's marker file; any other exit with this number is
 * recorded as 1.
 */
export const UPDATE_EXIT_CHECKSUM_MISMATCH = 113;

/** Plannotator could not download the install script or the checksum: nothing ran (sysexits EX_TEMPFAIL). */
export const UPDATE_EXIT_DOWNLOAD_FAILED = 75;
