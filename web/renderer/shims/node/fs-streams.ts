// SPDX-License-Identifier: AGPL-3.0-only
//
// fs.ReadStream and fs.WriteStream on the app's files in the origin private
// file system (web/main/files.ts), with Node's options and events (open,
// ready, close; start/end, flags, bytesRead/bytesWritten).

import { Buffer } from 'node:buffer';
import { Readable, Writable } from 'node:stream';

import { FileWriter, fileHandle, fsError, kindOf, normalizePath } from '../../../main/files.ts';

const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

export type ReadStreamOptions = {
  start?: number;
  end?: number;
  highWaterMark?: number;
  autoClose?: boolean;
  encoding?: BufferEncoding;
  signal?: AbortSignal;
  /** A file snapshot to read instead of opening `path` (FileHandle). */
  file?: File;
};

export class ReadStream extends Readable {
  readonly path: string;
  bytesRead = 0;
  pending = true;
  #file: File | undefined;
  #position: number;
  readonly #end: number;
  readonly #chunkSize: number;

  constructor(path: unknown, options: ReadStreamOptions | BufferEncoding = {}) {
    const opts = typeof options === 'string' ? { encoding: options } : options;
    super({ highWaterMark: opts.highWaterMark ?? DEFAULT_HIGH_WATER_MARK, encoding: opts.encoding, signal: opts.signal });
    this.path = normalizePath(path);
    this.#file = opts.file;
    this.#position = opts.start ?? 0;
    this.#end = opts.end ?? Infinity;
    this.#chunkSize = opts.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
  }

  override _construct(callback: (error?: Error | null) => void): void {
    const opened = this.#file ? Promise.resolve(this.#file) : fileHandle(this.path, 'open').then(h => h.getFile());
    opened.then(
      file => {
        this.#file = file;
        this.pending = false;
        callback();
        this.emit('open', 0);
        this.emit('ready');
      },
      error => callback(error)
    );
  }

  override _read(size: number): void {
    const file = this.#file as File;
    const stop = Math.min(file.size, this.#end + 1);
    if (this.#position >= stop) {
      this.push(null);
      return;
    }
    const until = Math.min(stop, this.#position + Math.max(size, this.#chunkSize));
    const from = this.#position;
    this.#position = until;
    file
      .slice(from, until)
      .arrayBuffer()
      .then(
        buffer => {
          this.bytesRead += buffer.byteLength;
          this.push(Buffer.from(buffer));
        },
        error => this.destroy(error)
      );
  }
}

export type WriteStreamOptions = {
  flags?: string;
  start?: number;
  highWaterMark?: number;
  autoClose?: boolean;
  encoding?: BufferEncoding;
  signal?: AbortSignal;
  /** Where to write instead of opening `path` (FileHandle). */
  writable?: {
    write(bytes: Uint8Array, position: number | undefined): Promise<void>;
    close(): Promise<void>;
  };
};

export class WriteStream extends Writable {
  readonly path: string;
  bytesWritten = 0;
  pending = true;
  readonly #flags: string;
  #position: number | undefined;
  #target: WriteStreamOptions['writable'];
  #closed = false;

  constructor(path: unknown, options: WriteStreamOptions | BufferEncoding = {}) {
    const opts = typeof options === 'string' ? { encoding: options } : options;
    super({ highWaterMark: opts.highWaterMark, decodeStrings: true, signal: opts.signal });
    this.path = normalizePath(path);
    this.#flags = opts.flags ?? 'w';
    this.#position = opts.start;
    this.#target = opts.writable;
  }

  override _construct(callback: (error?: Error | null) => void): void {
    if (this.#target) {
      this.pending = false;
      callback();
      this.emit('open', 0);
      this.emit('ready');
      return;
    }
    (async () => {
      const flags = this.#flags;
      if (flags.includes('x') && kindOf(this.path)) throw fsError('EEXIST', 'open', this.path);
      if (flags.startsWith('r') && !kindOf(this.path)) throw fsError('ENOENT', 'open', this.path);
      const writer = await FileWriter.open(this.path, { truncate: flags.startsWith('w') });
      this.#position = flags.startsWith('a') ? await writer.size() : (this.#position ?? 0);
      this.#target = {
        write: (bytes, position) => writer.write(bytes, position ?? 0),
        close: () => writer.close(),
      };
    })().then(
      () => {
        this.pending = false;
        callback();
        this.emit('open', 0);
        this.emit('ready');
      },
      error => callback(error)
    );
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const target = this.#target;
    if (!target) {
      callback(new Error('write stream not open'));
      return;
    }
    target.write(chunk, this.#position).then(
      () => {
        this.bytesWritten += chunk.byteLength;
        if (this.#position !== undefined) this.#position += chunk.byteLength;
        callback();
      },
      error => callback(error)
    );
  }

  #close(): Promise<void> {
    if (this.#closed || !this.#target) return Promise.resolve();
    this.#closed = true;
    return this.#target.close();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#close().then(() => callback(), error => callback(error));
  }

  // As with Node, what was written before the stream was destroyed stays in
  // the file (OPFS commits it on close).
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#close().then(
      () => callback(error),
      closeError => callback(error ?? closeError)
    );
  }

  /** Node's WriteStream.close([callback]). */
  close(callback?: (error?: Error | null) => void): void {
    if (callback) this.once('close', () => callback());
    this.end();
  }
}
