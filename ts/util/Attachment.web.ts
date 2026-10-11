// SPDX-License-Identifier: AGPL-3.0-only

// Web build: saving an attachment is a browser download, streamed and
// decrypted through the service worker (web/main/downloads.ts); the rest of
// the module is Desktop's.

import type { AttachmentType } from '../types/Attachment.std.ts';
import { getSuggestedFilename } from './Attachment.std.ts';
import { getDesktopLocalAttachmentUrl } from './getLocalAttachmentUrl.web.ts';
import { sealLocalUrl } from '../../web/main/local-urls.ts';
import {
  canStreamDownloads,
  downloadBytes,
  downloadLocalUrl,
} from '../../web/main/downloads.ts';

export * from './Attachment.std.ts';

type SaveOptions = Parameters<typeof import('./Attachment.std.ts').save>[0];

/**
 * Desktop's save(): the file goes to the browser's downloads (with Desktop's
 * suggested name) instead of a path from a save dialog; `baseDir` (saving
 * several attachments into a folder) is the browser's downloads too.
 * Resolves to the name, which Desktop shows in its "saved" toast.
 */
export const save = async ({
  attachment,
  index,
  readAttachmentData,
  timestamp,
}: SaveOptions): Promise<string | null> => {
  const name = getSuggestedFilename({ attachment, timestamp, index });
  if (attachment.path && canStreamDownloads()) {
    const url = new URL(getDesktopLocalAttachmentUrl(attachment as AttachmentType));
    url.searchParams.set('webDownload', name);
    downloadLocalUrl(sealLocalUrl(url.toString()));
    return name;
  }
  let data: Uint8Array<ArrayBuffer>;
  if (attachment.path) {
    data = await readAttachmentData(attachment);
  } else if (attachment.data) {
    data = attachment.data;
  } else {
    throw new Error('Attachment had neither path nor data');
  }
  downloadBytes(data, name);
  return name;
};
