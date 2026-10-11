// SPDX-License-Identifier: AGPL-3.0-only
//
// The connection objects WebNet hands to Desktop: libsignal's
// UnauthenticatedChatConnection, AuthenticatedChatConnection and
// ProvisioningConnection (node/ts/net/Chat.ts and the services in
// node/ts/net/chat/), with the typed calls Desktop uses.
//
// The typed calls are the REST-over-WebSocket requests of libsignal-net-chat's
// WebSocket implementation (rust/net/chat/src/ws/): same paths, headers,
// bodies, and response and error mapping. libsignal sends a few calls only
// over gRPC (devices, username reservation and links); for those we use
// the chat server's REST endpoints for the same operations, as Desktop
// called them before it moved to libsignal (getDevices, setDeviceName,
// reserveUsername, replaceUsernameLink, deleteUsername in WebAPI's history).

import { Buffer } from 'node:buffer';

import { Aci, CiphertextMessageType, ServiceId, usernames } from '@signalapp/libsignal-client';
import type { Client as KeyTransparencyClient } from '@signalapp/libsignal-client/dist/net/KeyTransparency.js';
import { MultiRecipientMessageResponse } from '@signalapp/libsignal-client/dist/net.js';
import type {
  ChatRequest,
  LinkedDevice,
  RequestOptions,
  SendMessageRequest,
  SendSealedMessageRequest,
  SendSyncMessageRequest,
  MultiRecipientMessageRequest,
  UploadForm,
} from '@signalapp/libsignal-client/dist/net.js';
import { GroupSendFullToken } from '@signalapp/libsignal-client/zkgroup.js';

import type { ChatResponse, ChatSocket, WebConnectionInfo } from './chat.ts';
import { DEFAULT_CHAT_REQUEST_TIMEOUT_MILLIS } from './chat.ts';
import {
  ErrorCode,
  ioError,
  libsignalError,
  LibSignalErrorBase,
  mismatchedDevices,
  notAvailable,
  rateLimited,
  retryAfterSeconds,
} from './errors.ts';
import { createLogger } from '../../ts/logging/log.std.ts';

const log = createLogger('chat-api');

type Headers = Array<[string, string]>;

const CONTENT_TYPE_JSON: [string, string] = ['content-type', 'application/json'];
const MULTI_RECIPIENT_CONTENT_TYPE = 'application/vnd.signal-messenger.mrm';
const ACCESS_KEY_LEN = 16;

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

function headerValue(response: ChatResponse, name: string): string | undefined {
  return response.headers.find(([key]) => key === name)?.[1];
}

/** parse_json_from_body: exactly application/json, a body, valid JSON. */
function parseJson<T>(response: ChatResponse, operation: string): T {
  const contentType = headerValue(response, 'content-type');
  if (contentType !== 'application/json') {
    throw ioError(`unexpected content-type ${contentType ?? '(none)'}`, operation);
  }
  if (!response.body) throw ioError('response had no body', operation);
  try {
    return JSON.parse(new TextDecoder().decode(response.body)) as T;
  } catch {
    throw ioError('response had invalid JSON', operation);
  }
}

/** An empty success response (TryIntoResponse<Empty>). */
function expectEmptySuccess(response: ChatResponse, operation: string): void {
  if (headerValue(response, 'content-type') !== undefined || response.body) {
    throw ioError('response had unexpected data', operation);
  }
}

function warnIfBody(response: ChatResponse, label: string): void {
  if (response.body && response.body.length > 0) {
    log.warn(`ignoring body for ${response.status} result from ${label}`);
  }
}

/** ResponseError::into_request_error for a status nothing else handled. */
function requestError(
  response: ChatResponse,
  operation: string,
  allowChallenge: boolean
): LibSignalErrorBase {
  const { status } = response;
  if (status >= 500 && status < 600) return ioError('server-side error, retryable with backoff', operation);
  if (status === 429) {
    const retryAfter = retryAfterSeconds(response.headers);
    if (retryAfter !== undefined) return rateLimited(retryAfter, operation);
  }
  if (status === 428 && allowChallenge) {
    try {
      const { token, options } = parseJson<{ token: unknown; options: unknown }>(response, operation);
      if (typeof token === 'string' && Array.isArray(options) && options.every(o => o === 'pushChallenge' || o === 'captcha')) {
        return libsignalError('RateLimitChallengeError', 'rate limit challenge', operation, {
          token,
          options: new Set(options),
          retryAfterSecs: retryAfterSeconds(response.headers) ?? null,
        });
      }
    } catch {
      // fall through: not a well-formed challenge
    }
  }
  if (status === 422) return ioError('the request did not pass server validation', operation);
  return ioError(`unexpected response status ${status}`, operation);
}

type MismatchedDevicesJson = {
  missingDevices?: Array<number>;
  extraDevices?: Array<number>;
  staleDevices?: Array<number>;
};

function deviceList(input: unknown, label: string, operation: string): Array<number> {
  if (input === undefined) return [];
  if (!Array.isArray(input) || !input.every(id => Number.isInteger(id) && id >= 1 && id <= 127)) {
    throw ioError(`invalid device ID in ${label} array`, operation);
  }
  return input;
}

function mismatchedEntry(account: ServiceId, devices: MismatchedDevicesJson, operation: string) {
  const entry = {
    account,
    missingDevices: deviceList(devices.missingDevices, 'missingDevices', operation),
    extraDevices: deviceList(devices.extraDevices, 'extraDevices', operation),
    staleDevices: deviceList(devices.staleDevices, 'staleDevices', operation),
  };
  if (!entry.missingDevices.length && !entry.extraDevices.length && !entry.staleDevices.length) {
    throw ioError('no devices listed in mismatched device response', operation);
  }
  return entry;
}

function singleMismatched(destination: ServiceId, response: ChatResponse, operation: string): LibSignalErrorBase {
  try {
    const parsed = parseJson<MismatchedDevicesJson>(response, operation);
    return mismatchedDevices([mismatchedEntry(destination, parsed, operation)], operation);
  } catch (error) {
    return error instanceof LibSignalErrorBase ? error : ioError(String(error), operation);
  }
}

/** EnvelopeType for an unsealed message (ws/messages.rs). */
function envelopeType(message: { type(): number }, operation: string): number {
  switch (message.type()) {
    case CiphertextMessageType.Whisper:
      return 1; // DoubleRatchet
    case CiphertextMessageType.PreKey:
      return 3;
    case CiphertextMessageType.Plaintext:
      return 8; // PlaintextContent
    default:
      throw new TypeError(`${operation}: this message type cannot be sent unsealed`);
  }
}

function jsonBody(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(value)) as Uint8Array<ArrayBuffer>;
}

/** A typed REST-over-WebSocket request (no timeout, like libsignal's typed APIs). */
type Send = (
  operation: string,
  request: { verb: string; path: string; headers?: Headers; body?: Uint8Array<ArrayBuffer> },
  options?: RequestOptions
) => Promise<ChatResponse>;

class BaseChatConnection {
  constructor(
    protected readonly socket: ChatSocket,
    protected readonly info: WebConnectionInfo,
    protected readonly kind: 'Unauthenticated' | 'Authenticated'
  ) {}

  fetch(chatRequest: ChatRequest, options?: RequestOptions): Promise<ChatResponse> {
    return this.socket.fetch(
      chatRequest,
      chatRequest.timeoutMillis ?? DEFAULT_CHAT_REQUEST_TIMEOUT_MILLIS,
      `${this.kind}ChatConnection_send`,
      options?.abortSignal
    );
  }

  disconnect(): Promise<void> {
    return this.socket.disconnect();
  }

  connectionInfo(): WebConnectionInfo {
    return this.info;
  }

  protected send: Send = (operation, { verb, path, headers = [], body }, options) =>
    this.socket.fetch({ verb, path, headers, body }, undefined, operation, options?.abortSignal);
}

export class WebUnauthenticatedChatConnection extends BaseChatConnection {
  constructor(socket: ChatSocket, info: WebConnectionInfo) {
    super(socket, info, 'Unauthenticated');
  }

  async lookUpUsernameHash({ hash }: { hash: Uint8Array<ArrayBuffer> }, options?: RequestOptions): Promise<Aci | null> {
    const operation = 'UnauthenticatedChatConnection_look_up_username_hash';
    const response = await this.send(
      operation,
      { verb: 'GET', path: `/v1/accounts/username_hash/${toBase64Url(hash)}` },
      options
    );
    if (response.status === 404) {
      warnIfBody(response, '/v1/accounts/username_hash/*');
      return null;
    }
    if (!isSuccess(response.status)) throw requestError(response, operation, false);
    const { uuid } = parseJson<{ uuid?: unknown }>(response, operation);
    if (typeof uuid !== 'string') throw ioError('response had unexpected data', operation);
    try {
      return Aci.parseFromServiceIdString(uuid);
    } catch {
      throw ioError('could not parse UUID', operation);
    }
  }

  async lookUpUsernameLink(
    { uuid, entropy }: { uuid: string; entropy: Uint8Array<ArrayBuffer> },
    options?: RequestOptions
  ): Promise<{ username: string; hash: Uint8Array<ArrayBuffer> } | null> {
    const operation = 'UnauthenticatedChatConnection_look_up_username_link';
    if (entropy.length !== 32) {
      throw libsignalError('InvalidEntropyDataLength', 'invalid entropy data length', operation);
    }
    const response = await this.send(operation, { verb: 'GET', path: `/v1/accounts/username_link/${uuid}` }, options);
    if (response.status === 404) {
      warnIfBody(response, '/v1/accounts/username_link/*');
      return null;
    }
    if (!isSuccess(response.status)) throw requestError(response, operation, false);
    const { usernameLinkEncryptedValue } = parseJson<{ usernameLinkEncryptedValue?: unknown }>(response, operation);
    if (typeof usernameLinkEncryptedValue !== 'string') throw ioError('response had unexpected data', operation);
    const username = usernames.decryptUsernameLink({
      entropy,
      encryptedUsername: fromBase64(usernameLinkEncryptedValue),
    });
    let hash: Uint8Array<ArrayBuffer>;
    try {
      hash = usernames.hash(username);
    } catch {
      log.warn('username link decrypted to an invalid username');
      throw libsignalError('InvalidUsernameLinkEncryptedData', 'invalid username link encrypted data', operation);
    }
    return { username, hash };
  }

  async accountExists({ account }: { account: ServiceId }, options?: RequestOptions): Promise<boolean> {
    const operation = 'UnauthenticatedChatConnection_account_exists';
    const response = await this.send(
      operation,
      { verb: 'HEAD', path: `/v1/accounts/account/${account.getServiceIdString()}` },
      options
    );
    warnIfBody(response, 'HEAD /v1/accounts/account/*');
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    throw requestError(response, operation, false);
  }

  async sendMultiRecipientMessage(
    { payload, timestamp, auth, onlineOnly, urgent }: MultiRecipientMessageRequest,
    options?: RequestOptions
  ): Promise<MultiRecipientMessageResponse> {
    const operation = 'UnauthenticatedChatConnection_send_multi_recipient_message';
    const story = auth === 'story';
    const headers: Headers = [['content-type', MULTI_RECIPIENT_CONTENT_TYPE]];
    if (!story) headers.push(['group-send-token', toBase64((auth as GroupSendFullToken).serialize())]);
    const response = await this.send(
      operation,
      {
        verb: 'PUT',
        path: `/v1/messages/multi_recipient?ts=${timestamp}&online=${onlineOnly}&urgent=${urgent}${story ? '&story=true' : ''}`,
        headers,
        body: payload,
      },
      options
    );
    if (!isSuccess(response.status)) {
      if (response.status === 401) {
        warnIfBody(response, '/v1/messages/multi_recipient');
        throw libsignalError('RequestUnauthorized', 'the request was unauthorized', operation);
      }
      if (response.status === 409 || response.status === 410) {
        let entries;
        try {
          const parsed = parseJson<Array<{ uuid: string; devices: MismatchedDevicesJson }>>(response, operation);
          entries = parsed.map(({ uuid, devices }) => {
            let account: ServiceId;
            try {
              account = ServiceId.parseFromServiceIdString(uuid);
            } catch {
              throw ioError('could not parse ServiceId in mismatched device response', operation);
            }
            return mismatchedEntry(account, devices ?? {}, operation);
          });
        } catch (error) {
          throw error instanceof LibSignalErrorBase ? error : ioError(String(error), operation);
        }
        throw mismatchedDevices(entries, operation);
      }
      throw requestError(response, operation, false);
    }
    const { uuids404 = [] } = parseJson<{ uuids404?: Array<string> }>(response, operation);
    let unregistered: Array<ServiceId>;
    try {
      unregistered = uuids404.map(id => ServiceId.parseFromServiceIdString(id));
    } catch {
      throw ioError('could not parse ServiceId in uuids404', operation);
    }
    return new MultiRecipientMessageResponse(unregistered);
  }

  async sendMessage(
    { destination, timestamp, contents, auth, onlineOnly, urgent }: SendSealedMessageRequest,
    options?: RequestOptions
  ): Promise<void> {
    const operation = 'UnauthenticatedChatConnection_send_message';
    if (contents.length === 0) throw new TypeError('cannot send messages to 0 devices');
    const headers: Headers = [CONTENT_TYPE_JSON];
    let storySuffix = '';
    if (auth === 'story') {
      storySuffix = '?story=true';
    } else if (auth === 'unrestricted') {
      headers.push(['unidentified-access-key', toBase64(new Uint8Array(ACCESS_KEY_LEN))]);
    } else if (auth instanceof GroupSendFullToken) {
      headers.push(['group-send-token', toBase64(auth.serialize())]);
    } else {
      if (auth.accessKey.length !== ACCESS_KEY_LEN) throw new TypeError('access key must be 16 bytes');
      headers.push(['unidentified-access-key', toBase64(auth.accessKey)]);
    }
    const response = await this.send(
      operation,
      {
        verb: 'PUT',
        path: `/v1/messages/${destination.getServiceIdString()}${storySuffix}`,
        headers,
        body: jsonBody({
          messages: contents.map(message => ({
            type: 6, // UnidentifiedSender
            destinationDeviceId: message.deviceId,
            destinationRegistrationId: message.registrationId,
            content: toBase64(message.contents),
          })),
          online: onlineOnly,
          urgent,
          timestamp,
        }),
      },
      options
    );
    if (isSuccess(response.status)) {
      parseJson(response, operation);
      return;
    }
    switch (response.status) {
      case 401:
        warnIfBody(response, '/v1/messages/*');
        throw libsignalError('RequestUnauthorized', 'the request was unauthorized', operation);
      case 404:
        warnIfBody(response, '/v1/messages/*');
        throw libsignalError('ServiceIdNotFound', 'the service ID was not found', operation);
      case 409:
      case 410:
        throw singleMismatched(destination, response, operation);
      default:
        throw requestError(response, operation, false);
    }
  }

  keyTransparencyClient(): KeyTransparencyClient {
    const fail = (operation: string) => () =>
      Promise.reject(notAvailable('key transparency', operation, 'KeyTransparencyError'));
    return {
      search: fail('KeyTransparency_Search'),
      monitor: fail('KeyTransparency_Monitor'),
      check: fail('KeyTransparency_Check'),
    } as unknown as KeyTransparencyClient;
  }

  // Backups (message and media backups, link-and-sync transfer) are not
  // part of the web build yet.
  #backups = (operation: string) => () => Promise.reject(notAvailable('Signal backups', operation));
  getUploadForm = this.#backups('UnauthenticatedChatConnection_backup_get_upload_form');
  getMediaUploadForm = this.#backups('UnauthenticatedChatConnection_backup_get_media_upload_form');
  getMessageBackupInfo = this.#backups('UnauthenticatedChatConnection_backup_get_message_backup_info');
  getMediaBackupInfo = this.#backups('UnauthenticatedChatConnection_backup_get_media_backup_info');
  getBackupCdnCredentials = this.#backups('UnauthenticatedChatConnection_backup_get_cdn_credentials');
  refreshBackup = this.#backups('UnauthenticatedChatConnection_backup_refresh');
  setBackupPublicKey = this.#backups('UnauthenticatedChatConnection_backup_set_public_key');
  listBackupMedia = this.#backups('UnauthenticatedChatConnection_backup_list_media');
  copyBackupMedia(): AsyncIterable<never> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(notAvailable('Signal backups', 'UnauthenticatedChatConnection_backup_copy_media')),
      }),
    };
  }
}

export class WebAuthenticatedChatConnection extends BaseChatConnection {
  constructor(
    socket: ChatSocket,
    info: WebConnectionInfo,
    private readonly selfAci: Aci
  ) {
    super(socket, info, 'Authenticated');
  }

  async getUploadForm({ uploadSize }: { uploadSize: bigint }, options?: RequestOptions): Promise<UploadForm> {
    const operation = 'AuthenticatedChatConnection_get_upload_form';
    const response = await this.send(
      operation,
      { verb: 'GET', path: `/v4/attachments/form/upload?uploadLength=${uploadSize}` },
      options
    );
    if (!isSuccess(response.status)) {
      if (response.status === 413) {
        warnIfBody(response, '/v4/attachments/form/upload');
        throw libsignalError('UploadTooLarge', 'upload too large', operation);
      }
      throw requestError(response, operation, true);
    }
    const form = parseJson<{ cdn?: unknown; key?: unknown; headers?: unknown; signedUploadLocation?: unknown }>(
      response,
      operation
    );
    const { cdn, key, headers, signedUploadLocation } = form;
    if (
      typeof cdn !== 'number' ||
      typeof key !== 'string' ||
      typeof signedUploadLocation !== 'string' ||
      typeof headers !== 'object' ||
      headers === null ||
      !Object.values(headers).every(value => typeof value === 'string')
    ) {
      throw ioError('response had unexpected data', operation);
    }
    let signedUploadUrl: URL;
    try {
      signedUploadUrl = new URL(signedUploadLocation);
    } catch (e) {
      throw libsignalError(undefined, `Invalid URL for getUploadForm: ${e}`, 'getUploadForm');
    }
    return { cdn, key, headers: new Map(Object.entries(headers as Record<string, string>)), signedUploadUrl };
  }

  async sendMessage(
    { destination, timestamp, contents, onlineOnly, urgent }: SendMessageRequest,
    options?: RequestOptions
  ): Promise<void> {
    return this.#sendUnsealed('AuthenticatedChatConnection_send_message', destination, timestamp, contents, onlineOnly, urgent, options);
  }

  async sendSyncMessage({ timestamp, contents, urgent }: SendSyncMessageRequest, options?: RequestOptions): Promise<void> {
    const operation = 'AuthenticatedChatConnection_send_sync_message';
    try {
      await this.#sendUnsealed(operation, this.selfAci, timestamp, contents, false, urgent, options);
    } catch (error) {
      if (error instanceof LibSignalErrorBase && error.is(ErrorCode.ServiceIdNotFound)) {
        throw ioError('ServiceIdNotFound for sync message', operation);
      }
      throw error;
    }
  }

  async #sendUnsealed(
    operation: string,
    destination: ServiceId,
    timestamp: number,
    contents: SendMessageRequest['contents'],
    onlineOnly: boolean,
    urgent: boolean,
    options?: RequestOptions
  ): Promise<void> {
    const response = await this.send(
      operation,
      {
        verb: 'PUT',
        path: `/v1/messages/${destination.getServiceIdString()}`,
        headers: [CONTENT_TYPE_JSON],
        body: jsonBody({
          messages: contents.map(message => ({
            type: envelopeType(message.contents, operation),
            destinationDeviceId: message.deviceId,
            destinationRegistrationId: message.registrationId,
            content: toBase64(message.contents.serialize()),
          })),
          online: onlineOnly,
          urgent,
          timestamp,
        }),
      },
      options
    );
    if (isSuccess(response.status)) {
      parseJson(response, operation);
      return;
    }
    switch (response.status) {
      case 404:
        warnIfBody(response, '/v1/messages/*');
        throw libsignalError('ServiceIdNotFound', 'the service ID was not found', operation);
      case 409:
      case 410:
        throw singleMismatched(destination, response, operation);
      default:
        throw requestError(response, operation, true);
    }
  }

  async getDevices(options?: RequestOptions): Promise<Array<LinkedDevice>> {
    const operation = 'AuthenticatedChatConnection_get_devices';
    const response = await this.send(operation, { verb: 'GET', path: '/v1/devices' }, options);
    if (!isSuccess(response.status)) throw requestError(response, operation, false);
    const { devices } = parseJson<{ devices?: unknown }>(response, operation);
    if (!Array.isArray(devices)) throw ioError('response had unexpected data', operation);
    return devices.map(device => {
      const { id, name, lastSeen, registrationId, createdAtCiphertext } = device as Record<string, unknown>;
      if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 127) {
        throw ioError('Invalid device ID', operation);
      }
      if (typeof registrationId !== 'number' || !Number.isInteger(registrationId) || registrationId < 0 || registrationId > 0xffff) {
        throw ioError('Invalid registration ID', operation);
      }
      return {
        id,
        encryptedName: typeof name === 'string' ? fromBase64(name) : new Uint8Array(0),
        lastSeen: typeof lastSeen === 'number' ? lastSeen : 0,
        registrationId,
        createdAtCiphertext: typeof createdAtCiphertext === 'string' ? fromBase64(createdAtCiphertext) : new Uint8Array(0),
      };
    });
  }

  async setDeviceName(
    { deviceId, encryptedName }: { deviceId: number; encryptedName: Uint8Array<ArrayBuffer> },
    options?: RequestOptions
  ): Promise<void> {
    const operation = 'AuthenticatedChatConnection_set_device_name';
    const response = await this.send(
      operation,
      {
        verb: 'PUT',
        path: `/v1/accounts/name?deviceId=${deviceId}`,
        headers: [CONTENT_TYPE_JSON],
        body: jsonBody({ deviceName: toBase64(encryptedName) }),
      },
      options
    );
    if (isSuccess(response.status)) return;
    if (response.status === 404) throw libsignalError('DeviceIdNotFound', 'device ID not found in account', operation);
    throw requestError(response, operation, false);
  }

  async reserveUsernameHash(
    { usernameHashes }: { usernameHashes: Array<Uint8Array<ArrayBuffer>> },
    options?: RequestOptions
  ): Promise<Uint8Array<ArrayBuffer>> {
    const operation = 'AuthenticatedChatConnection_reserve_username_hash';
    const response = await this.send(
      operation,
      {
        verb: 'PUT',
        path: '/v1/accounts/username_hash/reserve',
        headers: [CONTENT_TYPE_JSON],
        body: jsonBody({ usernameHashes: usernameHashes.map(toBase64Url) }),
      },
      options
    );
    if (!isSuccess(response.status)) {
      if (response.status === 409) throw libsignalError('UsernameNotAvailable', 'username not available', operation);
      throw requestError(response, operation, false);
    }
    const { usernameHash } = parseJson<{ usernameHash?: unknown }>(response, operation);
    if (typeof usernameHash !== 'string') throw ioError('response had unexpected data', operation);
    return fromBase64(usernameHash);
  }

  async setUsernameLink(
    { usernameCiphertext, keepLinkHandle }: { usernameCiphertext: Uint8Array<ArrayBuffer>; keepLinkHandle: boolean },
    options?: RequestOptions
  ): Promise<string> {
    const operation = 'AuthenticatedChatConnection_set_username_link';
    const response = await this.send(
      operation,
      {
        verb: 'PUT',
        path: '/v1/accounts/username_link',
        headers: [CONTENT_TYPE_JSON],
        body: jsonBody({ usernameLinkEncryptedValue: toBase64Url(usernameCiphertext), keepLinkHandle }),
      },
      options
    );
    if (!isSuccess(response.status)) {
      if (response.status === 409) throw libsignalError('UsernameNotSet', 'username not set', operation);
      throw requestError(response, operation, false);
    }
    const { usernameLinkHandle } = parseJson<{ usernameLinkHandle?: unknown }>(response, operation);
    if (typeof usernameLinkHandle !== 'string') throw ioError('response had unexpected data', operation);
    return usernameLinkHandle;
  }

  async deleteUsernameHash(options?: RequestOptions): Promise<void> {
    const operation = 'AuthenticatedChatConnection_delete_username_hash';
    const response = await this.send(operation, { verb: 'DELETE', path: '/v1/accounts/username_hash' }, options);
    if (!isSuccess(response.status)) throw requestError(response, operation, false);
    if (response.body?.length) expectEmptySuccess(response, operation);
  }
}

export class WebProvisioningConnection {
  constructor(
    private readonly socket: ChatSocket,
    private readonly info: WebConnectionInfo
  ) {}

  disconnect(): Promise<void> {
    return this.socket.disconnect();
  }

  connectionInfo(): WebConnectionInfo {
    return this.info;
  }
}
