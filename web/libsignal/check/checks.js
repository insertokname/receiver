// SPDX-License-Identifier: AGPL-3.0-only
//
// Runs libsignal on made-up keys: a PQXDH (Kyber) session between two users
// whose stores are plain in-memory JavaScript objects (libsignal calls them
// asynchronously), a sealed-sender round trip, and zkgroup encryption.

import * as SignalClient from '@signalapp/libsignal-client';
import { ClientZkGroupCipher, GroupSecretParams, ServerSecretParams } from '@signalapp/libsignal-client/zkgroup.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const key = address => `${address.name()}.${address.deviceId()}`;

class SessionStore extends SignalClient.SessionStore {
  #sessions = new Map();
  async saveSession(address, record) {
    this.#sessions.set(key(address), record.serialize());
  }
  async getSession(address) {
    const bytes = this.#sessions.get(key(address));
    return bytes ? SignalClient.SessionRecord.deserialize(bytes) : null;
  }
  async getExistingSessions(addresses) {
    return addresses.map(address => {
      const bytes = this.#sessions.get(key(address));
      if (!bytes) throw new Error(`no session for ${key(address)}`);
      return SignalClient.SessionRecord.deserialize(bytes);
    });
  }
}

class IdentityStore extends SignalClient.IdentityKeyStore {
  #identities = new Map();
  constructor(registrationId) {
    super();
    this.identityKey = SignalClient.PrivateKey.generate();
    this.registrationId = registrationId;
  }
  async getIdentityKey() {
    return this.identityKey;
  }
  async getLocalRegistrationId() {
    return this.registrationId;
  }
  async isTrustedIdentity(address, publicKey) {
    return this.#identities.get(key(address))?.equals(publicKey) ?? true;
  }
  async saveIdentity(address, publicKey) {
    const previous = this.#identities.get(key(address));
    this.#identities.set(key(address), publicKey);
    return previous && !previous.equals(publicKey)
      ? SignalClient.IdentityChange.ReplacedExisting
      : SignalClient.IdentityChange.NewOrUnchanged;
  }
  async getIdentity(address) {
    return this.#identities.get(key(address)) ?? null;
  }
}

class PreKeyStore extends SignalClient.PreKeyStore {
  #records = new Map();
  async savePreKey(id, record) {
    this.#records.set(id, record.serialize());
  }
  async getPreKey(id) {
    return SignalClient.PreKeyRecord.deserialize(this.#records.get(id));
  }
  async removePreKey(id) {
    this.#records.delete(id);
  }
}

class SignedPreKeyStore extends SignalClient.SignedPreKeyStore {
  #records = new Map();
  async saveSignedPreKey(id, record) {
    this.#records.set(id, record.serialize());
  }
  async getSignedPreKey(id) {
    return SignalClient.SignedPreKeyRecord.deserialize(this.#records.get(id));
  }
}

class KyberPreKeyStore extends SignalClient.KyberPreKeyStore {
  #records = new Map();
  used = new Set();
  async saveKyberPreKey(id, record) {
    this.#records.set(id, record.serialize());
  }
  async getKyberPreKey(id) {
    return SignalClient.KyberPreKeyRecord.deserialize(this.#records.get(id));
  }
  async markKyberPreKeyUsed(id) {
    this.used.add(id);
  }
  async hasKyberPreKeyBeenUsed(id) {
    return this.used.has(id);
  }
}

function makeUser(serviceId, deviceId, registrationId) {
  return {
    address: SignalClient.ProtocolAddress.new(serviceId, deviceId),
    serviceId,
    deviceId,
    identity: new IdentityStore(registrationId),
    session: new SessionStore(),
    preKeys: new PreKeyStore(),
    signedPreKeys: new SignedPreKeyStore(),
    kyberPreKeys: new KyberPreKeyStore(),
  };
}

// Bob's published bundle, with a one-time EC pre-key and a Kyber pre-key.
async function publishBundle(user) {
  const identityKey = user.identity.identityKey;
  const preKey = SignalClient.PrivateKey.generate();
  const signedPreKey = SignalClient.PrivateKey.generate();
  const signedPreKeySignature = identityKey.sign(signedPreKey.getPublicKey().serialize());
  const kyberKeyPair = SignalClient.KEMKeyPair.generate();
  const kyberSignature = identityKey.sign(kyberKeyPair.getPublicKey().serialize());
  const [preKeyId, signedPreKeyId, kyberPreKeyId] = [101, 202, 303];

  await user.preKeys.savePreKey(preKeyId, SignalClient.PreKeyRecord.new(preKeyId, preKey.getPublicKey(), preKey));
  await user.signedPreKeys.saveSignedPreKey(
    signedPreKeyId,
    SignalClient.SignedPreKeyRecord.new(signedPreKeyId, Date.now(), signedPreKey.getPublicKey(), signedPreKey, signedPreKeySignature)
  );
  await user.kyberPreKeys.saveKyberPreKey(
    kyberPreKeyId,
    SignalClient.KyberPreKeyRecord.new(kyberPreKeyId, Date.now(), kyberKeyPair, kyberSignature)
  );
  return SignalClient.PreKeyBundle.new(
    await user.identity.getLocalRegistrationId(),
    user.deviceId,
    preKeyId,
    preKey.getPublicKey(),
    signedPreKeyId,
    signedPreKey.getPublicKey(),
    signedPreKeySignature,
    identityKey.getPublicKey(),
    kyberPreKeyId,
    kyberKeyPair.getPublicKey(),
    kyberSignature
  );
}

function assertBytes(actual, expected, what) {
  if (decoder.decode(actual) !== decoder.decode(expected)) throw new Error(`${what}: plaintext mismatch`);
}

async function checkSession(alice, bob, log) {
  const started = performance.now();
  const bundle = await publishBundle(bob);
  await SignalClient.processPreKeyBundle(bundle, bob.address, alice.address, alice.session, alice.identity);

  const hello = encoder.encode('hello from alice');
  const first = await SignalClient.signalEncrypt(hello, bob.address, alice.address, alice.session, alice.identity);
  if (first.type() !== SignalClient.CiphertextMessageType.PreKey) throw new Error('first message is not a PreKey message');
  const received = await SignalClient.signalDecryptPreKey(
    SignalClient.PreKeySignalMessage.deserialize(first.serialize()),
    alice.address,
    bob.address,
    bob.session,
    bob.identity,
    bob.preKeys,
    bob.signedPreKeys,
    bob.kyberPreKeys
  );
  assertBytes(received, hello, 'PreKey message');
  if (!bob.kyberPreKeys.used.has(303)) throw new Error('Kyber pre-key was not used (no PQXDH)');

  for (let i = 0; i < 3; i++) {
    const reply = encoder.encode(`reply ${i} from bob`);
    const sent = await SignalClient.signalEncrypt(reply, alice.address, bob.address, bob.session, bob.identity);
    if (sent.type() !== SignalClient.CiphertextMessageType.Whisper) throw new Error('reply is not a Whisper message');
    const got = await SignalClient.signalDecrypt(
      SignalClient.SignalMessage.deserialize(sent.serialize()),
      bob.address,
      alice.address,
      alice.session,
      alice.identity
    );
    assertBytes(got, reply, `reply ${i}`);
    const back = encoder.encode(`message ${i} from alice`);
    const sentBack = await SignalClient.signalEncrypt(back, bob.address, alice.address, alice.session, alice.identity);
    assertBytes(
      await SignalClient.signalDecrypt(
        SignalClient.SignalMessage.deserialize(sentBack.serialize()),
        alice.address,
        bob.address,
        bob.session,
        bob.identity
      ),
      back,
      `message ${i}`
    );
  }
  const record = await bob.session.getSession(alice.address);
  if (!record?.hasCurrentState()) throw new Error('no session state stored');
  log(`ok   PQXDH session (Kyber pre-key) + 7 messages both ways via async JS stores (${Math.round(performance.now() - started)} ms)`);
}

async function checkSealedSender(alice, bob, log) {
  const started = performance.now();
  const trustRoot = SignalClient.PrivateKey.generate();
  const serverKey = SignalClient.PrivateKey.generate();
  const serverCertificate = SignalClient.ServerCertificate.new(1, serverKey.getPublicKey(), trustRoot);
  const expires = Date.now() + 3600_000;
  const senderCertificate = SignalClient.SenderCertificate.new(
    alice.serviceId,
    null,
    alice.deviceId,
    alice.identity.identityKey.getPublicKey(),
    expires,
    serverCertificate,
    serverKey
  );

  const plaintext = encoder.encode('sealed hello');
  const ciphertext = await SignalClient.sealedSenderEncryptMessage(
    plaintext,
    bob.address,
    senderCertificate,
    alice.session,
    alice.identity
  );
  const decrypted = await SignalClient.sealedSenderDecryptMessage(
    ciphertext,
    trustRoot.getPublicKey(),
    Date.now(),
    null,
    bob.serviceId,
    bob.deviceId,
    bob.session,
    bob.identity,
    bob.preKeys,
    bob.signedPreKeys,
    bob.kyberPreKeys
  );
  assertBytes(decrypted.message(), plaintext, 'sealed sender');
  if (decrypted.senderUuid() !== alice.serviceId || decrypted.deviceId() !== alice.deviceId) {
    throw new Error('sealed sender: wrong sender');
  }
  log(`ok   sealed sender v1 round trip, sender certificate validated (${Math.round(performance.now() - started)} ms)`);
}

function checkZkGroup(alice, log) {
  const started = performance.now();
  const serverSecretParams = ServerSecretParams.generate();
  serverSecretParams.getPublicParams();
  const groupSecretParams = GroupSecretParams.generate();
  const cipher = new ClientZkGroupCipher(groupSecretParams);
  const aci = SignalClient.Aci.fromUuid(alice.serviceId);
  const ciphertext = cipher.encryptServiceId(aci);
  if (!cipher.decryptServiceId(ciphertext).isEqual(aci)) throw new Error('zkgroup: service ID mismatch');
  const blob = encoder.encode('group title');
  assertBytes(cipher.decryptBlob(cipher.encryptBlob(blob)), blob, 'zkgroup blob');
  log(`ok   zkgroup: server params, group service ID + blob encryption (${Math.round(performance.now() - started)} ms)`);
}

export async function runChecks(log) {
  const alice = makeUser('9d0652a3-dcc3-4d11-975f-74d61598733f', 1, 1111);
  const bob = makeUser('796abedb-ca4e-4f18-8803-1fde5b921f9f', 2, 2222);
  await checkSession(alice, bob, log);
  await checkSealedSender(alice, bob, log);
  checkZkGroup(alice, log);
}
