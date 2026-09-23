import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createPeerService } from '../src/service.js';
import { createRelayServer } from '../src/relay/server.js';

/**
 * Driving a relay-paired worker end to end, with the real MCP client the host
 * would use.
 *
 * The chain under test: MCP client → the initiator's loopback proxy → the
 * relay (which must only ever see ciphertext) → the worker's replay against
 * its own loopback adapter → the executor → all the way back. If any seal,
 * header or body handling is wrong anywhere in that chain, the tool call
 * fails here.
 */

const homes = [];
const newHome = async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peer-relay-e2e-'));
  homes.push(home);
  return home;
};
test.after(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

const asked = [];
const fakeExecutor = {
  async ask({ prompt, cwd }) {
    asked.push({ prompt, cwd });
    return { answer: `did: ${prompt}`, stderr: '', exitCode: 0, timedOut: false };
  },
};

const makeRelayService = async ({ home, name, deviceId, relayUrl, executor, allowedDirs }) =>
  await createPeerService({
    home,
    deviceName: name,
    executor,
    allowedDirs,
    listen: false,
    relay: { url: relayUrl, deviceId, enabled: true },
    log: () => {},
  });

test('an initiator drives a worker through the relay with the real MCP client', async () => {
  const relay = await createRelayServer({ log: () => {} });
  try {
    const worker = await makeRelayService({
      home: await newHome(),
      name: 'worker',
      deviceId: 'worker-id',
      relayUrl: relay.url,
      executor: fakeExecutor,
      allowedDirs: [tmpdir()],
    });
    const initiator = await makeRelayService({
      home: await newHome(),
      name: 'desk',
      deviceId: 'desk-id',
      relayUrl: relay.url,
      executor: fakeExecutor,
      allowedDirs: [tmpdir()],
    });

    let endpoint;
    let client;
    try {
      const ticket = await worker.createTicket();
      const outcome = await initiator.pair({ link: ticket.link });
      assert.equal(outcome.ok, true, JSON.stringify(outcome));

      // The initiator hands out a loopback endpoint that hides the relay hop.
      endpoint = await initiator.openRelayEndpoint('desk');
      assert.ok(endpoint.url.startsWith('http://127.0.0.1:'), `the endpoint must be loopback, got ${endpoint.url}`);
      assert.match(endpoint.authorization, /^Bearer /u);

      client = new Client({ name: 'relay-e2e', version: '1.0.0' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(`${endpoint.url}`), {
        requestInit: { headers: { authorization: endpoint.authorization } },
      });
      await client.connect(transport);

      const result = await client.callTool({ name: 'ask', arguments: { prompt: 'list files', cwd: tmpdir() } });
      assert.ok(result.isError !== true, JSON.stringify(result));
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.answer, 'did: list files');
      assert.deepEqual(asked.map((entry) => entry.prompt), ['list files'], 'the worker ran exactly the task');
    } finally {
      await client?.close().catch(() => {});
      await endpoint?.close().catch(() => {});
      await worker.stop();
      await initiator.stop();
    }
  } finally {
    await relay.close();
  }
});

test('a wrong credential through the relay is refused, not served', async () => {
  const relay = await createRelayServer({ log: () => {} });
  try {
    const worker = await makeRelayService({
      home: await newHome(),
      name: 'worker',
      deviceId: 'worker-id',
      relayUrl: relay.url,
      executor: fakeExecutor,
    });
    const initiator = await makeRelayService({
      home: await newHome(),
      name: 'desk',
      deviceId: 'desk-id',
      relayUrl: relay.url,
      executor: fakeExecutor,
    });

    let endpoint;
    let client;
    const executedBefore = asked.length;
    try {
      const ticket = await worker.createTicket();
      await initiator.pair({ link: ticket.link });

      endpoint = await initiator.openRelayEndpoint('desk');
      client = new Client({ name: 'relay-e2e-bad', version: '1.0.0' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(`${endpoint.url}`), {
        requestInit: { headers: { authorization: 'Bearer definitely-not-the-credential' } },
      });

      // The worker's own adapter refuses the credential through the relay
      // exactly as it would directly: the handshake itself is rejected, so no
      // task ever runs.
      await assert.rejects(() => client.connect(transport), /unauthorized|401/iu);
      assert.equal(asked.length, executedBefore, 'nothing executed');
    } finally {
      await client?.close().catch(() => {});
      await endpoint?.close().catch(() => {});
      await worker.stop();
      await initiator.stop();
    }
  } finally {
    await relay.close();
  }
});
