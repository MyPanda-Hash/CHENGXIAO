import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAdapter, PAIR_PATH } from '../src/server.js';
import { createVerifier } from '../src/auth.js';
import { openTrustStore } from '../src/trust.js';
import { openPairingStore } from '../src/pairing.js';
import { handlePair } from '../src/handshake.js';
import { openInitiatorStore } from '../src/initiator.js';
import { pairWith, parsePairLink } from '../src/pair-client.js';

/**
 * The initiating side of pairing: the machine that wants a peer to work for it.
 *
 * Its store holds the credentials it was granted. Those are secrets belonging
 * to another machine, so the same rule applies as on the worker side — a copy of
 * the file must not be a usable credential, which means no plaintext on disk
 * unless the caller explicitly asks to keep one.
 */

const homes = [];
const newHome = async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peer-init-'));
  homes.push(home);
  return home;
};
test.after(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

test('a pair link is parsed into an address and a code', async () => {
  const parsed = parsePairLink('dshp://192.168.1.20:7331/C7K2M-9QWMP');

  assert.equal(parsed.address, '192.168.1.20:7331');
  assert.equal(parsed.code, 'C7K2M-9QWMP');
  assert.equal(parsed.origin, 'http://192.168.1.20:7331');
});

test('a malformed link is refused with a reason instead of a guess', async () => {
  const cases = [
    ['', 'link-malformed'],
    ['not-a-link', 'link-malformed'],
    ['http://192.168.1.20:7331/C7K2M-9QWMP', 'link-scheme'],
    ['dshp://192.168.1.20:7331/', 'link-code-missing'],
    ['dshp:///C7K2M-9QWMP', 'link-address-missing'],
  ];

  for (const [link, code] of cases) {
    assert.throws(
      () => parsePairLink(link),
      (error) => error.code === code,
      `${link || '(empty)'} should fail with ${code}`,
    );
  }
});

test('a fresh initiator store has an identity and no peers', async () => {
  const store = await openInitiatorStore({ home: await newHome() });

  assert.equal(typeof store.identity.deviceName, 'string');
  assert.ok(store.identity.deviceName.length > 0, 'the device needs a label to present');
  assert.ok(store.identity.publicKey.length >= 32, 'the device needs a stable identity to present');
  assert.deepEqual(store.listPeers(), []);
});

test('a paired worker is remembered with its credential, and the file holds no plaintext', async () => {
  const home = await newHome();
  const store = await openInitiatorStore({ home });

  const saved = await store.addPeer({
    credential: 'cred-abc-123',
    address: '192.168.1.20:7331',
    workerInstallId: 'install-1',
    name: 'srv-b',
  });

  assert.equal(saved.name, 'srv-b');
  assert.equal(store.identify('srv-b').credential, 'cred-abc-123', 'the caller may read it back in memory');

  const onDisk = await readFile(join(home, 'dsh-peer', 'initiator.json'), 'utf8');
  assert.equal(onDisk.includes('cred-abc-123'), false, 'a copy of the file must not be a credential');
});

test('the credential survives a reopen, so a restart does not need re-pairing', async () => {
  const home = await newHome();
  const first = await openInitiatorStore({ home });
  await first.addPeer({ credential: 'cred-xyz', address: '10.0.0.5:7331', name: 'srv-a' });

  const second = await openInitiatorStore({ home });

  assert.equal(second.identify('srv-a').credential, 'cred-xyz');
  assert.equal(second.identity.publicKey, first.identity.publicKey, 'the device identity must be stable');
});

test('removing a worker forgets its credential', async () => {
  const home = await newHome();
  const store = await openInitiatorStore({ home });
  const saved = await store.addPeer({ credential: 'c1', address: '10.0.0.5:7331', name: 'srv-a' });

  await store.removePeer(saved.id);

  assert.deepEqual(store.listPeers(), []);
  assert.equal(store.identify('srv-a'), undefined);
  const reopened = await openInitiatorStore({ home });
  assert.equal(reopened.identify('srv-a'), undefined, 'removal must survive a restart');
});

test('a corrupt initiator file is refused rather than silently reset', async () => {
  const home = await newHome();
  const dir = join(home, 'dsh-peer');
  await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
  await (await import('node:fs/promises')).writeFile(join(dir, 'initiator.json'), '{ broken', 'utf8');

  await assert.rejects(
    () => openInitiatorStore({ home }),
    (error) => error.code === 'initiator-unreadable',
  );
});

/** Start a real worker Adapter that accepts pairing, and return its origin. */
async function startWorker() {
  const home = await newHome();
  const trust = await openTrustStore({ home });
  const pairing = await openPairingStore({ home });
  const adapter = await startAdapter({
    verifier: createVerifier({ trust }),
    executor: { ask: async () => ({ answer: 'ok', stderr: '', exitCode: 0, timedOut: false }) },
    stagingDir: join(home, 'staging'),
    allowedDirs: [home],
    port: 0,
    pairEndpoint: async ({ req, res }) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const answer = await handlePair({
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        address: `127.0.0.1:${String(adapter.port)}`,
        trust,
        pairing,
      });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    },
  });
  return { adapter, trust, pairing, origin: `http://127.0.0.1:${String(adapter.port)}` };
}

test('pairing over the wire yields a credential the worker will honour', async () => {
  const { adapter, trust, pairing, origin } = await startWorker();
  const store = await openInitiatorStore({ home: await newHome() });

  try {
    const ticket = await pairing.create({ address: '127.0.0.1', policy: { preset: 'workspace-write' } });
    const linked = parsePairLink(`dshp://127.0.0.1:${String(adapter.port)}/${ticket.code}`);

    const result = await pairWith({
      link: linked,
      deviceName: 'my-desk',
      identity: store.identity,
      store,
    });

    assert.equal(result.ok, true);
    assert.equal(result.peer.name, 'my-desk');

    const saved = store.identify('my-desk');
    assert.ok(saved.credential.length >= 32);
    assert.equal(trust.identify(saved.credential)?.policy.preset, 'workspace-write');
  } finally {
    await adapter.close();
  }
});

test('a wrong code comes back as a refusal, and nothing is saved', async () => {
  const { adapter, origin } = await startWorker();
  const store = await openInitiatorStore({ home: await newHome() });

  try {
    const result = await pairWith({
      link: parsePairLink(`dshp://127.0.0.1:${String(adapter.port)}/AAAAA-BBBBB`),
      deviceName: 'my-desk',
      identity: store.identity,
      store,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'code-not-found');
    assert.deepEqual(store.listPeers(), [], 'a refused pairing must leave nothing behind');
  } finally {
    await adapter.close();
  }
});

test('an unreachable worker is reported, not thrown as a raw network error', async () => {
  const store = await openInitiatorStore({ home: await newHome() });

  const result = await pairWith({
    // Port 1 on loopback: reliably closed, and never a real DSH.
    link: parsePairLink('dshp://127.0.0.1:1/AAAAA-BBBBB'),
    deviceName: 'my-desk',
    identity: store.identity,
    store,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'worker-unreachable');
  assert.ok(result.detail.length > 0, 'the operator needs something to act on');
});

test('an unreachable worker names the causes the operator can actually check', async () => {
  const store = await openInitiatorStore({ home: await newHome() });

  const result = await pairWith({
    link: parsePairLink('dshp://127.0.0.1:1/AAAAA-BBBBB'),
    deviceName: 'my-desk',
    identity: store.identity,
    store,
  });

  // "fetch failed" is what the operator used to get, and it says nothing about
  // what to do next. The realistic causes are all locally checkable, so the
  // detail has to name them in the order worth trying, and still carry the
  // underlying error for the case where none of them is it.
  assert.equal(result.ok, false);
  assert.equal(result.code, 'worker-unreachable');
  assert.match(result.detail, /127\.0\.0\.1:1/u, 'the failing address must appear');
  assert.match(result.detail, /listen/u, 'the listener being off is the first thing to check');
  assert.match(result.detail, /端口/u, 'the advice must say to look at a port');
  assert.match(result.detail, /防火墙/u, 'the firewall is the second thing to check');
  assert.match(result.detail, /配对码/u, 'a stale address is cured by re-issuing a code');
  // The port is configurable and this link names port 1, so advice that talks
  // about the default 7331 would send the operator to inspect the wrong port.
  assert.ok(
    result.detail.includes('7331') === false,
    'the advice must not name the default port when the link names another'
  );
  assert.match(result.detail, /fetch|ECONN|connect/u, 'the underlying error is preserved');
});

test('unreachable advice names the port from the link rather than a fixed default', async () => {
  const store = await openInitiatorStore({ home: await newHome() });

  // Rejecting at the fetch boundary keeps this about the message and not about
  // whether some port happens to be free on this machine.
  const refusingFetch = () => Promise.reject(new Error('fetch failed'));

  const result = await pairWith({
    link: parsePairLink('dshp://127.0.0.1:7999/AAAAA-BBBBB'),
    deviceName: 'my-desk',
    identity: store.identity,
    store,
    fetchImpl: refusingFetch,
  });

  assert.equal(result.code, 'worker-unreachable');
  assert.match(result.detail, /7999/u, 'the port to inspect must come from the link');
  assert.ok(result.detail.includes('7331') === false, 'the default port is not this link’s port');
});

test('a worker that never answers is a timeout, distinct from a refused connection', async () => {
  const store = await openInitiatorStore({ home: await newHome() });

  // Stands in for the network boundary only: it hangs exactly like a port with
  // nobody behind it, and honours the real signal the caller's AbortController
  // fires, so the timer under test is the timer in pairWith rather than a fake.
  const hangingFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });

  const result = await pairWith({
    link: parsePairLink('dshp://127.0.0.1:9/AAAAA-BBBBB'),
    deviceName: 'my-desk',
    identity: store.identity,
    store,
    timeoutMs: 25,
    fetchImpl: hangingFetch,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'pairing-timeout', 'a hang must not be reported as unreachable');
  assert.match(result.detail, /127\.0\.0\.1:9/u);
  assert.match(result.detail, /25/u, 'the window that elapsed must be stated');
  // A hang is not evidence that the address is good. On Windows a firewall that
  // drops, and a port with nothing behind it, both look exactly like this — no
  // RST, no answer. Silently concluding the address must be fine would be false
  // in the most common case, so the text has to say so out loud rather than
  // merely avoid the claim.
  assert.match(
    result.detail,
    /不代表.{0,12}地址是正确的|不代表.{0,12}地址是对的|silence.{0,20}not.{0,20}address/u,
    'a hang must warn that silence does not prove the address is right'
  );
  assert.match(result.detail, /listen|监听/u, 'a silent port may simply have no listener');
  assert.match(result.detail, /防火墙|firewall/u, 'a silent port may be the firewall dropping');
  assert.match(result.detail, /重试|retry/u, 'a busy machine is still worth retrying');
  assert.deepEqual(store.listPeers(), [], 'a timed-out pairing must leave nothing behind');
});

test('re-pairing the same worker replaces its credential instead of duplicating the entry', async () => {
  const { adapter, pairing } = await startWorker();
  const store = await openInitiatorStore({ home: await newHome() });

  try {
    const first = await pairing.create({ address: '127.0.0.1' });
    await pairWith({
      link: parsePairLink(`dshp://127.0.0.1:${String(adapter.port)}/${first.code}`),
      deviceName: 'my-desk',
      identity: store.identity,
      store,
    });
    const original = store.identify('my-desk').credential;

    const second = await pairing.create({ address: '127.0.0.1' });
    const again = await pairWith({
      link: parsePairLink(`dshp://127.0.0.1:${String(adapter.port)}/${second.code}`),
      deviceName: 'my-desk',
      identity: store.identity,
      store,
    });

    assert.equal(again.ok, true);
    assert.equal(store.listPeers().length, 1, 're-pairing must update, not multiply');
    assert.notEqual(store.identify('my-desk').credential, original);
  } finally {
    await adapter.close();
  }
});
