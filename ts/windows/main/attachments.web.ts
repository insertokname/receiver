// SPDX-License-Identifier: AGPL-3.0-only

// Web build: files Desktop writes to a path the user picked (save dialog)
// or to a folder are browser downloads (web/main/downloads.ts).

import { basename } from 'node:path';

import { downloadBytes } from '../../../web/main/downloads.ts';

export * from './attachments.preload.ts';

export const saveAttachmentToDisk = async ({
  data,
  name,
}: {
  data: Uint8Array<ArrayBuffer>;
  name: string;
  baseDir?: string;
}): Promise<null | { fullPath: string; name: string }> => {
  const fileName = basename(name);
  downloadBytes(data, fileName);
  return { fullPath: fileName, name: fileName };
};
