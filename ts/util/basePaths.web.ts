// SPDX-License-Identifier: AGPL-3.0-only

// Web build: the same directory layout under userData as app/attachments.node.ts,
// without resolving symlinks on disk (the storage layer maps these paths to
// the browser's origin private file system).

import { join } from 'node:path';

const userDataPath = window.SignalContext.getPath('userData');

export const ATTACHMENTS_PATH = join(userDataPath, 'attachments.noindex');
export const DRAFT_PATH = join(userDataPath, 'drafts.noindex');
export const STICKERS_PATH = join(userDataPath, 'stickers.noindex');
export const TEMP_PATH = join(userDataPath, 'temp');
export const BADGES_PATH = join(userDataPath, 'badges.noindex');
export const AVATARS_PATH = join(userDataPath, 'avatars.noindex');
export const DOWNLOADS_PATH = join(userDataPath, 'downloads.noindex');
export const MEGAPHONES_PATH = join(userDataPath, 'megaphones.noindex');
