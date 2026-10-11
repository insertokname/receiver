// SPDX-License-Identifier: AGPL-3.0-only
//
// For the end-to-end tests (bundled for Node by backup-generator.mjs): an
// ephemeral backup from Desktop's generator, made large by more of the
// zero padding the backup format already has after its gzip stream (as
// ts/util/logPadding.node.ts appends). The generator's output is decrypted
// with the backup's keys, padded and encrypted again under a new IV and
// MAC, streamed so that the large file never sits in memory.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import type { Aci } from '@signalapp/libsignal-client';
import { BackupKey } from '@signalapp/libsignal-client/dist/AccountKeys.js';
import { MessageBackupKey } from '@signalapp/libsignal-client/dist/MessageBackup.js';

import { generateBackup } from '../../ts/test-helpers/generateBackup.node.ts';
import type { BackupGeneratorConfigType } from '../../ts/test-helpers/generateBackup.node.ts';
import { toAciObject } from '../../ts/util/ServiceId.node.ts';
import type { AciString } from '../../ts/types/ServiceId.std.ts';

const IV_LENGTH = 16;
const MAC_LENGTH = 32;
const CHUNK = 1024 * 1024;

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** Resolves to the encrypted backup (a stream) of about `paddedBytes` bytes. */
export async function generatePaddedBackup(
  options: BackupGeneratorConfigType & { backupKey: Uint8Array<ArrayBuffer> },
  paddedBytes: number
): Promise<{ stream: Readable; size: number }> {
  const backupKey = new BackupKey(options.backupKey);
  const backupId = backupKey.deriveBackupId(toAciObject(options.aci as AciString) as Aci);
  const { aesKey, hmacKey } = new MessageBackupKey({ backupKey, backupId });

  const encrypted = await collect(generateBackup(options).stream);
  const iv = encrypted.subarray(0, IV_LENGTH);
  const decipher = createDecipheriv('aes-256-cbc', aesKey, iv);
  const plaintext = Buffer.concat([
    decipher.update(encrypted.subarray(IV_LENGTH, encrypted.length - MAC_LENGTH)),
    decipher.final(),
  ]);

  const extra = Math.max(0, paddedBytes - plaintext.length);
  const newIv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-cbc', aesKey, newIv);
  const hmac = createHmac('sha256', hmacKey);
  const blocks = Math.floor((plaintext.length + extra) / 16) + 1;
  const size = IV_LENGTH + blocks * 16 + MAC_LENGTH;

  function* chunks(): Iterable<Buffer> {
    hmac.update(newIv);
    yield newIv;
    const emit = (data: Buffer) => {
      hmac.update(data);
      return data;
    };
    yield emit(cipher.update(plaintext));
    const zeros = Buffer.alloc(CHUNK);
    for (let left = extra; left > 0; left -= CHUNK) {
      yield emit(cipher.update(left >= CHUNK ? zeros : zeros.subarray(0, left)));
    }
    yield emit(cipher.final());
    yield hmac.digest();
  }
  return { stream: Readable.from(chunks()), size };
}
