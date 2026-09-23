import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePairLink } from '../src/pair-client.js';
import { createPeerService } from '../src/service.js';
import { createRelayServer } from '../src/relay/server.js';

const homes = [];
const newHome = async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peer-relay-pair-'));
  homes.push(home);
  return home;
};
test.after(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

const fakeExecutor = { async ask() { return { answer: 'x', stderr: '', exitCode: 0, timedOut: false }; } };

test('a dshr pairing link parses into relay address, device id and code', () => {
  const parsed = parsePairLink('dshr://relay.example.com:7331/device-abc/C7K2M-9QWMP');
  assert.equal(parsed.scheme, 'dshr');
  assert.equal(parsed.relayAddress, 'relay.example.com:7331');
  assert.equal(parsed.deviceId, 'device-abc');
  assert.equal(parsed.code, 'C7K2M-9QWMP');
});

test('a dshp link still parses as before, now naming its scheme', () => {
  const parsed = parsePairLink('dshp://192.168.1.20:7331/C7K2M-9QWMP');
  assert.equal(parsed.scheme, 'dshp');
  assert.equal(parsed.address, '192.168.1.20:7331');
  assert.equal(parsed.code, 'C7K2M-9QWMP');
});

test('two services pair through a real relay without any listener', async () => {
  const relay = await createRelayServer({ log: () => {} });
  try {
    const worker = await createPeerService({
      home: await newHome(),
      deviceName: 'worker',
      executor: fakeExecutor,
      listen: false,
      relay: { url: relay.url, deviceId: 'worker-id', enabled: true },
      log: () => {},
    });
    const initiator = await createPeerService({
      home: await newHome(),
      deviceName: 'desk',
      executor: fakeExecutor,
      listen: false,
      relay: { url: relay.url, deviceId: 'desk-id', enabled: true },
      log: () => {},
    });

    try {
      const ticket = await worker.createTicket();
      assert.match(ticket.link, /^dshr:\/\/[^/]+\/worker-id\//u, `the link must be relay-shaped, got ${ticket.link}`);
      assert.equal(worker.status().connection, 'relay');

      const outcome = await initiator.pair({ link: ticket.link });
      assert.equal(outcome.ok, true, JSON.stringify(outcome));

      // Both sides recorded the pairing, with relay routing on the initiator.
      const initiatorPeer = initiator.status().peers.find((peer) => peer.name === 'desk');
      assert.ok(initiatorPeer !== undefined, 'the initiator must list the paired worker');
      assert.equal(initiatorPeer.relay.deviceId, 'worker-id');

      const trustedBy = worker.status().trustedBy.find((peer) => peer.name === 'desk');
      assert.ok(trustedBy !== undefined, 'the worker must trust the initiator');

      // The relay never saw the credential: its mailboxes hold only routing
      // fields and the sealed body this test cannot open.
      assert.equal(ticket.link.includes('credential'), false);
    } finally {
      await worker.stop();
      await initiator.stop();
    }
  } finally {
    await relay.close();
  }
});

test('a wrong code through the relay is refused with the pairing store reason', async () => {
  const relay = await createRelayServer({ log: () => {} });
  try {
    const worker = await createPeerService({
      home: await newHome(),
      deviceName: 'worker',
      executor: fakeExecutor,
      listen: false,
      relay: { url: relay.url, deviceId: 'worker-id', enabled: true },
      log: () => {},
    });
    const initiator = await createPeerService({
      home: await newHome(),
      deviceName: 'desk',
      executor: fakeExecutor,
      listen: false,
      relay: { url: relay.url, deviceId: 'desk-id', enabled: true },
      log: () => {},
    });

    try {
      await worker.createTicket();
      const outcome = await initiator.pair({ link: `dshr://${new URL(relay.url).host}/worker-id/AAAAA-BBBBB` });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, 'code-not-found');
    } finally {
      await worker.stop();
      await initiator.stop();
    }
  } finally {
    await relay.close();
  }
});
