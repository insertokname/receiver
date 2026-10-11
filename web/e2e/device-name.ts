// SPDX-License-Identifier: AGPL-3.0-only
//
// For the end-to-end tests (bundled for Node by backup-generator.mjs): the
// device name a linking device sent, decrypted with the account's identity
// key, as Desktop's AccountManager.decryptDeviceName does. The key comes
// serialized: the mock server has its own copy of libsignal.

import { PrivateKey, PublicKey } from '@signalapp/libsignal-client';

import { decryptDeviceName } from '../../ts/Crypto.node.ts';
import { SignalService as Proto } from '../../ts/protobuf/index.std.ts';

export function decryptLinkedDeviceName(base64: string, identityPrivate: Uint8Array<ArrayBuffer>): string {
  const proto = Proto.DeviceName.decode(Buffer.from(base64, 'base64'));
  if (!proto.ephemeralPublic || !proto.syntheticIv || !proto.ciphertext) {
    throw new Error('the device name is not an encrypted DeviceName');
  }
  return decryptDeviceName(
    {
      ephemeralPublic: PublicKey.deserialize(proto.ephemeralPublic),
      syntheticIv: proto.syntheticIv,
      ciphertext: proto.ciphertext,
    },
    PrivateKey.deserialize(identityPrivate)
  );
}
