// SPDX-License-Identifier: AGPL-3.0-only
//
// Checks of the renderer's node:fs / node:fs/promises (shims/node/fs*.ts on
// web/main/files.ts) in the browser, with Node's semantics where Desktop
// relies on them. Run by renderer/test/fs-shim.mjs.

import { Buffer } from 'node:buffer';
import { createReadStream, createWriteStream, existsSync, realpathSync } from 'node:fs';
import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import fsExtra from 'fs-extra';

import { initFiles } from '../../main/files.ts';

type Result = { name: string; ok: boolean; detail?: string };

declare global {
  interface Window {
    fsResults?: Array<Result>;
  }
}

const results: Array<Result> = [];

async function check(name: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail === undefined ? undefined : String(detail) });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert((error as { code?: string }).code === code, `expected ${code}, got ${(error as { code?: string }).code}`);
    return;
  }
  throw new Error(`expected ${code}, got success`);
}

const DIR = '/userData/fs-test';
function random(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, i + 65536));
  return out;
}

async function main(): Promise<void> {
  await initFiles();
  await rm(DIR, { recursive: true, force: true });

  await check('mkdir recursive, existsSync, stat directory', async () => {
    await mkdir(`${DIR}/a/b`, { recursive: true });
    assert(existsSync(`${DIR}/a/b`), 'existsSync after mkdir');
    assert((await stat(`${DIR}/a`)).isDirectory(), 'stat isDirectory');
    await rejectsWith(mkdir(`${DIR}/a`), 'EEXIST');
    await rejectsWith(mkdir(`${DIR}/x/y`), 'ENOENT');
  });

  await check('writeFile, readFile, stat size, appendFile', async () => {
    const data = random(100_000);
    await writeFile(`${DIR}/a/file.bin`, data);
    const back = await readFile(`${DIR}/a/file.bin`);
    assert(Buffer.compare(back as Buffer, Buffer.from(data)) === 0, 'contents');
    assert((await stat(`${DIR}/a/file.bin`)).size === 100_000, 'size');
    await appendFile(`${DIR}/a/file.bin`, 'tail');
    assert((await stat(`${DIR}/a/file.bin`)).size === 100_004, 'size after append');
    await writeFile(`${DIR}/a/text.txt`, 'hello', 'utf8');
    assert((await readFile(`${DIR}/a/text.txt`, 'utf8')) === 'hello', 'text');
  });

  await check('readdir, withFileTypes', async () => {
    const names = await readdir(`${DIR}/a`);
    assert(JSON.stringify(names) === JSON.stringify(['b', 'file.bin', 'text.txt']), `names ${JSON.stringify(names)}`);
    const entries = (await readdir(`${DIR}/a`, { withFileTypes: true })) as unknown as Array<{ name: string; isDirectory(): boolean }>;
    assert(entries.find(e => e.name === 'b')?.isDirectory(), 'dirent kind');
  });

  await check('streams: 3 MB through createWriteStream and createReadStream (range)', async () => {
    const data = random(3 * 1024 * 1024);
    const chunks: Array<Uint8Array> = [];
    for (let i = 0; i < data.length; i += 50_000) chunks.push(data.subarray(i, i + 50_000));
    await pipeline(Readable.from(chunks), createWriteStream(`${DIR}/stream.bin`));
    const out: Array<Buffer> = [];
    for await (const chunk of createReadStream(`${DIR}/stream.bin`)) out.push(chunk as Buffer);
    assert(Buffer.compare(Buffer.concat(out), Buffer.from(data)) === 0, 'stream round trip');
    const part: Array<Buffer> = [];
    for await (const chunk of createReadStream(`${DIR}/stream.bin`, { start: 10, end: 19 })) part.push(chunk as Buffer);
    assert(Buffer.compare(Buffer.concat(part), Buffer.from(data.subarray(10, 20))) === 0, 'range read');
  });

  await check('append stream resumes at an offset (downloads)', async () => {
    await writeFile(`${DIR}/resume.bin`, 'abc');
    await pipeline(Readable.from([Buffer.from('def')]), createWriteStream(`${DIR}/resume.bin`, { flags: 'a', start: 3 }));
    assert((await readFile(`${DIR}/resume.bin`, 'utf8')) === 'abcdef', 'appended');
  });

  await check("a handle opened with 'w' and never written does not undo a stream's writes", async () => {
    // AttachmentCrypto: open(path, 'w'), then createWriteStream(path), then close the handle.
    await writeFile(`${DIR}/both.bin`, 'old contents');
    const handle = await open(`${DIR}/both.bin`, 'w');
    assert((await stat(`${DIR}/both.bin`)).size === 0, 'truncated on open');
    await pipeline(Readable.from([Buffer.from('new')]), createWriteStream(`${DIR}/both.bin`));
    await handle.close();
    assert((await readFile(`${DIR}/both.bin`, 'utf8')) === 'new', 'contents kept');
  });

  await check('FileHandle write stream and read stream', async () => {
    const writer = await open(`${DIR}/handle.bin`, 'w');
    await pipeline(Readable.from([Buffer.from('hello '), Buffer.from('world')]), writer.createWriteStream());
    await writer.close();
    const reader = await open(`${DIR}/handle.bin`, 'r');
    const out: Array<Buffer> = [];
    for await (const chunk of reader.createReadStream()) out.push(chunk as Buffer);
    await reader.close();
    assert(Buffer.concat(out).toString() === 'hello world', 'contents');
  });

  await check('removing a file that is open for writing works (as in Node)', async () => {
    const handle = await open(`${DIR}/open.bin`, 'w');
    await handle.write(Buffer.from('data'));
    await unlink(`${DIR}/open.bin`);
    assert(!existsSync(`${DIR}/open.bin`), 'gone');
    await handle.close();
    assert(!existsSync(`${DIR}/open.bin`), 'still gone after close');
  });

  await check('rename, copyFile, realpathSync', async () => {
    await rename(`${DIR}/a/text.txt`, `${DIR}/moved.txt`);
    assert(!existsSync(`${DIR}/a/text.txt`) && existsSync(`${DIR}/moved.txt`), 'moved');
    await copyFile(`${DIR}/moved.txt`, `${DIR}/copy.txt`);
    assert((await readFile(`${DIR}/copy.txt`, 'utf8')) === 'hello', 'copied');
    assert(realpathSync(`${DIR}/./a/../copy.txt`) === `${DIR}/copy.txt`, 'realpath');
  });

  await check('fs-extra: ensureFile, pathExists, remove, emptyDir', async () => {
    await fsExtra.ensureFile(`${DIR}/deep/er/file.txt`);
    assert(await fsExtra.pathExists(`${DIR}/deep/er/file.txt`), 'ensureFile');
    await fsExtra.emptyDir(`${DIR}/deep`);
    assert((await readdir(`${DIR}/deep`)).length === 0, 'emptyDir');
    await fsExtra.remove(`${DIR}/deep`);
    assert(!existsSync(`${DIR}/deep`), 'remove');
  });

  await check('errors: ENOENT, EISDIR, EACCES outside userData and for the database directory', async () => {
    await rejectsWith(readFile(`${DIR}/missing`), 'ENOENT');
    await rejectsWith(unlink(`${DIR}/a`), 'EISDIR');
    await rejectsWith(writeFile('/etc/passwd', 'x'), 'EACCES');
    await rejectsWith(readdir('/userData/sql'), 'EACCES');
    await rm(`${DIR}/missing`, { force: true });
  });

  await check('the tree survives a fresh read of OPFS', async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('userData');
    const dir = await root.getDirectoryHandle('fs-test');
    const names: Array<string> = [];
    for await (const [name] of dir as unknown as AsyncIterable<[string]>) names.push(name);
    names.sort();
    const expected = (await readdir(DIR)) as Array<string>;
    assert(JSON.stringify(names) === JSON.stringify(expected), `OPFS ${JSON.stringify(names)} vs tree ${JSON.stringify(expected)}`);
  });

  await rm(DIR, { recursive: true, force: true });
  window.fsResults = results;
}

main().catch(error => {
  results.push({ name: 'run', ok: false, detail: String(error) });
  window.fsResults = results;
});
