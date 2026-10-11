// SPDX-License-Identifier: AGPL-3.0-only
//
// For the end-to-end tests (bundled for Node by backup-generator.mjs):
// attachments as a contact's phone sends and receives them, with Desktop's
// own AttachmentCrypto (as ts/test-mock/bootstrap.node.ts
// encryptAndStoreAttachmentOnCDN does): encrypt a file for CDN 3 and make
// its AttachmentPointer; decrypt what the web app uploaded.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  decryptAttachmentV2,
  encryptAttachmentV2,
  generateAttachmentKeys,
} from '../../ts/AttachmentCrypto.node.ts';
import { isVideoTypeSupported } from '../../ts/util/GoogleChrome.std.ts';
import type { MIMEType } from '../../ts/types/MIME.std.ts';

export type Pointer = {
  size: number;
  contentType: string;
  attachmentIdentifier: { cdnKey: string };
  cdnNumber: number;
  key: Uint8Array;
  digest: Uint8Array;
  chunkSize: number | null;
  incrementalMac: Uint8Array | null;
  clientUuid: null;
  thumbnail: null;
  fileName: string | null;
  flags: number | null;
  width: number | null;
  height: number | null;
  caption: null;
  blurHash: null;
  uploadTimestamp: null;
  [key: string]: unknown;
};

/**
 * Encrypts `data` as a phone does for an attachment, stores the ciphertext
 * with `store(cdnKey, stream)` (the mock's storeAttachmentOnCdn) and
 * returns the pointer the phone puts in its message.
 */
export async function encryptAttachment(
  data: Uint8Array<ArrayBuffer>,
  contentType: string,
  store: (cdnKey: string, stream: PassThrough) => Promise<void>,
  extra: Partial<Pointer> = {}
): Promise<Pointer> {
  const cdnKey = crypto.randomUUID();
  const keys = generateAttachmentKeys();
  const sink = new PassThrough();
  const [{ digest, chunkSize, incrementalMac }] = await Promise.all([
    encryptAttachmentV2({
      keys,
      plaintext: { data },
      needIncrementalMac: isVideoTypeSupported(contentType as MIMEType),
      sink,
    }),
    store(cdnKey, sink),
  ]);
  return {
    size: data.byteLength,
    contentType,
    attachmentIdentifier: { cdnKey },
    cdnNumber: 3,
    key: keys,
    digest,
    chunkSize: chunkSize ?? null,
    incrementalMac: incrementalMac ?? null,
    clientUuid: null,
    thumbnail: null,
    fileName: null,
    flags: null,
    width: null,
    height: null,
    caption: null,
    blurHash: null,
    uploadTimestamp: null,
    ...extra,
  };
}

/** Decrypts an attachment the app uploaded (`ciphertextPath` on the mock's CDN) and checks its digest. */
export async function decryptAttachment(
  ciphertextPath: string,
  pointer: { key: Uint8Array; digest: Uint8Array; size: number }
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'receiver-e2e-attachment-'));
  try {
    const { path } = await decryptAttachmentV2({
      type: 'standard',
      ciphertextPath,
      idForLogging: 'e2e',
      keysBase64: Buffer.from(pointer.key).toString('base64'),
      size: pointer.size,
      theirChunkSize: undefined,
      theirIncrementalMac: undefined,
      integrityCheck: { type: 'encrypted', digest: new Uint8Array(pointer.digest) as Uint8Array<ArrayBuffer> },
      getAbsoluteAttachmentPath: relative => join(dir, relative),
    });
    return await readFile(join(dir, path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A profile avatar as the contact's phone uploads it (encrypted with the profile key). */
export { encryptProfile } from '../../ts/Crypto.node.ts';
