// SPDX-License-Identifier: AGPL-3.0-only

// Web build: Desktop's attachment:// URL, sealed into a same-origin URL that
// the service worker routes back to this page (web/main/local-urls.ts,
// web/main/attachments.ts).

import {
  AttachmentDisposition,
  getLocalAttachmentUrl as getDesktopLocalAttachmentUrl,
} from './getLocalAttachmentUrl.std.ts';
import type { GetLocalAttachmentUrlOptionsType } from './getLocalAttachmentUrl.std.ts';
import { sealLocalUrl } from '../../web/main/local-urls.ts';

export { AttachmentDisposition };
/** Desktop's attachment:// URL itself (only for building a sealed one). */
export { getDesktopLocalAttachmentUrl };
export type { GetLocalAttachmentUrlOptionsType };

export function getLocalAttachmentUrl(
  ...args: Parameters<typeof getDesktopLocalAttachmentUrl>
): string {
  return sealLocalUrl(getDesktopLocalAttachmentUrl(...args));
}
