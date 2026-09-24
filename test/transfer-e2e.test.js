import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeerService } from '../src/service.js';
import { createRelayServer } from '../src/relay/server.js';

/**
 * Big files across the whole stack, the way an operator would move them.
 *
 * A 1.5 MiB file is three chunks on the wire; pulling and pushing it through
 * the service-level drivers exercises the chunk tools, the digests, the
 * retries and the atomic landing on both sides - over the direct listener
 * and, in the second test, over the relay with its sealed replay.
 */

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const dirs = [];
const newDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-peer-xe2e-'));
  dirs.push(dir);
  return dir;
};
test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** Deterministic content of an exact size. */
const contentOf = (size, seed = 3) => {
  const buffer = Buffer.alloc(size);
  let state = seed;
  for (let index = 0; index < size; index += 1) {
    state = (state * 48271) % 2147483647;
    buffer[index] = state & 0xff;
  }
  return buffer;
};

const quietExecutor = { ask: async () => ({ answer: '', stderr: '', exitCode: 0, timedOut: false }) };

test('a 1.5 MiB file round-trips chunked over the direct listener', async () => {
  const workerHome = await newDir();
  const deskHome = await newDir();
  const shared = await newDir();
  const local = await newDir();

  const bytes = contentOf(1_566_720); // exactly 1.5 MiB = 3 chunks of 512 KiB... default 1 MiB chunks: 2 chunks
  const remotePath = join(shared, 'dataset.bin');
  await writeFile(remotePath, bytes);

  const worker = await createPeerService({
    home: workerHome,
    deviceName: 'worker',
    executor: quietExecutor,
    listen: true,
    host: '127.0.0.1',
    port: 0,
    allowedDirs: [shared],
    log: () => {},
  });
  const desk = await createPeerService({
    home: deskHome,
    deviceName: 'desk',
    executor: quietExecutor,
    listen: false,
    log: () => {},
  });

  try {
    const ticket = await worker.createTicket();
    const outcome = await desk.pair({ link: ticket.link });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));

    // Pull: desk fetches the worker's file into its own workspace.
    const progress = [];
    const pulled = await desk.fetchPeerFile('desk', remotePath, join(local, 'copy.bin'), {
      onProgress: (update) => progress.push(update.received),
    });
    assert.equal(pulled.bytes, bytes.byteLength);
    assert.equal(pulled.sha256, sha256(bytes));
    assert.deepEqual(await readFile(join(local, 'copy.bin')), bytes, 'byte-identical after the chunked pull');
    assert.deepEqual(progress, [1, 2], 'two 1 MiB chunks by default');

    // Push: desk sends its own file to the worker's staging.
    const source = join(local, 'outgoing.bin');
    await writeFile(source, bytes);
    const sent = await desk.sendPeerFile('desk', source);
    assert.equal(sent.bytes, bytes.byteLength);
    assert.equal(sha256(await readFile(sent.path)), sha256(bytes), 'the worker landed the same bytes');
  } finally {
    await worker.stop();
    await desk.stop();
  }
});

test('a chunked pull works over the relay with no listener at all', async () => {
  const relay = await createRelayServer({ log: () => {} });
  try {
    const shared = await newDir();
    const local = await newDir();
    const bytes = contentOf(1_200_000);
    const remotePath = join(shared, 'via-relay.bin');
    await writeFile(remotePath, bytes);

    const worker = await createPeerService({
      home: await newDir(),
      deviceName: 'worker',
      executor: quietExecutor,
      listen: false,
      relay: { url: relay.url, deviceId: 'worker-id', enabled: true },
      allowedDirs: [shared],
      log: () => {},
    });
    const desk = await createPeerService({
      home: await newDir(),
      deviceName: 'desk',
      executor: quietExecutor,
      listen: false,
      relay: { url: relay.url, deviceId: 'desk-id', enabled: true },
      log: () => {},
    });

    try {
      const ticket = await worker.createTicket();
      const outcome = await desk.pair({ link: ticket.link });
      assert.equal(outcome.ok, true, JSON.stringify(outcome));

      const pulled = await desk.fetchPeerFile('desk', remotePath, join(local, 'copy.bin'));
      assert.equal(pulled.sha256, sha256(bytes));
      assert.deepEqual(await readFile(join(local, 'copy.bin')), bytes, 'byte-identical through the relay');
    } finally {
      await worker.stop();
      await desk.stop();
    }
  } finally {
    await relay.close();
  }
});
