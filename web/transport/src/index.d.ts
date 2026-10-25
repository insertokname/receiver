// SPDX-License-Identifier: AGPL-3.0-only
//
// Types for index.js (the connection policy over webtor-rs).

import type { TorClient } from './pkg/webtor_wasm.js';

export { SignalHttps, SignalHttpsBody, SignalSocket, TorClient, verifyTorDirectory } from './pkg/webtor_wasm.js';

export declare const SIGNAL_CA_PEM: string;
export declare const DEFAULT_USER_AGENT: string;

export type Transport = Readonly<{
  name: string;
  label: string;
  bridgeUrl?: string;
  webrtc?: boolean;
  budgetMs: number;
}>;
export declare const TRANSPORTS: ReadonlyArray<Transport>;

export type WasmSource = Readonly<{ wasmUrl: string; integrity?: string }>;

export type TorEvent =
  | { type: 'attempt'; transport: Transport; round: number }
  | { type: 'failed'; transport: Transport; round: number; reason: string; seconds: number }
  | { type: 'connected'; transport: Transport; round: number; seconds: number }
  | { type: 'backoff'; round: number; delayMs: number };

export declare function onTransportLog(
  listener: (level: string, target: string, message: string) => void
): () => boolean;
export declare function loadTransport(wasm?: WasmSource): Promise<void>;
export declare function errorReason(error: unknown): string;
export declare function withDeadline<T>(promise: Promise<T>, ms: number, message?: string): Promise<T>;
export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
export declare function backoffDelay(round: number): number;
export declare function connectTor(options?: {
  transports?: ReadonlyArray<Transport>;
  directoryUrl?: string;
  rounds?: number;
  onEvent?: (event: TorEvent) => void;
  signal?: AbortSignal;
  wasm?: WasmSource;
  congestionControl?: boolean;
}): Promise<{ client: TorClient; transport: Transport }>;

export type HeaderPairs = Array<[string, string]>;
export type CloseInfo = { code: number; reason: string };

export declare class SignalConnection {
  readonly headers: HeaderPairs;
  closed: CloseInfo | null;
  send(bytes: Uint8Array): Promise<void>;
  ping(): Promise<void>;
  next(): Promise<Uint8Array | true | CloseInfo>;
  recv(): Promise<Uint8Array | null>;
  close(code?: number, reason?: string): Promise<void>;
  abort(): void;
}

export declare function openSignalSocket(
  client: TorClient,
  url: string,
  options?: {
    authorization?: string | null;
    headers?: HeaderPairs;
    userAgent?: string;
    rootPem?: string;
    timeoutMs?: number;
  }
): Promise<SignalConnection>;

/** A response body read piece by piece (`undefined` at the end). */
export type RangedBody = {
  next(idleMs?: number): Promise<Uint8Array | undefined>;
  cancel(): void;
  done?(): void;
};
export type RangedResponse = { status: number; headers: HeaderPairs; body: RangedBody };

export declare const FIRST_CHUNK: number;
export declare const CHUNK: number;
export declare function requestedRange(headers: HeaderPairs): { start: number; end?: number } | null | undefined;
export declare function contentRange(value: string | undefined): { first: number; last: number; total?: number } | undefined;
/** A large GET in parallel byte ranges over several lanes, one in-order body (ranged.js). */
export declare function fetchRanged(
  send: ((headers: HeaderPairs, lane: number) => Promise<RangedResponse>) | import('./pkg/webtor_wasm.js').SignalHttps,
  options?: {
    url?: string;
    rootPem?: string;
    timeoutMs?: number;
    headers?: HeaderPairs;
    lanes?: number;
    firstLane?: number;
    idleMs?: number;
    chunkBytes?: number;
    firstChunkBytes?: number;
    aheadBytes?: number;
  }
): Promise<RangedResponse & { split: boolean }>;
