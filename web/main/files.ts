// SPDX-License-Identifier: AGPL-3.0-only
//
// The app's files (attachments, avatars, drafts, stickers, downloads, temp:
// the directories under userData Desktop keeps on disk) in the origin
// private file system, under OPFS:/userData/ like the database
// (OPFS:/userData/sql/, which belongs to the SQL worker and is never touched
// here). The renderer's `fs` and `fs/promises` (renderer/shims/node/fs*.ts)
// are built on this.
//
// OPFS is asynchronous on the page; Desktop also asks synchronous questions
// (existsSync, realpathSync). So the directory tree (names and kinds, not
// contents) is kept in memory: read once at startup (initFiles(), before
// Desktop's code runs) and updated by every change made here. Only this tab
// changes these files: the database lock (web/sql) keeps other tabs out.
//
// Desktop encrypts attachment files itself (AttachmentCrypto) before they
// get here; nothing here logs file contents.

import { posix } from 'node:path';

export const ROOT = '/userData';
const SQL_DIRECTORY = '/userData/sql';

export type EntryKind = 'file' | 'directory';

type Entry = { kind: EntryKind };

const entries = new Map<string, Entry>();
const children = new Map<string, Set<string>>();
const directoryHandles = new Map<string, FileSystemDirectoryHandle>();
const writers = new Map<string, Set<FileWriter>>();
let initializing: Promise<void> | undefined;

/**
 * A file open for writing. OPFS writes go to a copy that replaces the file
 * when committed (on close); Node writes in place. To keep Node's behaviour
 * where it matters: truncation ('w') happens when the file is opened, the
 * copy is only made on the first write (a handle that never writes changes
 * nothing when closed), and removing a file that is open does not fail (the
 * writer is detached: its changes are dropped, further writes go nowhere).
 */
export class FileWriter {
  readonly path: string;
  readonly #handle: FileSystemFileHandle;
  #writable: Promise<FileSystemWritableFileStream> | undefined;
  #detached = false;
  #done: Promise<void> | undefined;

  private constructor(path: string, handle: FileSystemFileHandle) {
    this.path = path;
    this.#handle = handle;
    let set = writers.get(path);
    if (!set) {
      set = new Set();
      writers.set(path, set);
    }
    set.add(this);
  }

  /** Opens `path` (created if missing) for writing; `truncate` empties it now. */
  static async open(path: string, { truncate, syscall = 'open' }: { truncate: boolean; syscall?: string }): Promise<FileWriter> {
    const handle = await createFileHandle(path, syscall);
    if (truncate && (await handle.getFile()).size > 0) {
      const empty = await handle.createWritable({ keepExistingData: false });
      await empty.close();
    }
    return new FileWriter(path, handle);
  }

  async size(): Promise<number> {
    return (await this.#handle.getFile()).size;
  }

  #open(): Promise<FileSystemWritableFileStream> {
    this.#writable ??= this.#handle.createWritable({ keepExistingData: true });
    return this.#writable;
  }

  async write(bytes: Uint8Array, position: number): Promise<void> {
    if (this.#detached || this.#done) return;
    const writable = await this.#open();
    await writable.write({ type: 'write', position, data: bytes as Uint8Array<ArrayBuffer> });
  }

  async truncate(size: number): Promise<void> {
    if (this.#detached || this.#done) return;
    await (await this.#open()).truncate(size);
  }

  #forget(): void {
    const set = writers.get(this.path);
    set?.delete(this);
    if (set?.size === 0) writers.delete(this.path);
  }

  /** Commits what was written. */
  close(): Promise<void> {
    if (!this.#done) {
      this.#forget();
      const writable = this.#writable;
      this.#done = writable ? writable.then(w => w.close()) : Promise.resolve();
    }
    return this.#done;
  }

  /** Drops what was written. */
  detach(): Promise<void> {
    this.#detached = true;
    if (!this.#done) {
      this.#forget();
      const writable = this.#writable;
      this.#done = writable ? writable.then(w => w.abort()).catch(() => undefined) : Promise.resolve();
    }
    return this.#done;
  }
}

async function detachWriters(path: string): Promise<void> {
  const open = [...writers.entries()]
    .filter(([writerPath]) => writerPath === path || writerPath.startsWith(`${path}/`))
    .flatMap(([, set]) => [...set]);
  await Promise.all(open.map(writer => writer.detach()));
}

/** A Node-style file system error (code, errno, syscall, path). */
export function fsError(code: string, syscall: string, path: string, detail?: string): Error {
  const messages: Record<string, [number, string]> = {
    ENOENT: [-2, 'no such file or directory'],
    EEXIST: [-17, 'file already exists'],
    ENOTDIR: [-20, 'not a directory'],
    EISDIR: [-21, 'illegal operation on a directory'],
    ENOTEMPTY: [-39, 'directory not empty'],
    EACCES: [-13, 'permission denied'],
    EIO: [-5, 'i/o error'],
  };
  const [errno, text] = messages[code] ?? [-5, 'i/o error'];
  const error = new Error(`${code}: ${detail ?? text}, ${syscall} '${path}'`);
  return Object.assign(error, { code, errno, syscall, path });
}

/** Absolute, normalized path for any path-like argument. */
export function normalizePath(path: unknown): string {
  let text: string;
  if (typeof path === 'string') text = path;
  else if (path instanceof URL) text = decodeURIComponent(path.pathname);
  else if (path instanceof Uint8Array) text = new TextDecoder().decode(path);
  else throw new TypeError(`path must be a string, URL or Buffer (got ${typeof path})`);
  const normalized = posix.resolve('/', text);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function inScope(path: string): boolean {
  if (path === SQL_DIRECTORY || path.startsWith(`${SQL_DIRECTORY}/`)) return false;
  return path === ROOT || path.startsWith(`${ROOT}/`);
}

/** Throws EACCES for paths the web build does not store (outside userData, or the database's directory). */
export function checkScope(path: string, syscall: string): void {
  if (!inScope(path)) {
    throw fsError('EACCES', syscall, path, 'outside the web build\'s storage');
  }
}

function addEntry(path: string, kind: EntryKind): void {
  entries.set(path, { kind });
  if (path === ROOT) return;
  const parent = posix.dirname(path);
  let set = children.get(parent);
  if (!set) {
    set = new Set();
    children.set(parent, set);
  }
  set.add(posix.basename(path));
}

function removeEntry(path: string): void {
  for (const name of children.get(path) ?? []) removeEntry(posix.join(path, name));
  children.delete(path);
  entries.delete(path);
  directoryHandles.delete(path);
  children.get(posix.dirname(path))?.delete(posix.basename(path));
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  const cached = directoryHandles.get(ROOT);
  if (cached) return cached;
  const handle = await (await navigator.storage.getDirectory()).getDirectoryHandle('userData', { create: true });
  directoryHandles.set(ROOT, handle);
  return handle;
}

async function walk(path: string, handle: FileSystemDirectoryHandle): Promise<void> {
  directoryHandles.set(path, handle);
  const subdirectories: Array<Promise<void>> = [];
  for await (const [name, child] of (handle as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    const childPath = posix.join(path, name);
    if (!inScope(childPath)) continue;
    if (child.kind === 'directory') {
      addEntry(childPath, 'directory');
      subdirectories.push(walk(childPath, child as FileSystemDirectoryHandle));
    } else {
      addEntry(childPath, 'file');
    }
  }
  await Promise.all(subdirectories);
}

/** Reads the directory tree; Desktop's code may run once it resolved. */
export function initFiles(): Promise<void> {
  initializing ??= (async () => {
    const root = await opfsRoot();
    addEntry(ROOT, 'directory');
    await walk(ROOT, root);
  })().catch(error => {
    initializing = undefined;
    throw error;
  });
  return initializing;
}

export function kindOf(path: string): EntryKind | undefined {
  return entries.get(path)?.kind;
}

export function listDirectory(path: string): Array<string> {
  return [...(children.get(path) ?? [])].sort();
}

async function directoryHandle(path: string, syscall: string): Promise<FileSystemDirectoryHandle> {
  const cached = directoryHandles.get(path);
  if (cached) return cached;
  if (path === ROOT) return opfsRoot();
  if (kindOf(path) !== 'directory') {
    throw fsError(kindOf(path) ? 'ENOTDIR' : 'ENOENT', syscall, path);
  }
  const parent = await directoryHandle(posix.dirname(path), syscall);
  const handle = await parent.getDirectoryHandle(posix.basename(path));
  directoryHandles.set(path, handle);
  return handle;
}

/** The OPFS handle of an existing file. */
export async function fileHandle(path: string, syscall: string): Promise<FileSystemFileHandle> {
  checkScope(path, syscall);
  const kind = kindOf(path);
  if (kind === 'directory') throw fsError('EISDIR', syscall, path);
  if (!kind) throw fsError('ENOENT', syscall, path);
  const parent = await directoryHandle(posix.dirname(path), syscall);
  return parent.getFileHandle(posix.basename(path));
}

/** The OPFS handle of a file, created (empty) if missing; its directory must exist. */
export async function createFileHandle(path: string, syscall: string): Promise<FileSystemFileHandle> {
  checkScope(path, syscall);
  const kind = kindOf(path);
  if (kind === 'directory') throw fsError('EISDIR', syscall, path);
  if (kindOf(posix.dirname(path)) !== 'directory') {
    throw fsError(kindOf(posix.dirname(path)) ? 'ENOTDIR' : 'ENOENT', syscall, path);
  }
  const parent = await directoryHandle(posix.dirname(path), syscall);
  const handle = await parent.getFileHandle(posix.basename(path), { create: true });
  addEntry(path, 'file');
  return handle;
}

export async function makeDirectory(path: string, recursive: boolean, syscall = 'mkdir'): Promise<string | undefined> {
  checkScope(path, syscall);
  const kind = kindOf(path);
  if (kind) {
    if (recursive && kind === 'directory') return undefined;
    throw fsError('EEXIST', syscall, path);
  }
  const parentPath = posix.dirname(path);
  let first: string | undefined;
  if (!kindOf(parentPath)) {
    if (!recursive) throw fsError('ENOENT', syscall, path);
    first = await makeDirectory(parentPath, true, syscall);
  } else if (kindOf(parentPath) !== 'directory') {
    throw fsError('ENOTDIR', syscall, path);
  }
  const parent = await directoryHandle(parentPath, syscall);
  const handle = await parent.getDirectoryHandle(posix.basename(path), { create: true });
  addEntry(path, 'directory');
  directoryHandles.set(path, handle);
  return first ?? path;
}

/** Removes a file or (with `recursive`) a directory tree. */
export async function removePath(
  path: string,
  { recursive, syscall }: { recursive: boolean; syscall: string }
): Promise<void> {
  checkScope(path, syscall);
  if (path === ROOT) throw fsError('EACCES', syscall, path);
  const kind = kindOf(path);
  if (!kind) throw fsError('ENOENT', syscall, path);
  if (kind === 'directory' && !recursive && listDirectory(path).length > 0) {
    throw fsError('ENOTEMPTY', syscall, path);
  }
  await detachWriters(path);
  const parent = await directoryHandle(posix.dirname(path), syscall);
  try {
    await parent.removeEntry(posix.basename(path), { recursive: kind === 'directory' });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
  }
  removeEntry(path);
}

/** Drops the cached tree under `path` after it was removed outside this module (erase-*). */
export function forgetPath(path: string): void {
  removeEntry(path);
}

export async function fileInfo(path: string, syscall: string): Promise<{ kind: EntryKind; size: number; mtimeMs: number }> {
  checkScope(path, syscall);
  const kind = kindOf(path);
  if (!kind) throw fsError('ENOENT', syscall, path);
  if (kind === 'directory') return { kind, size: 4096, mtimeMs: 0 };
  const file = await (await fileHandle(path, syscall)).getFile();
  return { kind, size: file.size, mtimeMs: file.lastModified };
}

export async function readWholeFile(path: string, syscall = 'open'): Promise<Uint8Array<ArrayBuffer>> {
  const file = await (await fileHandle(path, syscall)).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

/** Writes `data` to `path` (replacing it, or appending with `append`). */
export async function writeWholeFile(
  path: string,
  data: Uint8Array,
  { append = false, exclusive = false, syscall = 'open' } = {}
): Promise<void> {
  if (exclusive && kindOf(path)) throw fsError('EEXIST', syscall, path);
  const writer = await FileWriter.open(path, { truncate: !append, syscall });
  try {
    await writer.write(data, append ? await writer.size() : 0);
    await writer.close();
  } catch (error) {
    await writer.detach();
    throw error;
  }
}

/** Moves a file or directory (replacing an existing file at `to`). */
export async function movePath(from: string, to: string): Promise<void> {
  checkScope(from, 'rename');
  checkScope(to, 'rename');
  const kind = kindOf(from);
  if (!kind) throw fsError('ENOENT', 'rename', from);
  if (from === to) return;
  if (kindOf(posix.dirname(to)) !== 'directory') throw fsError('ENOENT', 'rename', to);
  if (kind === 'file') {
    if (kindOf(to) === 'directory') throw fsError('EISDIR', 'rename', to);
    await copyFileContents(from, to);
    await removePath(from, { recursive: false, syscall: 'rename' });
    return;
  }
  if (kindOf(to)) {
    if (kindOf(to) !== 'directory') throw fsError('ENOTDIR', 'rename', to);
    if (listDirectory(to).length > 0) throw fsError('ENOTEMPTY', 'rename', to);
  } else {
    await makeDirectory(to, false, 'rename');
  }
  for (const name of listDirectory(from)) {
    // eslint-disable-next-line no-await-in-loop
    await movePath(posix.join(from, name), posix.join(to, name));
  }
  await removePath(from, { recursive: true, syscall: 'rename' });
}

export async function copyFileContents(from: string, to: string, { exclusive = false } = {}): Promise<void> {
  const source = await (await fileHandle(from, 'copyfile')).getFile();
  if (exclusive && kindOf(to)) throw fsError('EEXIST', 'copyfile', to);
  const writer = await FileWriter.open(to, { truncate: true, syscall: 'copyfile' });
  const CHUNK = 1024 * 1024;
  try {
    for (let offset = 0; offset < source.size; offset += CHUNK) {
      // eslint-disable-next-line no-await-in-loop
      await writer.write(new Uint8Array(await source.slice(offset, offset + CHUNK).arrayBuffer()), offset);
    }
    await writer.close();
  } catch (error) {
    await writer.detach();
    throw error;
  }
}
