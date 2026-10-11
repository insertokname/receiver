// SPDX-License-Identifier: AGPL-3.0-only
//
// node:fs/promises for the renderer: the part Desktop uses, on the app's
// files in the origin private file system (web/main/files.ts). Paths
// outside userData fail with EACCES. Every other export throws "not
// available" (renderer/resolve.mjs, 'partial').

import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

import {
  checkScope,
  copyFileContents,
  FileWriter,
  fileHandle,
  fileInfo,
  fsError,
  kindOf,
  listDirectory,
  makeDirectory,
  movePath,
  normalizePath,
  readWholeFile,
  removePath,
  writeWholeFile,
} from '../../../main/files.ts';
import { ReadStream, WriteStream } from './fs-streams.ts';
import type { ReadStreamOptions, WriteStreamOptions } from './fs-streams.ts';

export const constants = Object.freeze({
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE_FORCE: 4,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_EXCL: 128,
  O_TRUNC: 512,
  O_APPEND: 1024,
  S_IFMT: 0o170000,
  S_IFREG: 0o100000,
  S_IFDIR: 0o40000,
});

export class Stats {
  readonly dev = 0;
  readonly ino = 0;
  readonly mode: number;
  readonly nlink = 1;
  readonly uid = 0;
  readonly gid = 0;
  readonly rdev = 0;
  readonly blksize = 4096;
  readonly blocks: number;
  readonly atimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
  readonly atime: Date;
  readonly mtime: Date;
  readonly ctime: Date;
  readonly birthtime: Date;

  constructor(
    readonly kind: 'file' | 'directory',
    readonly size: number,
    readonly mtimeMs: number
  ) {
    this.mode = kind === 'directory' ? 0o40755 : 0o100644;
    this.blocks = Math.ceil(size / 512);
    this.atimeMs = mtimeMs;
    this.ctimeMs = mtimeMs;
    this.birthtimeMs = mtimeMs;
    this.mtime = new Date(mtimeMs);
    this.atime = this.mtime;
    this.ctime = this.mtime;
    this.birthtime = this.mtime;
  }

  isFile(): boolean {
    return this.kind === 'file';
  }
  isDirectory(): boolean {
    return this.kind === 'directory';
  }
  isSymbolicLink(): boolean {
    return false;
  }
  isBlockDevice(): boolean {
    return false;
  }
  isCharacterDevice(): boolean {
    return false;
  }
  isFIFO(): boolean {
    return false;
  }
  isSocket(): boolean {
    return false;
  }
}

export class Dirent {
  constructor(
    readonly name: string,
    readonly parentPath: string,
    readonly kind: 'file' | 'directory'
  ) {}
  get path(): string {
    return this.parentPath;
  }
  isFile(): boolean {
    return this.kind === 'file';
  }
  isDirectory(): boolean {
    return this.kind === 'directory';
  }
  isSymbolicLink(): boolean {
    return false;
  }
  isBlockDevice(): boolean {
    return false;
  }
  isCharacterDevice(): boolean {
    return false;
  }
  isFIFO(): boolean {
    return false;
  }
  isSocket(): boolean {
    return false;
  }
}

type Data = string | Uint8Array | ArrayBufferView;
type Encoding = BufferEncoding | null | undefined;
type FlagOptions = { flag?: string; encoding?: Encoding } | Encoding;

function toBytes(data: Data, encoding?: Encoding): Uint8Array {
  if (typeof data === 'string') return Buffer.from(data, encoding ?? 'utf8');
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function optionsOf(options: FlagOptions): { flag?: string; encoding?: Encoding } {
  return typeof options === 'string' || options == null ? { encoding: options ?? undefined } : options;
}

export async function stat(path: unknown, _options?: unknown): Promise<Stats> {
  const { kind, size, mtimeMs } = await fileInfo(normalizePath(path), 'stat');
  return new Stats(kind, size, mtimeMs);
}

export const lstat = stat;

export async function access(path: unknown, _mode?: number): Promise<void> {
  const normalized = normalizePath(path);
  checkScope(normalized, 'access');
  if (!kindOf(normalized)) throw fsError('ENOENT', 'access', normalized);
}

export async function realpath(path: unknown, _options?: unknown): Promise<string> {
  const normalized = normalizePath(path);
  checkScope(normalized, 'realpath');
  if (!kindOf(normalized)) throw fsError('ENOENT', 'realpath', normalized);
  return normalized;
}

export async function mkdir(path: unknown, options?: { recursive?: boolean; mode?: number } | number): Promise<string | undefined> {
  const recursive = typeof options === 'object' && options !== null && Boolean(options.recursive);
  return makeDirectory(normalizePath(path), recursive);
}

export async function readdir(
  path: unknown,
  options?: { withFileTypes?: boolean; recursive?: boolean } | BufferEncoding
): Promise<Array<string> | Array<Dirent>> {
  const normalized = normalizePath(path);
  checkScope(normalized, 'scandir');
  const kind = kindOf(normalized);
  if (kind !== 'directory') throw fsError(kind ? 'ENOTDIR' : 'ENOENT', 'scandir', normalized);
  const withFileTypes = typeof options === 'object' && options?.withFileTypes;
  const recursive = typeof options === 'object' && options?.recursive;
  const result: Array<{ name: string; parent: string; kind: 'file' | 'directory' }> = [];
  const visit = (directory: string, prefix: string) => {
    for (const name of listDirectory(directory)) {
      const child = posix.join(directory, name);
      const childKind = kindOf(child) ?? 'file';
      result.push({ name: prefix + name, parent: directory, kind: childKind });
      if (recursive && childKind === 'directory') visit(child, `${prefix}${name}/`);
    }
  };
  visit(normalized, '');
  return withFileTypes
    ? result.map(e => new Dirent(posix.basename(e.name), e.parent, e.kind))
    : result.map(e => e.name);
}

export async function readFile(path: unknown, options?: FlagOptions): Promise<Buffer | string> {
  if (path instanceof FileHandle) return path.readFile(options);
  const { encoding } = optionsOf(options);
  const bytes = Buffer.from((await readWholeFile(normalizePath(path))).buffer);
  return encoding ? bytes.toString(encoding) : bytes;
}

export async function writeFile(path: unknown, data: Data, options?: FlagOptions): Promise<void> {
  if (path instanceof FileHandle) return path.writeFile(data, options);
  const { flag = 'w', encoding } = optionsOf(options);
  await writeWholeFile(normalizePath(path), toBytes(data, encoding), {
    append: flag.startsWith('a'),
    exclusive: flag.includes('x'),
  });
}

export async function appendFile(path: unknown, data: Data, options?: FlagOptions): Promise<void> {
  const { encoding } = optionsOf(options);
  await writeWholeFile(normalizePath(path), toBytes(data, encoding), { append: true });
}

export async function unlink(path: unknown): Promise<void> {
  const normalized = normalizePath(path);
  checkScope(normalized, 'unlink');
  const kind = kindOf(normalized);
  if (!kind) throw fsError('ENOENT', 'unlink', normalized);
  if (kind === 'directory') throw fsError('EISDIR', 'unlink', normalized);
  await removePath(normalized, { recursive: false, syscall: 'unlink' });
}

export async function rm(path: unknown, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
  const normalized = normalizePath(path);
  checkScope(normalized, 'rm');
  const kind = kindOf(normalized);
  if (!kind) {
    if (options?.force) return;
    throw fsError('ENOENT', 'rm', normalized);
  }
  if (kind === 'directory' && !options?.recursive) {
    throw Object.assign(fsError('EISDIR', 'rm', normalized, 'Path is a directory'), { code: 'ERR_FS_EISDIR' });
  }
  await removePath(normalized, { recursive: true, syscall: 'rm' });
}

export async function rmdir(path: unknown, options?: { recursive?: boolean }): Promise<void> {
  const normalized = normalizePath(path);
  checkScope(normalized, 'rmdir');
  const kind = kindOf(normalized);
  if (kind !== 'directory') throw fsError(kind ? 'ENOTDIR' : 'ENOENT', 'rmdir', normalized);
  await removePath(normalized, { recursive: Boolean(options?.recursive), syscall: 'rmdir' });
}

export async function rename(from: unknown, to: unknown): Promise<void> {
  await movePath(normalizePath(from), normalizePath(to));
}

export async function copyFile(from: unknown, to: unknown, mode = 0): Promise<void> {
  await copyFileContents(normalizePath(from), normalizePath(to), {
    exclusive: (mode & constants.COPYFILE_EXCL) !== 0,
  });
}

// OPFS has no permissions, owners or settable times.
async function existingNoop(path: unknown, syscall: string): Promise<void> {
  const normalized = normalizePath(path);
  checkScope(normalized, syscall);
  if (!kindOf(normalized)) throw fsError('ENOENT', syscall, normalized);
}
export const chmod = (path: unknown, _mode: unknown): Promise<void> => existingNoop(path, 'chmod');
export const lchmod = chmod;
export const chown = (path: unknown, _uid: unknown, _gid: unknown): Promise<void> => existingNoop(path, 'chown');
export const lchown = chown;
export const utimes = (path: unknown, _atime: unknown, _mtime: unknown): Promise<void> => existingNoop(path, 'utime');
export const lutimes = utimes;

/** Free space as the browser reports it for this origin. */
export async function statfs(_path: unknown): Promise<{
  type: number;
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
  files: number;
  ffree: number;
}> {
  const { quota = 0, usage = 0 } = (await navigator.storage?.estimate?.()) ?? {};
  const bsize = 4096;
  const free = Math.max(0, Math.floor((quota - usage) / bsize));
  return { type: 0, bsize, blocks: Math.floor(quota / bsize), bfree: free, bavail: free, files: 0, ffree: 0 };
}

let nextFd = 100;

/**
 * fs/promises FileHandle. Read handles read a snapshot of the file; write
 * handles write through an OPFS writable stream, committed on close().
 */
export class FileHandle {
  readonly fd = nextFd++;
  #file: File | undefined;
  #writer: FileWriter | undefined;
  #position = 0;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(
    readonly path: string,
    readonly flags: string,
    file: File | undefined,
    writer: FileWriter | undefined,
    position: number
  ) {
    this.#file = file;
    this.#writer = writer;
    this.#position = position;
  }

  #check(syscall: string): void {
    if (this.#closed) throw Object.assign(new Error(`file closed, ${syscall}`), { code: 'EBADF' });
  }

  async stat(): Promise<Stats> {
    this.#check('fstat');
    return stat(this.path);
  }

  async read(
    bufferOrOptions?: Uint8Array | { buffer?: Uint8Array; offset?: number; length?: number; position?: number | null },
    offsetArg?: number,
    lengthArg?: number,
    positionArg?: number | null
  ): Promise<{ bytesRead: number; buffer: Uint8Array }> {
    this.#check('read');
    if (!this.#file) throw Object.assign(new Error('file not open for reading'), { code: 'EBADF' });
    const options =
      bufferOrOptions instanceof Uint8Array || bufferOrOptions === undefined
        ? { buffer: bufferOrOptions, offset: offsetArg, length: lengthArg, position: positionArg }
        : bufferOrOptions;
    const buffer = options.buffer ?? Buffer.alloc(16384);
    const offset = options.offset ?? 0;
    const length = options.length ?? buffer.byteLength - offset;
    const position = options.position ?? this.#position;
    const bytes = new Uint8Array(await this.#file.slice(position, position + length).arrayBuffer());
    buffer.set(bytes, offset);
    if (options.position == null) this.#position += bytes.byteLength;
    return { bytesRead: bytes.byteLength, buffer };
  }

  async readFile(options?: FlagOptions): Promise<Buffer | string> {
    this.#check('read');
    if (!this.#file) throw Object.assign(new Error('file not open for reading'), { code: 'EBADF' });
    const { encoding } = optionsOf(options);
    const bytes = Buffer.from(await this.#file.slice(this.#position).arrayBuffer());
    this.#position = this.#file.size;
    return encoding ? bytes.toString(encoding) : bytes;
  }

  async write(
    data: Data,
    offsetOrPosition?: number | null,
    lengthOrEncoding?: number | BufferEncoding,
    positionArg?: number | null
  ): Promise<{ bytesWritten: number; buffer: Data }> {
    this.#check('write');
    const writer = this.#writer;
    if (!writer) throw Object.assign(new Error('file not open for writing'), { code: 'EBADF' });
    let bytes: Uint8Array;
    let position: number | null | undefined;
    if (typeof data === 'string') {
      bytes = toBytes(data, typeof lengthOrEncoding === 'string' ? lengthOrEncoding : undefined);
      position = offsetOrPosition;
    } else {
      const all = toBytes(data);
      const offset = offsetOrPosition ?? 0;
      const length = typeof lengthOrEncoding === 'number' ? lengthOrEncoding : all.byteLength - offset;
      bytes = all.subarray(offset, offset + length);
      position = positionArg;
    }
    const at = position ?? this.#position;
    await writer.write(bytes, at);
    if (position == null) this.#position = at + bytes.byteLength;
    return { bytesWritten: bytes.byteLength, buffer: data };
  }

  async writeFile(data: Data, options?: FlagOptions): Promise<void> {
    const { encoding } = optionsOf(options);
    await this.write(toBytes(data, encoding));
  }

  async truncate(length = 0): Promise<void> {
    this.#check('ftruncate');
    if (!this.#writer) throw Object.assign(new Error('file not open for writing'), { code: 'EBADF' });
    await this.#writer.truncate(length);
    this.#position = Math.min(this.#position, length);
  }

  async sync(): Promise<void> {}
  async datasync(): Promise<void> {}

  createReadStream(options: ReadStreamOptions = {}): ReadStream {
    this.#check('read');
    const file = this.#file;
    if (!file) throw Object.assign(new Error('file not open for reading'), { code: 'EBADF' });
    const stream = new ReadStream(this.path, { ...options, file });
    if (options.autoClose !== false) stream.once('close', () => void this.close());
    return stream;
  }

  createWriteStream(options: WriteStreamOptions = {}): WriteStream {
    this.#check('write');
    const writer = this.#writer;
    if (!writer) throw Object.assign(new Error('file not open for writing'), { code: 'EBADF' });
    return new WriteStream(this.path, {
      ...options,
      writable: {
        write: async (bytes, position) => {
          const at = position ?? this.#position;
          await writer.write(bytes, at);
          this.#position = at + bytes.byteLength;
        },
        close: () => (options.autoClose === false ? Promise.resolve() : this.close()),
      },
      start: options.start ?? this.#position,
    });
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const writer = this.#writer;
    this.#writer = undefined;
    this.#file = undefined;
    this.#closing = writer ? writer.close() : Promise.resolve();
    return this.#closing;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export async function open(path: unknown, flags: string | number = 'r', _mode?: number): Promise<FileHandle> {
  const normalized = normalizePath(path);
  const flag = typeof flags === 'number' ? (flags & constants.O_APPEND ? 'a' : flags & 3 ? 'w' : 'r') : flags;
  if (flag === 'r') {
    const file = await (await fileHandle(normalized, 'open')).getFile();
    return new FileHandle(normalized, flag, file, undefined, 0);
  }
  if (flag.includes('x') && kindOf(normalized)) throw fsError('EEXIST', 'open', normalized);
  const exists = Boolean(kindOf(normalized));
  if (flag.startsWith('r') && !exists) throw fsError('ENOENT', 'open', normalized);
  const writer = await FileWriter.open(normalized, { truncate: flag.startsWith('w') });
  const file = flag.includes('+') ? await (await fileHandle(normalized, 'open')).getFile() : undefined;
  const position = flag.startsWith('a') ? await writer.size() : 0;
  return new FileHandle(normalized, flag, file, writer, position);
}
