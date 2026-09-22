import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTrustStore } from '../src/trust.js';

/**
 * Who is calling, and what may they do.
 *
 * A single global key can only answer "may anyone call"; it cannot answer "may
 * *this* peer call, and within which directories". Those answers are what make
 * per-peer revocation and per-peer permission presets real, so identifying the
 * caller is part of authentication rather than a later lookup.
 */

const homes = [];
const newHome = async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peer-verify-'));
  homes.push(home);
  return home;
};
test.after(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });

test('a paired peer is identified by its credential, and carries its policy', async () => {
  const { createVerifier } = await import('../src/auth.js');
  const trust = await openTrustStore({ home: await newHome() });
  const { credential } = await trust.addPeer({
    name: 'srv',
    publicKey: 'PK-1',
    policy: { preset: 'danger-full-access', allowedDirs: ['D:\\repos'] },
  });
  const verify = createVerifier({ trust });

  const caller = verify(bearer(credential));

  assert.equal(caller.ok, true);
  assert.equal(caller.kind, 'peer');
  assert.equal(caller.peer.name, 'srv');
  assert.equal(caller.peer.policy.preset, 'danger-full-access');
  assert.deepEqual(caller.peer.policy.allowedDirs, ['D:\\repos']);
});

test('an unknown credential is refused', async () => {
  const { createVerifier } = await import('../src/auth.js');
  const trust = await openTrustStore({ home: await newHome() });
  const verify = createVerifier({ trust });

  const result = verify(bearer('not-a-credential'));

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('a revoked peer is refused even though its credential is unchanged', async () => {
  const { createVerifier } = await import('../src/auth.js');
  const trust = await openTrustStore({ home: await newHome() });
  const { credential, peer } = await trust.addPeer({ name: 'srv', publicKey: 'PK-1' });
  const verify = createVerifier({ trust });

  assert.equal(verify(bearer(credential)).ok, true);

  await trust.revokePeer(peer.id);

  const afterRevoke = verify(bearer(credential));
  assert.equal(afterRevoke.ok, false);
  assert.equal(afterRevoke.status, 401, 'revocation must take effect without a restart');
});

test('a legacy shared key still works, and is reported as legacy', async () => {
  const { createVerifier, createAuth } = await import('../src/auth.js');
  const trust = await openTrustStore({ home: await newHome() });
  const key = 'k'.repeat(43);
  const verify = createVerifier({ trust, legacyKey: key });

  const caller = verify(bearer(key));

  assert.equal(caller.ok, true);
  assert.equal(caller.kind, 'legacy');
  assert.equal(caller.peer, undefined, 'a shared key identifies no one, so it grants no per-peer policy');

  // The pre-existing verifier surface must keep working for the plain HTTP fence.
  assert.equal(createAuth({ key }).verifies(bearer(key)), true);
});

test('a legacy key that merely looks like a credential does not become a peer', async () => {
  const { createVerifier } = await import('../src/auth.js');
  const trust = await openTrustStore({ home: await newHome() });
  const key = 'k'.repeat(43);
  const verify = createVerifier({ trust, legacyKey: key });

  assert.equal(verify(bearer(key)).kind, 'legacy');
  assert.equal(verify(bearer(`${key}x`)).ok, false);
});

test('the verifier accepts no auth at all only when it is explicitly insecure', async () => {
  const { createVerifier } = await import('../src/auth.js');
  const trust = await openTrustStore({ home: await newHome() });

  assert.equal(createVerifier({ trust })({ headers: {} }).status, 401);
  assert.equal(createVerifier({ trust, insecure: true })({ headers: {} }).kind, 'insecure');
});

test('a present-but-wrong credential never falls back to insecure or legacy', async () => {
  const { createVerifier } = await import('../src/auth.js');
  const trust = await openTrustStore({ home: await newHome() });
  const verify = createVerifier({ trust, insecure: true, legacyKey: 'k'.repeat(43) });

  const result = verify(bearer('wrong'));

  assert.equal(result.ok, false, 'a wrong credential must fail loudly, not be waved through');
});
