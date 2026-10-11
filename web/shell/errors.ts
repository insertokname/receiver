// SPDX-License-Identifier: AGPL-3.0-only
//
// What Electron's main process does with native dialogs when the database
// can't be used (app/main.main.ts onDatabaseInitializationError and its
// 'database-error' handler), as the shell's own screens:
//
// - in use by another window: "Use here" (tabs.ts);
// - its key is missing or wrong, or the file is corrupted: "Delete data and
//   link again" (Desktop: "Delete and restart"), after a confirmation; it
//   uses the same paths as Desktop's delete (remove-db, erase-sql-key);
// - the browser's storage is full: say so;
// - anything else: try again, or delete and link again.

import { showInUse } from './tabs.ts';
import { showScreen } from './ui.ts';

export type DatabaseFailure = Readonly<{ name: string; message: string }>;

export type RecoveryActions = Readonly<{
  /** Removes the database, its key and the app's files and settings. */
  deleteAllData(): Promise<void>;
}>;

function isQuota(error: DatabaseFailure): boolean {
  return /QuotaExceeded|no storage space|SQLITE_FULL|database or disk is full/i.test(`${error.name} ${error.message}`);
}

function isUnreadable(error: DatabaseFailure): boolean {
  return (
    error.name === 'DatabaseKeyError' ||
    /SQLITE_CORRUPT|SQLITE_NOTADB|file is not a database|database disk image is malformed/i.test(error.message)
  );
}

function confirmDelete(actions: RecoveryActions, back: () => void): void {
  showScreen({
    id: 'confirm-delete',
    title: 'Delete all data and link again?',
    text: [
      "This removes receiver's messages, attachments and settings from this browser. Your phone and your other linked devices keep theirs.",
      'Then link this device again from your phone.',
    ],
    buttons: [
      { label: 'Cancel', kind: 'secondary', onClick: back },
      {
        label: 'Delete data and link again',
        kind: 'danger',
        testId: 'confirm-delete-data',
        onClick: button => {
          button.disabled = true;
          actions.deleteAllData().then(
            () => window.location.reload(),
            error => {
              // oxlint-disable-next-line no-console
              console.error('web shell: deleting the data failed', error);
              showScreen({
                id: 'delete-failed',
                title: 'The data could not be deleted',
                text: [
                  'Close every other receiver window and try again. If this keeps happening, clear this site\'s data in the browser settings.',
                ],
                buttons: [{ label: 'Reload', onClick: () => window.location.reload() }],
              });
            }
          );
        },
      },
    ],
  });
}

/** Shows what can be done about a database that did not open. */
export function showDatabaseError(error: DatabaseFailure, actions: RecoveryActions): void {
  document.documentElement.dataset.webDatabaseError = error.name;
  if (error.name === 'DatabaseInUseError') {
    showInUse();
    return;
  }
  if (isQuota(error)) {
    showQuotaError();
    return;
  }
  const unreadable = isUnreadable(error);
  const show = () =>
    showScreen({
      id: unreadable ? 'database-unreadable' : 'database-error',
      title: unreadable ? "receiver can't open its data" : 'Something went wrong opening receiver',
      text: unreadable
        ? [
            'The data receiver keeps in this browser can no longer be read (its key is missing or the file is damaged), for example because some site data was cleared.',
            'Delete it and link this device again from your phone. Your phone still has your messages.',
          ]
        : [`${error.name}: ${error.message}`, 'Reload to try again. If this keeps happening, delete the data and link again.'],
      buttons: [
        ...(unreadable ? [] : [{ label: 'Reload', onClick: () => window.location.reload() }]),
        {
          label: 'Delete data and link again',
          kind: unreadable ? ('primary' as const) : ('secondary' as const),
          testId: 'delete-data',
          onClick: () => confirmDelete(actions, show),
        },
      ],
    });
  show();
}

let quotaShown = false;

/** The browser refused to store more (also while the app runs). */
export function showQuotaError(): void {
  if (quotaShown) {
    return;
  }
  quotaShown = true;
  showScreen({
    id: 'storage-full',
    title: 'Not enough storage space',
    text: [
      'The browser has no space left for receiver\'s data, so new messages can\'t be saved.',
      'Free up disk space (or remove other websites\' data in the browser settings), then reload.',
    ],
    buttons: [{ label: 'Reload', onClick: () => window.location.reload() }],
  });
}

/** The database became unusable while the app runs (Electron: 'database-error'). */
export function showRuntimeDatabaseError(error: DatabaseFailure, actions: RecoveryActions): void {
  if (isQuota(error)) {
    showQuotaError();
  } else {
    showDatabaseError(error, actions);
  }
}
