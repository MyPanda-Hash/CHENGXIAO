import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Pairing codes are the one moment a stranger can become a peer, so the rules
 * matter more here than anywhere else: a code is single-use, short-lived, and
 * useless once spent. Everything in this file is a way for pairing to be
 * refused.
 */

const homes = [];
const newHome = async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peer-pair-'));
  homes.push(home);
  return home;
};
test.after(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

const clock = (iso) => () => new Date(iso);

test('a fresh store offers no pairing codes', async () => {
  const { openPairingStore } = await import('../src/pairing.js');
  const store = await openPairingStore({ home: await newHome() });

  assert.deepEqual(store.listPending(), []);
});

test('a created code is readable, formatted for humans, and short-lived', async () => {
  const { openPairingStore, DEFAULT_CODE_TTL_MS } = await import('../src/pairing.js');
  const store = await openPairingStore({ home: await newHome() });

  const ticket = await store.create({ address: '192.168.1.20:7331' });

  assert.match(ticket.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/u, 'a code must be typeable by a human');
  assert.equal(ticket.address, '192.168.1.20:7331');
  assert.ok(ticket.expiresAt);
  assert.equal(
    new Date(ticket.expiresAt).getTime() - new Date(ticket.createdAt).getTime(),
    DEFAULT_CODE_TTL_MS,
  );
  assert.match(ticket.link, /^dshp:\/\/192\.168\.1\.20:7331\/[A-Z2-9]{5}-[A-Z2-9]{5}$/u);
});

test('a code stops working the moment it is spent', async () => {
  const { openPairingStore } = await import('../src/pairing.js');
  const store = await openPairingStore({ home: await newHome() });
  const ticket = await store.create({ address: '10.0.0.5:7331' });

  const first = await store.consume(ticket.code, { name: 'desk', publicKey: 'PK-1' });
  assert.equal(first.ok, true);

  await assert.rejects(
    () => store.consume(ticket.code, { name: 'attacker', publicKey: 'PK-2' }),
    (error) => error.code === 'code-not-pending',
    'a spent code must never pair a second machine',
  );
});

test('an expired code is refused and swept away', async () => {
  const { openPairingStore } = await import('../src/pairing.js');
  const home = await newHome();
  const issued = new Date('2026-01-01T00:00:00.000Z');
  const store = await openPairingStore({ home, now: clock(issued.toISOString()) });
  const ticket = await store.create({ address: '10.0.0.5:7331', ttlMs: 60_000 });

  const later = await openPairingStore({
    home,
    now: clock(new Date(issued.getTime() + 61_000).toISOString()),
  });

  assert.deepEqual(later.listPending(), [], 'an expired code must not stay visible');
  await assert.rejects(
    () => later.consume(ticket.code, { name: 'desk', publicKey: 'PK-1' }),
    (error) => error.code === 'code-not-found',
  );
});

test('an unknown code is refused without revealing that it is unknown', async () => {
  const { openPairingStore } = await import('../src/pairing.js');
  const store = await openPairingStore({ home: await newHome() });

  await assert.rejects(
    () => store.consume('AAAAA-BBBBB', { name: 'x', publicKey: 'PK' }),
    (error) => error.code === 'code-not-found',
  );
});

test('codes are compared after normalisation, so typing is forgiving but not careless', async () => {
  const { openPairingStore } = await import('../src/pairing.js');
  const store = await openPairingStore({ home: await newHome() });
  const ticket = await store.create({ address: '10.0.0.5:7331' });

  const messy = ticket.code.toLowerCase().replace('-', ' ');
  const paired = await store.consume(messy, { name: 'desk', publicKey: 'PK-1' });

  assert.equal(paired.ok, true);
  assert.equal(paired.address, '10.0.0.5:7331');
});

test('the raw code is never written to disk', async () => {
  const { openPairingStore } = await import('../src/pairing.js');
  const home = await newHome();
  const store = await openPairingStore({ home });
  const ticket = await store.create({ address: '10.0.0.5:7331' });

  const onDisk = await readFile(join(home, 'dsh-peer', 'pairing.json'), 'utf8');

  assert.equal(onDisk.includes(ticket.code), false);
  assert.match(onDisk, /[0-9a-f]{64}/u, 'the store must hold a sha256 of the code');
});

test('creating a second code invalidates the first', async () => {
  const { openPairingStore } = await import('../src/pairing.js');
  const store = await openPairingStore({ home: await newHome() });

  const first = await store.create({ address: '10.0.0.5:7331' });
  const second = await store.create({ address: '10.0.0.5:7331' });

  assert.equal(store.listPending().length, 1, 'only one code may be live at a time');
  await assert.rejects(
    () => store.consume(first.code, { name: 'desk', publicKey: 'PK-1' }),
    (error) => error.code === 'code-not-found',
    'a superseded code must stop working immediately',
  );
  assert.equal(second.code.length, 11);
});

test('listing pending codes never reveals the secret', async () => {
  const { openPairingStore } = await import('../src/pairing.js');
  const store = await openPairingStore({ home: await newHome() });
  const ticket = await store.create({ address: '10.0.0.5:7331' });

  const [listed] = store.listPending();

  // `scheme` is routing metadata (dshp vs dshr), not a secret; the code and
  // its hash must remain the only things a listing never carries.
  assert.deepEqual(Object.keys(listed).sort(), ['address', 'createdAt', 'expiresAt', 'id', 'link', 'scheme']);
  assert.equal(JSON.stringify(listed).includes(ticket.code), false, 'the secret lives only in the create() result');
  assert.match(listed.link, /^dshp:\/\/10\.0\.0\.5:7331\/(?:•+)?$/u, 'a listing may show the address but not the code');
});
