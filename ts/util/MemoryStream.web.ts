// SPDX-License-Identifier: AGPL-3.0-only

// Web build: each read returns a copy, not a view into the whole buffer.
// libsignal's WebAssembly bridge (emnapi) copies the entire ArrayBuffer
// behind a view into WebAssembly memory on every call, so reading a large
// video in pieces for the Mp4Sanitizer would copy all of it each time.

import { MemoryStream as DesktopMemoryStream } from './MemoryStream.node.ts';

export class MemoryStream extends DesktopMemoryStream {
  public override async read(amount: number): Promise<Uint8Array<ArrayBuffer>> {
    return (await super.read(amount)).slice();
  }
}
