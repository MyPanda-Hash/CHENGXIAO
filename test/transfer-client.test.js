import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchChunked, sendChunked } from '../src/transfer-client.js';

/**
 * The programmatic half of the chunked channel.
 *
 * The model cannot meaningfully relay a hundred chunks through a
 * conversation; these drivers are what actually move big files — a tight
 * open/read/verify loop for downloads, begin/chunk/finish for uploads — with
 * per-chunk digest checks and bounded retries so a dropped link resumes
 * instead of failing the whole transfer.
 */

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const dirs = [];
const newDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-peer-xclient-'));
  dirs.push(dir);
  return dir;
};
test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A deterministic byte buffer of an exact size. */
const contentOf = (size, seed = 7) => {
  const buffer = Buffer.alloc(size);
  let state = seed;
  for (let index = 0; index < size; index += 1) {
    state = (state * 48271) % 2147483647;
    buffer[index] = state & 0xff;
  }
  return buffer;
};

/** A fake worker serving and receiving chunks, with injectable failures. */
const makeFakeWorker = ({ staging, failChunks = 0 } = {}) => {
  const chunkSize = 64 * 1024;
  const readSessions = new Map();
  const recvSessions = new Map();
  let failuresLeft = failChunks;

  const worker = {
    calls: { read_chunk: 0, send_chunk: 0 },
    landed: undefined,

    async callTool(name, args) {
      worker.calls[name] = (worker.calls[name] ?? 0) + 1;
      if (name === 'open_read') {
        const bytes = await readFile(args.path);
        const transferId = `read-${bytes.byteLength}`;
        readSessions.set(transferId, { bytes });
        return {
          ok: true,
          transferId,
          name: 'f',
          bytes: bytes.byteLength,
          sha256: sha256(bytes),
          chunkSize,
          totalChunks: Math.max(1, Math.ceil(bytes.byteLength / chunkSize)),
        };
      }
      if (name === 'read_chunk') {
        // Simulate transient link drops: the first N chunk calls fail once.
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw Object.assign(new Error('fetch failed'), { code: 'relay-unreachable' });
        }
        const session = readSessions.get(args.transferId);
        const start = args.index * chunkSize;
        const slice = session.bytes.subarray(start, Math.min(start + chunkSize, session.bytes.byteLength));
        return { ok: true, index: args.index, data: slice.toString('base64'), sha256: sha256(slice) };
      }
      if (name === 'close_read') {
        readSessions.delete(args.transferId);
        return { ok: true };
      }
      if (name === 'send_begin') {
        const transferId = `recv-${args.bytes}`;
        recvSessions.set(transferId, { meta: args, buffer: Buffer.alloc(args.bytes), received: new Set() });
        return { ok: true, transferId, chunkSize, totalChunks: Math.max(1, Math.ceil(args.bytes / chunkSize)) };
      }
      if (name === 'send_chunk') {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw Object.assign(new Error('fetch failed'), { code: 'relay-unreachable' });
        }
        const session = recvSessions.get(args.transferId);
        const bytes = Buffer.from(args.data, 'base64');
        assert.equal(sha256(bytes), args.sha256);
        session.buffer.set(bytes, args.index * chunkSize);
        session.received.add(args.index);
        return { ok: true, index: args.index, received: session.received.size };
      }
      if (name === 'send_finish') {
        const session = recvSessions.get(args.transferId);
        assert.equal(sha256(session.buffer), session.meta.sha256);
        const path = join(staging, session.meta.name);
        await writeFile(path, session.buffer);
        worker.landed = { name: session.meta.name, path, bytes: session.buffer.byteLength };
        return { ok: true, ...worker.landed };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  return worker;
};

test('fetchChunked pulls a multi-chunk file byte-identically, with link retries', async () => {
  const remote = await newDir();
  const local = await newDir();
  const bytes = contentOf(150_000); // 3 chunks
  const remotePath = join(remote, 'big.bin');
  await writeFile(remotePath, bytes);

  const worker = makeFakeWorker({ failChunks: 2 }); // two transient drops mid-transfer
  const progress = [];
  const landed = await fetchChunked({
    callTool: worker.callTool,
    remotePath,
    localPath: join(local, 'copy.bin'),
    onProgress: (update) => progress.push(update.received),
  });

  assert.equal(landed.bytes, bytes.byteLength);
  assert.equal(landed.sha256, sha256(bytes));
  assert.deepEqual(await readFile(join(local, 'copy.bin')), bytes);
  assert.deepEqual(progress, [1, 2, 3]);
  assert.equal(worker.calls.read_chunk, 5, 'two chunk calls were retried past their drops');
});

test('fetchChunked refuses a chunk whose digest does not match', async () => {
  const remote = await newDir();
  const local = await newDir();
  const bytes = contentOf(10);
  await writeFile(join(remote, 'tiny.bin'), bytes);

  const worker = makeFakeWorker();
  const original = worker.callTool;
  worker.callTool = async (name, args) => {
    if (name === 'read_chunk') {
      return { ok: true, index: 0, data: Buffer.from('tampered!!').toString('base64'), sha256: sha256(bytes) };
    }
    return await original(name, args);
  };

  await assert.rejects(
    () => fetchChunked({ callTool: worker.callTool, remotePath: join(remote, 'tiny.bin'), localPath: join(local, 'x') }),
    (error) => error.code === 'chunk-hash-mismatch',
  );
  await assert.rejects(() => stat(join(local, 'x')), 'nothing may land on a failed pull');
});

test('fetchChunked refuses to overwrite an existing local file', async () => {
  const remote = await newDir();
  const local = await newDir();
  await writeFile(join(remote, 'a.bin'), contentOf(10));
  await writeFile(join(local, 'a.bin'), 'precious');

  const worker = makeFakeWorker();
  await assert.rejects(
    () => fetchChunked({ callTool: worker.callTool, remotePath: join(remote, 'a.bin'), localPath: join(local, 'a.bin') }),
    (error) => error.code === 'local-exists',
  );
  assert.deepEqual(await readFile(join(local, 'a.bin')), Buffer.from('precious'));
});

test('sendChunked pushes a multi-chunk file and lands it on the worker', async () => {
  const staging = await newDir();
  const local = await newDir();
  const bytes = contentOf(150_000);
  const localPath = join(local, 'up.bin');
  await writeFile(localPath, bytes);

  const worker = makeFakeWorker({ staging, failChunks: 1 });
  const progress = [];
  const sent = await sendChunked({
    callTool: worker.callTool,
    localPath,
    onProgress: (update) => progress.push(update.sent),
  });

  assert.equal(sent.bytes, bytes.byteLength);
  assert.equal(sent.name, 'up.bin');
  assert.deepEqual(await readFile(worker.landed.path), bytes);
  assert.deepEqual(progress, [1, 2, 3]);
  assert.equal(worker.calls.send_chunk, 4, 'one chunk call was retried past its drop');
});
