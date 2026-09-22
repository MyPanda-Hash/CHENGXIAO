import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspace = await mkdtemp(join(tmpdir(), 'dsh-peer-transfer-'));
const staging = join(workspace, 'staging');
await mkdir(staging, { recursive: true });
test.after(() => rm(workspace, { recursive: true, force: true }));

/** SHA-256 the way the wire contract states it, so a test failure is about behaviour, not formatting. */
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

test('an outgoing file carries its name, size, hash and bytes', async () => {
  const { readOutgoing } = await import('../src/transfer.js');
  const path = join(workspace, 'notes.md');
  await writeFile(path, 'hello peer', 'utf8');

  const file = await readOutgoing({ path, allowedDirs: [workspace] });

  assert.equal(file.name, 'notes.md');
  assert.equal(file.bytes, 10);
  assert.equal(file.sha256, sha256('hello peer'));
  assert.equal(Buffer.from(file.content, 'base64').toString('utf8'), 'hello peer');
});

test('a file outside the allowlist is refused', async () => {
  const { readOutgoing } = await import('../src/transfer.js');
  const outside = await mkdtemp(join(tmpdir(), 'dsh-peer-outside-'));
  test.after(() => rm(outside, { recursive: true, force: true }));
  const path = join(outside, 'secret.txt');
  await writeFile(path, 'no', 'utf8');

  await assert.rejects(
    () => readOutgoing({ path, allowedDirs: [workspace] }),
    (error) => error.code === 'path-not-allowed',
  );
});

test('a file over the size limit is refused before it is read', async () => {
  const { readOutgoing } = await import('../src/transfer.js');
  const path = join(workspace, 'big.bin');
  await writeFile(path, Buffer.alloc(64 * 1024, 7));

  await assert.rejects(
    () => readOutgoing({ path, allowedDirs: [workspace], maxBytes: 1024 }),
    (error) => error.code === 'file-too-large',
  );
});

test('a missing file is refused with its own code', async () => {
  const { readOutgoing } = await import('../src/transfer.js');

  await assert.rejects(
    () => readOutgoing({ path: join(workspace, 'nope.txt'), allowedDirs: [workspace] }),
    (error) => error.code === 'file-missing',
  );
});

test('an incoming file lands in staging, never at a caller-chosen path', async () => {
  const { stageIncoming } = await import('../src/transfer.js');
  const content = 'from the peer';

  const staged = await stageIncoming({
    name: 'report.md',
    content: Buffer.from(content, 'utf8').toString('base64'),
    sha256: sha256(content),
    stagingDir: staging,
  });

  assert.equal(await readFile(staged.path, 'utf8'), content);
  assert.equal(staged.name, 'report.md');
  assert.equal(staged.sha256, sha256(content));
});

test('a name trying to escape staging is reduced to a safe basename', async () => {
  const { stageIncoming } = await import('../src/transfer.js');
  const content = 'traversal';
  const escapeTarget = join(workspace, 'escaped.txt');

  const staged = await stageIncoming({
    name: '..\\..\\escaped.txt',
    content: Buffer.from(content, 'utf8').toString('base64'),
    sha256: sha256(content),
    stagingDir: staging,
  });

  assert.equal(staged.name, 'escaped.txt');
  assert.equal(staged.path, join(staging, 'escaped.txt'));
  await assert.rejects(() => stat(escapeTarget), 'nothing may be written outside staging');
});

test('a name with a drive letter or absolute path is also reduced', async () => {
  const { stageIncoming } = await import('../src/transfer.js');
  const content = 'absolute';

  const staged = await stageIncoming({
    name: 'C:\\Windows\\System32\\evil.dll',
    content: Buffer.from(content, 'utf8').toString('base64'),
    sha256: sha256(content),
    stagingDir: staging,
  });

  assert.equal(staged.path, join(staging, 'evil.dll'));
});

test('a hash mismatch is refused and leaves nothing behind', async () => {
  const { stageIncoming } = await import('../src/transfer.js');

  await assert.rejects(
    () =>
      stageIncoming({
        name: 'tampered.bin',
        content: Buffer.from('actual', 'utf8').toString('base64'),
        sha256: sha256('claimed'),
        stagingDir: staging,
      }),
    (error) => error.code === 'hash-mismatch',
  );
  await assert.rejects(() => stat(join(staging, 'tampered.bin')));
});

test('an oversized incoming file is refused before it is written', async () => {
  const { stageIncoming } = await import('../src/transfer.js');
  const content = 'x'.repeat(4096);

  await assert.rejects(
    () =>
      stageIncoming({
        name: 'toobig.bin',
        content: Buffer.from(content, 'utf8').toString('base64'),
        sha256: sha256(content),
        stagingDir: staging,
        maxBytes: 1024,
      }),
    (error) => error.code === 'file-too-large',
  );
});

test('an incoming file never overwrites an existing one', async () => {
  const { stageIncoming } = await import('../src/transfer.js');
  const content = 'second';
  await writeFile(join(staging, 'same.txt'), 'first', 'utf8');

  const staged = await stageIncoming({
    name: 'same.txt',
    content: Buffer.from(content, 'utf8').toString('base64'),
    sha256: sha256(content),
    stagingDir: staging,
  });

  assert.notEqual(staged.path, join(staging, 'same.txt'));
  assert.equal(await readFile(join(staging, 'same.txt'), 'utf8'), 'first');
  assert.equal(await readFile(staged.path, 'utf8'), content);
});
