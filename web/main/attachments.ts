// SPDX-License-Identifier: AGPL-3.0-only
//
// Desktop's attachment channel (app/attachment_channel.main.ts) running in
// the page: the attachment:// protocol (decrypting local files on the fly,
// verified as Desktop verifies them, with Range for audio and video), the
// orphaned-attachment cleanup and the erase-* channels. Its local URLs
// reach it through the service worker (protocols.ts, local-urls.ts).

import { initialize } from '../../app/attachment_channel.main.ts';
import type { MainSQL } from '../../ts/sql/main.main.ts';
import { unsealLocalUrl } from './local-urls.ts';
import { serveLocalRequests } from './protocols.ts';

type SqlCalls = {
  sqlRead(method: string, args: ReadonlyArray<unknown>): Promise<unknown>;
  sqlWrite(method: string, args: ReadonlyArray<unknown>): Promise<unknown>;
};

export function installAttachments({ configDir, sql }: { configDir: string; sql: SqlCalls }): void {
  // The part of MainSQL the channel uses.
  const mainSql = {
    sqlRead: (method: string, ...args: Array<unknown>) => sql.sqlRead(method, args),
    sqlWrite: (method: string, ...args: Array<unknown>) => sql.sqlWrite(method, args),
  } as unknown as MainSQL;
  initialize({ configDir, sql: mainSql });
  serveLocalRequests(unsealLocalUrl);
}
