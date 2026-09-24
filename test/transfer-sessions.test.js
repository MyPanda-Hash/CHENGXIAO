import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createReadSessions,
  createReceiveSessions,
  DEFAULT_CHUNK_SIZE,
} from '../src/transfer-sessions.js';

/**
 * Chunked transfer sessions: the worker-side halves of the file channel.
 *
 * Read sessions serve a local file in policy-checked chunks, any order, as
 * often as the peer asks — that re-readability *is* the resume story for
 * downloads. Receive sessions assemble a peer's file chunk by chunk into a
 * temp file, idempotently per index, and only rename it into staging after
 * the whole-file hash verifies. Everything here is what makes a 50 MiB file
 * survivable on a link that drops halfway.
 */

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const workspaces = [];
const newWorkspace = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-peer-xfer-'));
  workspaces.push(dir);
  return dir;
};
test.after(async () => {
  for (const dir of workspaces) await rm(dir, { recursive: true, force: true });
});

/** Deterministic pseudo-random content of an exact size. */
const contentOf = (size, seed = 1) => {
  const buffer = Buffer.alloc(size);
  let state = seed;
  for (let index = 0; index < size; index += 1) {
    state = (state * 48271) % 2147483647;
    buffer[index] = state & 0xff;
  }
  return buffer;
};

test('a read session serves any chunk, in any order, with exact bytes', async () => {
  const workspace = await newWorkspace();
  const bytes = contentOf(150_000); // 3 chunks at 64 KiB
  const path = join(workspace, 'big.bin');
  await writeFile(path, bytes);

  const sessions = createReadSessions({ allowedDirs: [workspace], chunkSize: 64 * 1024 });
  const opened = await sessions.open({ path });

  assert.match(opened.transferId, /^read-/u);
  assert.equal(opened.bytes, bytes.byteLength);
  assert.equal(opened.sha256, sha256(bytes));
  assert.equal(opened.chunkSize, 64 * 1024);
  assert.equal(opened.totalChunks, 3);

  // Read the middle chunk first, then again (re-read is the resume path).
  const middle = await sessions.chunk(opened.transferId, 1);
  assert.deepEqual(middle.data, bytes.subarray(64 * 1024, 128 * 1024).toString('base64'));
  assert.equal(middle.sha256, sha256(bytes.subarray(64 * 1024, 128 * 1024)));

  const again = await sessions.chunk(opened.transferId, 1);
  assert.equal(again.sha256, middle.sha256, 'a re-read chunk must be identical');

  const last = await sessions.chunk(opened.transferId, 2);
  assert.deepEqual(Buffer.from(last.data, 'base64'), bytes.subarray(128 * 1024));
});

test('a read session refuses unknown ids, out-of-range chunks, and closed sessions', async () => {
  const workspace = await newWorkspace();
  const path = join(workspace, 'small.txt');
  await writeFile(path, 'hello');

  const sessions = createReadSessions({ allowedDirs: [workspace] });
  const opened = await sessions.open({ path });

  await assert.rejects(() => sessions.chunk('read-nope', 0), (error) => error.code === 'transfer-unknown');
  await assert.rejects(() => sessions.chunk(opened.transferId, 5), (error) => error.code === 'chunk-out-of-range');
  await assert.rejects(() => sessions.chunk(opened.transferId, -1), (error) => error.code === 'chunk-out-of-range');

  await sessions.close(opened.transferId);
  await assert.rejects(() => sessions.chunk(opened.transferId, 0), (error) => error.code === 'transfer-unknown');
});

test('a read session enforces the allowlist and the size ceiling', async () => {
  const workspace = await newWorkspace();
  const other = await newWorkspace();
  await writeFile(join(workspace, 'inside.txt'), 'in');
  await writeFile(join(other, 'outside.txt'), 'out');

  const sessions = createReadSessions({ allowedDirs: [workspace], maxBytes: 4 });
  await assert.rejects(
    () => sessions.open({ path: join(other, 'outside.txt') }),
    (error) => error.code === 'path-not-allowed',
  );

  await writeFile(join(workspace, 'huge.bin'), contentOf(8));
  await assert.rejects(
    () => sessions.open({ path: join(workspace, 'huge.bin') }),
    (error) => error.code === 'file-too-large',
  );
});

test('a read session expires when idle past its window', async () => {
  const workspace = await newWorkspace();
  const path = join(workspace, 'idle.txt');
  await writeFile(path, 'x');

  let now = 1_000_000;
  const sessions = createReadSessions({ allowedDirs: [workspace], clock: () => new Date(now), idleMs: 60_000 });
  const opened = await sessions.open({ path });
  assert.ok((await sessions.chunk(opened.transferId, 0)).data.length > 0);

  now += 61_000;
  await assert.rejects(() => sessions.chunk(opened.transferId, 0), (error) => error.code === 'transfer-unknown');
});

test('a receive session assembles out-of-order chunks idempotently and lands atomically', async () => {
  const staging = await newWorkspace();
  const sessions = createReceiveSessions({ stagingDir: staging, chunkSize: 64 * 1024 });

  const bytes = contentOf(150_000); // 3 chunks
  const digestWhole = sha256(bytes);
  const chunk = (index) => {
    const slice = bytes.subarray(index * 64 * 1024, Math.min((index + 1) * 64 * 1024, bytes.byteLength));
    return { index, data: slice.toString('base64'), sha256: sha256(slice) };
  };

  const begun = await sessions.begin({ name: 'report.bin', bytes: bytes.byteLength, sha256: digestWhole });
  assert.match(begun.transferId, /^recv-/u);
  assert.equal(begun.totalChunks, 3);

  // Out of order: 1, then 0, then a duplicate of 1 (idempotent), then 2.
  assert.equal((await sessions.chunk({ transferId: begun.transferId, ...chunk(1) })).received, 1);
  assert.equal((await sessions.chunk({ transferId: begun.transferId, ...chunk(0) })).received, 2);
  const duplicate = await sessions.chunk({ transferId: begun.transferId, ...chunk(1) });
  assert.equal(duplicate.received, 2, 'a duplicate chunk must not count twice');
  assert.equal((await sessions.chunk({ transferId: begun.transferId, ...chunk(2) })).received, 3);

  const landed = await sessions.finish(begun.transferId);
  assert.equal(landed.name, 'report.bin');
  assert.equal(landed.bytes, bytes.byteLength);
  assert.equal(landed.sha256, digestWhole);
  assert.deepEqual(await readFile(landed.path), bytes, 'the assembled file must be byte-identical');

  await assert.rejects(
    () => sessions.finish(begun.transferId),
    (error) => error.code === 'transfer-unknown',
    'a finished session is gone',
  );
});

test('a receive session refuses chunk hash mismatches without counting them', async () => {
  const staging = await newWorkspace();
  const sessions = createReceiveSessions({ stagingDir: staging });

  const bytes = contentOf(10);
  const begun = await sessions.begin({ name: 'x.bin', bytes: bytes.byteLength, sha256: sha256(bytes) });

  // Same length, different bytes: the digest check must be what refuses it.
  // (A self-consistent wrong chunk passes chunk() by design — the whole-file
  // hash at finish is what catches substituted content.)
  const tampered = contentOf(10, 99);
  await assert.rejects(
    () =>
      sessions.chunk({
        transferId: begun.transferId,
        index: 0,
        data: tampered.toString('base64'),
        sha256: sha256(bytes),
      }),
    (error) => error.code === 'chunk-hash-mismatch',
  );
  const good = await sessions.chunk({
    transferId: begun.transferId,
    index: 0,
    data: bytes.toString('base64'),
    sha256: sha256(bytes),
  });
  assert.equal(good.received, 1, 'only the good chunk counts');

  await sessions.cancel(begun.transferId).catch(() => {});
});

test('a receive session refuses to finish on a wrong whole-file hash and lands nothing', async () => {
  const staging = await newWorkspace();
  const sessions = createReceiveSessions({ stagingDir: staging });

  const bytes = contentOf(10);
  const begun = await sessions.begin({ name: 'y.bin', bytes: bytes.byteLength, sha256: sha256(contentOf(10, 99)) });
  await sessions.chunk({
    transferId: begun.transferId,
    index: 0,
    data: bytes.toString('base64'),
    sha256: sha256(bytes),
  });

  await assert.rejects(() => sessions.finish(begun.transferId), (error) => error.code === 'hash-mismatch');
  await assert.rejects(() => stat(join(staging, 'y.bin')), 'nothing may land on a failed finish');
});

test('a finished receive never overwrites an existing staging file', async () => {
  const staging = await newWorkspace();
  const sessions = createReceiveSessions({ stagingDir: staging });

  const bytes = contentOf(10);
  await writeFile(join(staging, 'taken.bin'), 'already here');

  const begun = await sessions.begin({ name: 'taken.bin', bytes: bytes.byteLength, sha256: sha256(bytes) });
  await sessions.chunk({
    transferId: begun.transferId,
    index: 0,
    data: bytes.toString('base64'),
    sha256: sha256(bytes),
  });
  const landed = await sessions.finish(begun.transferId);

  assert.notEqual(landed.name, 'taken.bin', 'the collision must be suffixed, not overwritten');
  assert.deepEqual(await readFile(join(staging, 'taken.bin')), Buffer.from('already here'));
  assert.deepEqual(await readFile(landed.path), bytes);
});

test('a cancelled receive deletes its temp file, and unknown ids are answers', async () => {
  const staging = await newWorkspace();
  const sessions = createReceiveSessions({ stagingDir: staging });

  const begun = await sessions.begin({ name: 'z.bin', bytes: 10, sha256: sha256(Buffer.alloc(10)) });
  await sessions.cancel(begun.transferId);
  await assert.rejects(
    () => sessions.chunk({ transferId: begun.transferId, index: 0, data: '', sha256: sha256(Buffer.alloc(0)) }),
    (error) => error.code === 'transfer-unknown',
  );

  const files = await readdirSafe(staging);
  assert.deepEqual(files, [], 'cancel must leave no temp file behind');

  await assert.rejects(() => sessions.cancel('recv-nope'), (error) => error.code === 'transfer-unknown');
});

test('a receive session expires when idle past its window', async () => {
  const staging = await newWorkspace();
  let now = 1_000_000;
  const sessions = createReceiveSessions({ stagingDir: staging, clock: () => new Date(now), idleMs: 60_000 });

  const begun = await sessions.begin({ name: 'w.bin', bytes: 5, sha256: sha256(Buffer.alloc(5)) });
  now += 61_000;
  await assert.rejects(
    () => sessions.chunk({ transferId: begun.transferId, index: 0, data: '', sha256: sha256(Buffer.alloc(0)) }),
    (error) => error.code === 'transfer-unknown',
  );
  assert.deepEqual(await readdirSafe(staging), [], 'the expired temp file must be swept');
});

async function readdirSafe(dir) {
  const { readdir } = await import('node:fs/promises');
  return await readdir(dir);
}
