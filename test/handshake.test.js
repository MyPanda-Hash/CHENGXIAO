import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTrustStore } from '../src/trust.js';
import { openPairingStore } from '../src/pairing.js';

/**
 * The pairing handshake is the single point where a stranger becomes a peer.
 * Every case here either completes a legitimate pairing or refuses one, and the
 * refusals are what matter: wrong code, spent code, expired code, malformed
 * claim, and a peer trying to claim a policy it was not granted.
 */

const homes = [];
const newStores = async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peer-handshake-'));
  homes.push(home);
  return {
    trust: await openTrustStore({ home }),
    pairing: await openPairingStore({ home }),
  };
};
test.after(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

const ADDRESS = '192.168.1.20:7331';

test('a valid code plus a well-formed claim pairs the machines', async () => {
  const { handlePair } = await import('../src/handshake.js');
  const { trust, pairing } = await newStores();
  const ticket = await pairing.create({ address: ADDRESS });

  const result = await handlePair({
    body: { code: ticket.code, name: 'desk-pc', publicKey: 'PK-desk' },
    address: ADDRESS,
    trust,
    pairing,
  });

  assert.equal(result.status, 201);
  assert.ok(result.body.credential.length >= 32, 'the peer must receive a usable credential');
  assert.equal(result.body.peer.name, 'desk-pc');
  assert.equal(result.body.peer.policy.preset, 'workspace-write', 'the default must be the narrow preset');
  assert.equal(result.body.worker.address, ADDRESS);
  assert.equal(result.body.worker.installId, trust.identity.installId);

  // The credential handed out must actually work against the trust store.
  assert.equal(trust.identify(result.body.credential)?.name, 'desk-pc');
});

test('a wrong code is refused and pairs nobody', async () => {
  const { handlePair } = await import('../src/handshake.js');
  const { trust, pairing } = await newStores();
  await pairing.create({ address: ADDRESS });

  const result = await handlePair({
    body: { code: 'AAAAA-BBBBB', name: 'attacker', publicKey: 'PK-bad' },
    address: ADDRESS,
    trust,
    pairing,
  });

  assert.equal(result.status, 403);
  assert.equal(result.body.ok, false);
  assert.deepEqual(trust.listPeers(), [], 'a failed handshake must not create a peer record');
});

test('a spent code cannot pair a second machine', async () => {
  const { handlePair } = await import('../src/handshake.js');
  const { trust, pairing } = await newStores();
  const ticket = await pairing.create({ address: ADDRESS });
  const claim = { code: ticket.code, name: 'first', publicKey: 'PK-1' };

  const first = await handlePair({ body: claim, address: ADDRESS, trust, pairing });
  const replay = await handlePair({
    body: { ...claim, name: 'second', publicKey: 'PK-2' },
    address: ADDRESS,
    trust,
    pairing,
  });

  assert.equal(first.status, 201);
  assert.equal(replay.status, 403);
  assert.equal(trust.listPeers().length, 1, 'the replay must not add a second peer');
});

test('a malformed claim is refused before the code is touched', async () => {
  const { handlePair } = await import('../src/handshake.js');
  const { trust, pairing } = await newStores();
  const ticket = await pairing.create({ address: ADDRESS });

  const cases = [
    { label: 'no name', body: { code: ticket.code, publicKey: 'PK' } },
    { label: 'blank name', body: { code: ticket.code, name: '   ', publicKey: 'PK' } },
    { label: 'no public key', body: { code: ticket.code, name: 'desk' } },
    { label: 'no code', body: { name: 'desk', publicKey: 'PK' } },
    { label: 'oversized name', body: { code: ticket.code, name: 'x'.repeat(200), publicKey: 'PK' } },
    { label: 'oversized key', body: { code: ticket.code, name: 'desk', publicKey: 'k'.repeat(2000) } },
  ];

  for (const { label, body } of cases) {
    const result = await handlePair({ body, address: ADDRESS, trust, pairing });
    assert.equal(result.status, 400, `${label} must be a bad request`);
  }

  // The code must still be usable: a malformed attempt must not burn it.
  const good = await handlePair({
    body: { code: ticket.code, name: 'desk', publicKey: 'PK' },
    address: ADDRESS,
    trust,
    pairing,
  });
  assert.equal(good.status, 201, 'a malformed attempt must not consume the live code');
});

test('a peer cannot grant itself a wider permission preset', async () => {
  const { handlePair } = await import('../src/handshake.js');
  const { trust, pairing } = await newStores();
  const ticket = await pairing.create({ address: ADDRESS });

  const result = await handlePair({
    body: {
      code: ticket.code,
      name: 'greedy',
      publicKey: 'PK-1',
      policy: { preset: 'danger-full-access' },
    },
    address: ADDRESS,
    trust,
    pairing,
  });

  assert.equal(result.body.peer.policy.preset, 'workspace-write');
  assert.equal(
    trust.identify(result.body.credential)?.policy.preset,
    'workspace-write',
    'the claimant must not choose its own privilege level',
  );
});

test('the operator may grant a wider preset when issuing the code', async () => {
  const { handlePair } = await import('../src/handshake.js');
  const { trust, pairing } = await newStores();
  const ticket = await pairing.create({
    address: ADDRESS,
    policy: { preset: 'danger-full-access', allowedDirs: ['D:\\repos'] },
  });

  const result = await handlePair({
    body: { code: ticket.code, name: 'trusted', publicKey: 'PK-1' },
    address: ADDRESS,
    trust,
    pairing,
  });

  assert.equal(result.body.peer.policy.preset, 'danger-full-access');
  assert.deepEqual(trust.identify(result.body.credential)?.policy.allowedDirs, ['D:\\repos']);
});

test('repeated wrong codes are throttled instead of guessed forever', async () => {
  const { handlePair, createPairThrottle } = await import('../src/handshake.js');
  const { trust, pairing } = await newStores();
  await pairing.create({ address: ADDRESS });
  const throttle = createPairThrottle({ maxFailures: 3 });

  const attempt = async () =>
    await handlePair({
      body: { code: 'AAAAA-BBBBB', name: 'brute', publicKey: 'PK' },
      address: ADDRESS,
      source: '10.0.0.9:1234',
      trust,
      pairing,
      throttle,
    });

  assert.equal((await attempt()).status, 403);
  assert.equal((await attempt()).status, 403);
  assert.equal((await attempt()).status, 403);
  const fourth = await attempt();
  assert.equal(fourth.status, 429, 'the fourth guess from the same source must be throttled');
  assert.match(fourth.body.code, /throttled/u);
});

test('a successful pairing clears the failure count for that source', async () => {
  const { handlePair, createPairThrottle } = await import('../src/handshake.js');
  const { trust, pairing } = await newStores();
  const throttle = createPairThrottle({ maxFailures: 3 });
  const source = '10.0.0.9:1234';

  await handlePair({
    body: { code: 'AAAAA-BBBBB', name: 'x', publicKey: 'PK' },
    address: ADDRESS,
    source,
    trust,
    pairing,
    throttle,
  });
  await handlePair({
    body: { code: 'AAAAA-CCCCC', name: 'x', publicKey: 'PK' },
    address: ADDRESS,
    source,
    trust,
    pairing,
    throttle,
  });
  assert.equal(throttle.failuresFor(source), 2);

  const ticket = await pairing.create({ address: ADDRESS });
  const ok = await handlePair({
    body: { code: ticket.code, name: 'desk', publicKey: 'PK' },
    address: ADDRESS,
    source,
    trust,
    pairing,
    throttle,
  });

  assert.equal(ok.status, 201);
  assert.equal(throttle.failuresFor(source), 0, 'a good pairing must reset the counter');
});

test('one noisy source cannot lock out another', async () => {
  const { handlePair, createPairThrottle } = await import('../src/handshake.js');
  const { trust, pairing } = await newStores();
  const throttle = createPairThrottle({ maxFailures: 2 });
  const noisy = '10.0.0.9:1234';
  const quiet = '10.0.0.10:5555';

  for (let index = 0; index < 3; index += 1) {
    await handlePair({
      body: { code: 'AAAAA-BBBBB', name: 'x', publicKey: 'PK' },
      address: ADDRESS,
      source: noisy,
      trust,
      pairing,
      throttle,
    });
  }

  const ticket = await pairing.create({ address: ADDRESS });
  const other = await handlePair({
    body: { code: ticket.code, name: 'desk', publicKey: 'PK' },
    address: ADDRESS,
    source: quiet,
    trust,
    pairing,
    throttle,
  });

  assert.equal(other.status, 201, 'throttling must be per source, not global');
});

test('the throttle is keyed by the caller, never by the worker\u2019s own address', async () => {
  const { handlePair, createPairThrottle } = await import('../src/handshake.js');
  const { trust, pairing } = await newStores();
  // Only two failures are allowed. `address` is the worker's own address and is
  // identical on every call, exactly as it is in the real service — so if the
  // throttle keys on it, the second caller is locked out by the first one's
  // mistakes, which is the global bucket the test above forbids.
  const throttle = createPairThrottle({ maxFailures: 2 });

  for (let index = 0; index < 3; index += 1) {
    await handlePair({
      body: { code: 'AAAAA-BBBBB', name: 'x', publicKey: 'PK' },
      address: ADDRESS,
      source: '10.0.0.9:1234',
      trust,
      pairing,
      throttle,
    });
  }

  const ticket = await pairing.create({ address: ADDRESS });
  const other = await handlePair({
    body: { code: ticket.code, name: 'desk', publicKey: 'PK' },
    address: ADDRESS,
    source: '10.0.0.10:5555',
    trust,
    pairing,
    throttle,
  });

  assert.equal(
    other.status,
    201,
    'a second machine must not inherit the first machine\u2019s failures',
  );
});
