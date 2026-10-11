// SPDX-License-Identifier: AGPL-3.0-only
//
// The node:crypto API Desktop's renderer uses, on audited libraries:
// @noble/hashes (SHA-1/2, MD5, HMAC), @noble/ciphers (AES-CBC/CTR/GCM,
// constant-time comparison) and the Web Crypto CSPRNG. This file is glue
// only: Node's incremental update()/final() interface over those one-shot
// primitives. No cryptographic algorithm is implemented here.
//
// Differences from Node: Hash/Hmac/Cipher objects are not streams (use
// update/digest/final), and AES-GCM returns all output from final() (Node
// returns it incrementally from update()).

import { Buffer } from 'buffer';
import { cbc, ctr, gcm } from '@noble/ciphers/aes.js';
import { equalBytes } from '@noble/ciphers/utils.js';
import { hmac } from '@noble/hashes/hmac.js';
import { md5, sha1 } from '@noble/hashes/legacy.js';
import { sha224, sha256, sha384, sha512 } from '@noble/hashes/sha2.js';

import { unavailable } from './unavailable.ts';

type BinaryLike = string | Uint8Array | ArrayBuffer | DataView;
type Encoding = 'hex' | 'base64' | 'base64url' | 'utf8' | 'utf-8' | 'latin1' | 'binary';

function toBytes(data: BinaryLike, encoding?: Encoding): Uint8Array {
  if (typeof data === 'string') {
    return Buffer.from(data, encoding ?? 'utf8');
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function output(bytes: Uint8Array, encoding?: Encoding): Buffer | string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return encoding ? buffer.toString(encoding) : buffer;
}

// Randomness

const MAX_RANDOM_CHUNK = 65536; // getRandomValues limit per call

export function randomFillSync<T extends ArrayBufferView>(view: T): T {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  for (let i = 0; i < bytes.length; i += MAX_RANDOM_CHUNK) {
    globalThis.crypto.getRandomValues(
      bytes.subarray(i, i + MAX_RANDOM_CHUNK) as Uint8Array<ArrayBuffer>
    );
  }
  return view;
}

export function randomBytes(
  size: number,
  callback?: (error: Error | null, bytes: Buffer) => void
): Buffer {
  const bytes = randomFillSync(Buffer.alloc(size));
  if (callback) {
    queueMicrotask(() => callback(null, bytes));
  }
  return bytes;
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

/** Uniform integer in [min, max) (or [0, min) with one argument). */
export function randomInt(min: number, max?: number): number {
  const [low, high] = max === undefined ? [0, min] : [min, max];
  const range = high - low;
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || range <= 0 || range > 2 ** 48) {
    throw new RangeError(`randomInt: invalid range [${low}, ${high})`);
  }
  // Rejection sampling over 48 random bits, as Node does.
  const limit = 2 ** 48 - (2 ** 48 % range);
  const bytes = new Uint8Array(6);
  for (;;) {
    randomFillSync(bytes);
    const value = bytes.reduce((acc, b) => acc * 256 + b, 0);
    if (value < limit) {
      return low + (value % range);
    }
  }
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    throw new RangeError('Input buffers must have the same byte length');
  }
  return equalBytes(a, b);
}

// Hashes and HMAC

const HASHES = {
  md5,
  sha1,
  sha224,
  sha256,
  sha384,
  sha512,
} as const;

type HashName = keyof typeof HASHES;

function getHash(algorithm: string) {
  const name = algorithm.toLowerCase().replace('-', '') as HashName;
  const hash = HASHES[name];
  if (!hash) {
    throw new Error(`crypto: digest ${algorithm} is not available in the web build`);
  }
  return hash;
}

type IncrementalHash = {
  update(data: Uint8Array): unknown;
  digest(): Uint8Array;
};

class HashBase {
  readonly #state: IncrementalHash;

  #done = false;

  constructor(state: IncrementalHash) {
    this.#state = state;
  }

  update(data: BinaryLike, encoding?: Encoding): this {
    if (this.#done) {
      throw new Error('Digest already called');
    }
    this.#state.update(toBytes(data, encoding));
    return this;
  }

  digest(): Buffer;
  digest(encoding: Encoding): string;
  digest(encoding?: Encoding): Buffer | string {
    if (this.#done) {
      throw new Error('Digest already called');
    }
    this.#done = true;
    return output(this.#state.digest(), encoding);
  }
}

export class Hash extends HashBase {}
export class Hmac extends HashBase {}

export function createHash(algorithm: string): Hash {
  return new Hash(getHash(algorithm).create());
}

export function createHmac(algorithm: string, key: BinaryLike): Hmac {
  return new Hmac(hmac.create(getHash(algorithm), toBytes(key)));
}

export function getHashes(): Array<string> {
  return Object.keys(HASHES);
}

// Ciphers

const BLOCK = 16;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) {
    return b;
  }
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Adds `blocks` to a 128-bit big-endian counter (AES-CTR counter block). */
function addToCounter(counter: Uint8Array, blocks: number): Uint8Array {
  let value = 0n;
  for (const byte of counter) {
    value = (value << 8n) | BigInt(byte);
  }
  value = (value + BigInt(blocks)) & ((1n << 128n) - 1n);
  const out = new Uint8Array(BLOCK);
  for (let i = BLOCK - 1; i >= 0; i -= 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

type Mode = 'cbc' | 'ctr' | 'gcm';

function parseAlgorithm(algorithm: string, key: Uint8Array): Mode {
  const match = /^aes-(128|192|256)-(cbc|ctr|gcm)$/.exec(algorithm.toLowerCase());
  if (!match) {
    throw new Error(`crypto: cipher ${algorithm} is not available in the web build`);
  }
  if (key.length * 8 !== Number(match[1])) {
    throw new RangeError('Invalid key length');
  }
  return match[2] as Mode;
}

class CipherBase {
  readonly #mode: Mode;
  readonly #encrypt: boolean;
  readonly #key: Uint8Array;
  #iv: Uint8Array;
  #pending = new Uint8Array(0);
  #autoPadding = true;
  #aad: Uint8Array | undefined;
  #authTag: Uint8Array | undefined;
  #finished = false;

  constructor(encrypt: boolean, algorithm: string, key: BinaryLike, iv: BinaryLike) {
    this.#encrypt = encrypt;
    this.#key = Uint8Array.from(toBytes(key));
    this.#iv = Uint8Array.from(toBytes(iv));
    this.#mode = parseAlgorithm(algorithm, this.#key);
    if (this.#mode !== 'gcm' && this.#iv.length !== BLOCK) {
      throw new RangeError('Invalid initialization vector');
    }
  }

  update(data: BinaryLike, inputEncoding?: Encoding): Buffer;
  update(data: BinaryLike, inputEncoding: Encoding | undefined, outputEncoding: Encoding): string;
  update(data: BinaryLike, inputEncoding?: Encoding, outputEncoding?: Encoding): Buffer | string {
    if (this.#finished) {
      throw new Error('Cipher already finalized');
    }
    const input = concat(this.#pending, Uint8Array.from(toBytes(data, inputEncoding)));
    let ready: number;
    if (this.#mode === 'gcm') {
      ready = 0; // authenticated as a whole in final()
    } else if (this.#mode === 'cbc' && !this.#encrypt && this.#autoPadding) {
      // Keep the last full block back: it carries the padding.
      ready = Math.max(0, Math.floor((input.length - 1) / BLOCK) * BLOCK);
    } else {
      ready = Math.floor(input.length / BLOCK) * BLOCK;
    }
    this.#pending = input.slice(ready);
    return output(this.#process(input.subarray(0, ready), false), outputEncoding);
  }

  final(): Buffer;
  final(outputEncoding: Encoding): string;
  final(outputEncoding?: Encoding): Buffer | string {
    if (this.#finished) {
      throw new Error('Cipher already finalized');
    }
    this.#finished = true;
    const rest = this.#pending;
    this.#pending = new Uint8Array(0);
    return output(this.#process(rest, true), outputEncoding);
  }

  setAutoPadding(autoPadding = true): this {
    this.#autoPadding = autoPadding;
    return this;
  }

  setAAD(aad: BinaryLike): this {
    this.#aad = Uint8Array.from(toBytes(aad));
    return this;
  }

  setAuthTag(tag: BinaryLike): this {
    if (this.#encrypt) {
      throw new Error('setAuthTag is only for decryption');
    }
    this.#authTag = Uint8Array.from(toBytes(tag));
    return this;
  }

  getAuthTag(): Buffer {
    if (!this.#encrypt || !this.#finished || !this.#authTag) {
      throw new Error('getAuthTag is only available after final() when encrypting');
    }
    return output(this.#authTag) as Buffer;
  }

  #process(data: Uint8Array, last: boolean): Uint8Array {
    const key = this.#key;
    switch (this.#mode) {
      case 'ctr': {
        if (data.length === 0) {
          return data;
        }
        const out = ctr(key, this.#iv).encrypt(data);
        this.#iv = addToCounter(this.#iv, Math.ceil(data.length / BLOCK));
        return out;
      }
      case 'cbc': {
        const padding = last && this.#autoPadding;
        if (data.length === 0 && !padding) {
          return data;
        }
        if (!padding && data.length % BLOCK !== 0) {
          throw new Error('wrong final block length');
        }
        const cipher = cbc(key, this.#iv, { disablePadding: !padding });
        const out = this.#encrypt ? cipher.encrypt(data) : cipher.decrypt(data);
        // Chain: the next IV is the last ciphertext block.
        const ciphertext = this.#encrypt ? out : data;
        if (ciphertext.length >= BLOCK) {
          this.#iv = ciphertext.slice(ciphertext.length - BLOCK);
        }
        return out;
      }
      case 'gcm': {
        if (!last) {
          return new Uint8Array(0);
        }
        const cipher = gcm(key, this.#iv, this.#aad);
        if (this.#encrypt) {
          const sealed = cipher.encrypt(data);
          this.#authTag = sealed.slice(sealed.length - BLOCK);
          return sealed.subarray(0, sealed.length - BLOCK);
        }
        if (!this.#authTag) {
          throw new Error('Unsupported state or unable to authenticate data');
        }
        try {
          return cipher.decrypt(concat(data, this.#authTag));
        } catch {
          throw new Error('Unsupported state or unable to authenticate data');
        }
      }
      default:
        throw new Error('unreachable');
    }
  }
}

export class Cipheriv extends CipherBase {
  constructor(algorithm: string, key: BinaryLike, iv: BinaryLike) {
    super(true, algorithm, key, iv);
  }
}

export class Decipheriv extends CipherBase {
  constructor(algorithm: string, key: BinaryLike, iv: BinaryLike) {
    super(false, algorithm, key, iv);
  }
}

export function createCipheriv(algorithm: string, key: BinaryLike, iv: BinaryLike): Cipheriv {
  return new Cipheriv(algorithm, key, iv);
}

export function createDecipheriv(algorithm: string, key: BinaryLike, iv: BinaryLike): Decipheriv {
  return new Decipheriv(algorithm, key, iv);
}

export const { subtle } = globalThis.crypto;
export const webcrypto = globalThis.crypto;
export const getRandomValues = <T extends ArrayBufferView>(view: T): T =>
  randomFillSync(view);

export const createSign = unavailable('crypto', 'createSign');
export const createVerify = unavailable('crypto', 'createVerify');
export const createECDH = unavailable('crypto', 'createECDH');
export const generateKeyPairSync = unavailable('crypto', 'generateKeyPairSync');
export const pbkdf2 = unavailable('crypto', 'pbkdf2');
export const pbkdf2Sync = unavailable('crypto', 'pbkdf2Sync');
export const scryptSync = unavailable('crypto', 'scryptSync');

export default {
  randomBytes,
  randomFillSync,
  randomUUID,
  randomInt,
  timingSafeEqual,
  createHash,
  createHmac,
  getHashes,
  createCipheriv,
  createDecipheriv,
  Cipheriv,
  Decipheriv,
  Hash,
  Hmac,
  subtle,
  webcrypto,
  getRandomValues,
  createSign,
  createVerify,
  createECDH,
  generateKeyPairSync,
  pbkdf2,
  pbkdf2Sync,
  scryptSync,
};
