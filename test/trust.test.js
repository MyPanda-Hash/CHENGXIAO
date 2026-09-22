import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The trust store is the security spine of the plugin: it decides who may run
 * work on this machine. Everything here is about what must be impossible —
 * a key that is not stored, a revoked peer that still works, a file that
 * corrupts when two writers race.
 *
 * Keys are stored as hashes only. A stolen trust file must not hand an attacker
 * a working credential.
 */

const makeHome = async () => await mkdtemp(join(tmpdir(), 'dsh-peer-trust-'));
const homes = [];
test.after(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});
const newHome = async () => {
  const home = await makeHome();
  homes.push(home);
  return home;
};

test('a fresh store has an identity and no peers', async () => {
  const { openTrustStore } = await import('../src/trust.js');
  const store = await openTrustStore({ home: await newHome() });

  assert.match(store.identity.installId, /^[0-9a-f-]{36}$/u);
  assert.equal(store.identity.publicKey.length > 0, true);
  assert.deepEqual(store.listPeers(), []);
});

test('the identity survives a reopen', async () => {
  const { openTrustStore } = await import('../src/trust.js');
  const home = await newHome();
  const first = await openTrustStore({ home });
  const second = await openTrustStore({ home });

  assert.equal(second.identity.installId, first.identity.installId);
  assert.equal(second.identity.publicKey, first.identity.publicKey);
});

test('adding a peer returns its credential once and stores only a hash', async () => {
  const { openTrustStore } = await import('../src/trust.js');
  const home = await newHome();
  const store = await openTrustStore({ home });

  const { credential, peer } = await store.addPeer({
    name: 'desk-pc',
    publicKey: 'PUBKEY-abc',
    policy: { preset: 'workspace-write' },
  });

  assert.ok(credential.length >= 32, 'the credential must be long enough to be a secret');
  assert.equal(peer.name, 'desk-pc');
  assert.equal(peer.revokedAt, undefined);
  assert.deepEqual(peer.policy, { preset: 'workspace-write' });

  const onDisk = await readFile(join(home, 'dsh-peer', 'trust.json'), 'utf8');
  assert.equal(onDisk.includes(credential), false, 'the raw credential must never be written');
  assert.match(onDisk, /[0-9a-f]{64}/u, 'the store must hold a sha256 of the credential');
});

test('a stored credential identifies its peer, and nothing else does', async () => {
  const { openTrustStore } = await import('../src/trust.js');
  const store = await openTrustStore({ home: await newHome() });
  const { credential, peer } = await store.addPeer({ name: 'srv', publicKey: 'PUBKEY-1' });

  assert.equal(store.identify(credential)?.id, peer.id);
  assert.equal(store.identify('not-the-credential'), undefined);
  assert.equal(store.identify(credential.slice(0, -1)), undefined);
  assert.equal(store.identify(''), undefined);
  assert.equal(store.identify(undefined), undefined);
});

test('a revoked peer stops being identified, and the record stays for audit', async () => {
  const { openTrustStore } = await import('../src/trust.js');
  const store = await openTrustStore({ home: await newHome() });
  const { credential, peer } = await store.addPeer({ name: 'srv', publicKey: 'PUBKEY-1' });

  await store.revokePeer(peer.id);

  assert.equal(store.identify(credential), undefined, 'a revoked credential must not authenticate');
  const listed = store.listPeers().find((entry) => entry.id === peer.id);
  assert.ok(listed, 'the record must remain so the revocation is visible');
  assert.ok(listed.revokedAt, 'the revocation must be timestamped');
});

test('a self-signed claim cannot be trusted over the stored public key', async () => {
  const { openTrustStore } = await import('../src/trust.js');
  const store = await openTrustStore({ home: await newHome() });
  const { credential } = await store.addPeer({ name: 'srv', publicKey: 'PUBKEY-real' });

  // The credential is what authorises; a different public key must not upgrade
  // an existing peer, because that would let anyone re-identify as them.
  assert.throws(
    () => store.assertPublicKeyMatches(credential, 'PUBKEY-attacker'),
    (error) => error.code === 'public-key-mismatch',
  );
  assert.equal(store.assertPublicKeyMatches(credential, 'PUBKEY-real'), true);
});

test('the per-peer policy travels with the peer', async () => {
  const { openTrustStore } = await import('../src/trust.js');
  const home = await newHome();
  const store = await openTrustStore({ home });
  const { credential } = await store.addPeer({
    name: 'srv',
    publicKey: 'PUBKEY-1',
    policy: { preset: 'danger-full-access', allowedDirs: ['D:\\repos'] },
  });

  const reopened = await openTrustStore({ home });
  const peer = reopened.identify(credential);

  assert.deepEqual(peer.policy, { preset: 'danger-full-access', allowedDirs: ['D:\\repos'] });
});

test('two writers racing for the same peer id do not corrupt the file', async () => {
  const { openTrustStore } = await import('../src/trust.js');
  const home = await newHome();
  const store = await openTrustStore({ home });

  await Promise.all(
    Array.from({ length: 8 }, async (_, index) =>
      store.addPeer({ name: `peer-${String(index)}`, publicKey: `PUBKEY-${String(index)}` }),
    ),
  );

  const reopened = await openTrustStore({ home });
  assert.equal(reopened.listPeers().length, 8, 'every concurrent add must survive');
});

test('a corrupt trust file is refused instead of silently reset', async () => {
  const { openTrustStore } = await import('../src/trust.js');
  const home = await newHome();
  const dir = join(home, 'dsh-peer');
  await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'trust.json'), '{ this is not json', 'utf8');

  await assert.rejects(
    () => openTrustStore({ home }),
    (error) => error.code === 'trust-unreadable',
    'refusing beats resetting: resetting would silently drop every pairing',
  );
});

test('an unknown format version is refused rather than misread', async () => {
  const { openTrustStore } = await import('../src/trust.js');
  const home = await newHome();
  const dir = join(home, 'dsh-peer');
  await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'trust.json'),
    JSON.stringify({ version: 99, identity: { installId: 'x' }, peers: [] }),
    'utf8',
  );

  await assert.rejects(
    () => openTrustStore({ home }),
    (error) => error.code === 'trust-version-unsupported',
  );
});
