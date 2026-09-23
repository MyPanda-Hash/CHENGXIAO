import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createPeerService } from '../src/service.js';

/**
 * One machine's peer service, in both roles at once.
 *
 * A machine may hand out work *and* drive someone else's, so the service owns
 * both directions. What matters is that the two roles stay independent: the
 * listener is the only inbound surface and can be off entirely, while pairing
 * outward works without it.
 *
 * These tests run two real services against each other over real HTTP.
 */

const homes = [];
const newHome = async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peer-service-'));
  homes.push(home);
  return home;
};
test.after(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

const quietLog = () => {};

/** A task runner that never spends tokens. */
const fakeExecutor = {
  asked: [],
  async ask({ prompt, cwd }) {
    fakeExecutor.asked.push({ prompt, cwd });
    return { answer: `did: ${prompt}`, stderr: '', exitCode: 0, timedOut: false };
  },
};

/** Build a service in the worker role, listening on a free port. */
async function makeWorker({ home, allowedDirs }) {
  return await createPeerService({
    home,
    deviceName: 'worker',
    allowedDirs,
    executor: fakeExecutor,
    listen: true,
    host: '127.0.0.1',
    port: 0,
    log: quietLog,
  });
}

test('the inbound listener is off unless it is asked for', async () => {
  const service = await createPeerService({
    home: await newHome(),
    deviceName: 'desk',
    executor: fakeExecutor,
    listen: false,
    log: quietLog,
  });

  assert.equal(service.status().listening, false);
  assert.equal(service.status().url, undefined, 'a closed listener must advertise no address');
  assert.equal(service.status().address, undefined, 'with no listener there is no address to hand out');
  await service.stop();
});

test('a worker issues a code tied to its own reachable address', async () => {
  const worker = await makeWorker({ home: await newHome(), allowedDirs: [tmpdir()] });
  try {
    const ticket = await worker.createTicket();

    assert.equal(worker.status().listening, true);
    assert.match(ticket.link, /^dshp:\/\/127\.0\.0\.1:\d+\/[A-Z2-9]{5}-[A-Z2-9]{5}$/u);
    assert.equal(worker.status().pending?.code === undefined, true, 'the status must not leak the code');
    assert.equal(worker.status().pending.address, worker.status().address);
  } finally {
    await worker.stop();
  }
});

test('a pinned address is what the pairing code advertises, not the automatic guess', async () => {
  // A machine holds several addresses at once — WSL, VMware, VPN adapters — and
  // picking between them is a guess. When the guess is wrong the code names an
  // address no peer can dial, and nothing about the failure says so. Hence the
  // pin. This uses host 0.0.0.0 deliberately: a loopback bind short-circuits to
  // 127.0.0.1 and would never reach the selection this test is about.
  const service = await createPeerService({
    home: await newHome(),
    deviceName: 'worker',
    allowedDirs: [tmpdir()],
    executor: fakeExecutor,
    listen: true,
    host: '0.0.0.0',
    port: 0,
    addresses: ['192.168.0.15'],
    log: quietLog,
  });

  try {
    const ticket = await service.createTicket();

    assert.match(
      ticket.address,
      /^192\.168\.0\.15:\d+$/u,
      `the pin must decide the advertised address, got ${ticket.address}`,
    );
    assert.match(ticket.link, /^dshp:\/\/192\.168\.0\.15:\d+\//u);
  } finally {
    await service.stop();
  }
});

test('the running service actually throttles wrong codes, not merely could', async () => {
  // The throttle is optional on handlePair, so a service that forgets to build
  // one answers wrong codes forever while every unit test of the throttle stays
  // green — the control exists and is tested, and is not in the path. Only
  // driving the live listener catches that.
  const worker = await makeWorker({ home: await newHome(), allowedDirs: [tmpdir()] });

  try {
    const origin = worker.status().url.replace(/\/mcp$/u, '');
    const attempt = async () =>
      await fetch(`${origin}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'AAAAA-BBBBB', name: 'brute', publicKey: 'PK' }),
      });

    const statuses = [];
    for (let index = 0; index < 8; index += 1) {
      statuses.push((await attempt()).status);
    }

    assert.ok(
      statuses.includes(429),
      `wrong codes must eventually be refused, got ${statuses.join(', ')}`,
    );
  } finally {
    await worker.stop();
  }
});

test('an address is chosen that a peer can actually dial', async () => {
  const { lanAddresses, chooseAdvertisedAddress } = await import('../src/service.js');

  // A machine like this one: a WSL and a VMware adapter ahead of the real NIC.
  const interfaces = {
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.29.144.1', internal: false }],
    'VMware Network Adapter VMnet8': [{ family: 'IPv4', address: '192.168.111.1', internal: false }],
    WLAN: [{ family: 'IPv4', address: '10.60.31.127', internal: false }],
    Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  };
  const networkInterfacesImpl = () => interfaces;

  const all = lanAddresses({ networkInterfacesImpl });
  assert.deepEqual(all, ['172.29.144.1', '192.168.111.1', '10.60.31.127'], 'loopback is never offered to a peer');

  assert.equal(
    chooseAdvertisedAddress({ bindHost: '127.0.0.1', networkInterfacesImpl }),
    '127.0.0.1',
    'a loopback listener must advertise loopback, or the peer would dial its own machine',
  );

  const chosen = chooseAdvertisedAddress({ bindHost: '0.0.0.0', networkInterfacesImpl });
  assert.equal(chosen, '10.60.31.127', 'virtual adapters must not win over a real network');
});

test('a machine with only virtual adapters still yields the best available address', async () => {
  const { chooseAdvertisedAddress } = await import('../src/service.js');

  const chosen = chooseAdvertisedAddress({
    bindHost: '0.0.0.0',
    networkInterfacesImpl: () => ({
      'vEthernet (WSL)': [{ family: 'IPv4', address: '172.29.144.1', internal: false }],
    }),
  });

  assert.equal(chosen, '172.29.144.1', 'a poor address beats refusing to pair at all');
});

test('issuing a code without a listener is refused with a usable reason', async () => {
  const service = await createPeerService({
    home: await newHome(),
    deviceName: 'desk',
    executor: fakeExecutor,
    listen: false,
    log: quietLog,
  });

  try {
    await assert.rejects(
      () => service.createTicket(),
      (error) => error.code === 'listener-off',
      'a code nobody can reach would be a trap',
    );
  } finally {
    await service.stop();
  }
});

test('two real services pair over HTTP, then the initiator can drive the worker', async () => {
  const worker = await makeWorker({ home: await newHome(), allowedDirs: [tmpdir()] });
  const initiator = await createPeerService({
    home: await newHome(),
    deviceName: 'my-desk',
    executor: fakeExecutor,
    listen: false,
    log: quietLog,
  });

  try {
    const ticket = await worker.createTicket({ policy: { preset: 'workspace-write' } });

    const paired = await initiator.pair({ link: ticket.link });
    assert.equal(paired.ok, true, JSON.stringify(paired));
    assert.equal(paired.peer.name, 'my-desk');

    // The worker now lists the machine it trusted.
    const workerPeers = worker.status().trustedBy;
    assert.equal(workerPeers.length, 1);
    assert.equal(workerPeers[0].name, 'my-desk');
    assert.equal(workerPeers[0].policy.preset, 'workspace-write');

    // The initiator can reach the worker with the credential it was given.
    const mounted = initiator.status().peers;
    assert.equal(mounted.length, 1);
    assert.equal(mounted[0].address, worker.status().address);
  } finally {
    await initiator.stop();
    await worker.stop();
  }
});

test('the credential from pairing opens the worker MCP endpoint', async () => {
  const worker = await makeWorker({ home: await newHome(), allowedDirs: [tmpdir()] });
  const initiator = await createPeerService({
    home: await newHome(),
    deviceName: 'my-desk',
    executor: fakeExecutor,
    listen: false,
    log: quietLog,
  });

  try {
    const ticket = await worker.createTicket();
    await initiator.pair({ link: ticket.link });
    const credential = initiator.credentialFor('my-desk');

    const client = new Client({ name: 'service-test', version: '0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${worker.status().address}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${credential}` } } },
    );
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ['ask', 'fetch_file', 'send_file'],
      );
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    await initiator.stop();
    await worker.stop();
  }
});

test('revoking on the worker stops the paired machine, and the initiator can forget it', async () => {
  const worker = await makeWorker({ home: await newHome(), allowedDirs: [tmpdir()] });
  const initiator = await createPeerService({
    home: await newHome(),
    deviceName: 'my-desk',
    executor: fakeExecutor,
    listen: false,
    log: quietLog,
  });

  try {
    const ticket = await worker.createTicket();
    await initiator.pair({ link: ticket.link });

    const [peer] = worker.status().trustedBy;
    await worker.revoke(peer.id);
    assert.equal(worker.status().trustedBy[0].revokedAt !== undefined, true);

    // A revoked peer can no longer connect, even with its original credential.
    const credential = initiator.credentialFor('my-desk');
    const client = new Client({ name: 'revoked', version: '0' });
    try {
      await assert.rejects(async () => {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://${worker.status().address}/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${credential}` } },
          }),
        );
      });
    } finally {
      await client.close().catch(() => {});
    }

    // The initiator can also drop its side.
    const local = initiator.status().peers[0];
    await initiator.forget(local.id);
    assert.deepEqual(initiator.status().peers, []);
  } finally {
    await initiator.stop();
    await worker.stop();
  }
});

test('a mounted peer waits out the whole task window, not the client library default', async () => {
  const worker = await makeWorker({ home: await newHome(), allowedDirs: [tmpdir()] });
  const mounted = [];
  const mountContext = {
    effect: () => {},
    async plugin(module, config) {
      mounted.push({ module, config });
      return () => {};
    },
  };
  const initiator = await createPeerService({
    home: await newHome(),
    deviceName: 'my-desk',
    executor: fakeExecutor,
    listen: false,
    log: quietLog,
    mcp: { name: 'mcp-client', Config: (input) => input, apply: async () => {} },
    mountContext,
    toolCallTimeoutMs: 630_000,
  });

  try {
    const ticket = await worker.createTicket();
    await initiator.pair({ link: ticket.link });

    // An ask is a whole agent turn on the other machine and may run up to the
    // worker's task timeout — ten minutes by default. The MCP client library's
    // own cap is one minute, so a task that outlives it is reported to the
    // caller as a timeout while it is still running and may still succeed,
    // which is exactly what happened between the real machines. The mount must
    // carry the task window through, or the tool lies about the outcome.
    assert.equal(mounted.length, 1);
    assert.equal(
      mounted[0].config.toolCallTimeoutMs,
      630_000,
      'the mount must wait at least as long as the worker may legitimately run',
    );
  } finally {
    await initiator.stop();
    await worker.stop();
  }
});

test('a worker that is not listening refuses pairing instead of pretending', async () => {
  const idle = await createPeerService({
    home: await newHome(),
    deviceName: 'idle',
    executor: fakeExecutor,
    listen: false,
    log: quietLog,
  });
  const initiator = await createPeerService({
    home: await newHome(),
    deviceName: 'my-desk',
    executor: fakeExecutor,
    listen: false,
    log: quietLog,
  });

  try {
    const result = await initiator.pair({ link: 'dshp://127.0.0.1:1/AAAAA-BBBBB' });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'worker-unreachable');
  } finally {
    await initiator.stop();
    await idle.stop();
  }
});

test('a failed outbound pairing is written to the log, not only returned to the caller', async () => {
  const idle = await createPeerService({
    home: await newHome(),
    deviceName: 'idle',
    executor: fakeExecutor,
    listen: false,
    log: quietLog,
  });
  const written = [];
  const initiator = await createPeerService({
    home: await newHome(),
    deviceName: 'my-desk',
    executor: fakeExecutor,
    listen: false,
    log: (line) => written.push(line),
  });

  try {
    await initiator.pair({ link: 'dshp://127.0.0.1:1/AAAAA-BBBBB' });

    // The return value only reaches whoever called the tool. If the operator is
    // looking at the log afterwards — which is what happens once they have moved
    // on and want to know what went wrong — a failure that was never logged is
    // invisible, and the whole attempt looks like it never happened.
    const failure = written.find((line) => line.includes('pair'));
    assert.ok(failure !== undefined, `nothing about the attempt was logged: ${written.join(' | ')}`);
    assert.match(failure, /worker-unreachable/u, 'the log must carry the failure code');
    assert.match(failure, /127\.0\.0\.1:1/u, 'the log must name the address that failed');
  } finally {
    await initiator.stop();
    await idle.stop();
  }
});

test('pairing mounts the peer immediately, and re-pairing replaces rather than stacks', async () => {
  const worker = await makeWorker({ home: await newHome(), allowedDirs: [tmpdir()] });
  const mounted = [];
  // The context double must expose `plugin`, because that is how Cordis mounts
  // the MCP client: `ctx.plugin(moduleNamespace, config)`. A double carrying
  // only `effect` is what let the real bug through the first time.
  const mountContext = {
    effect: () => {},
    async plugin(module, config) {
      const entry = { module, config, disposed: false };
      mounted.push(entry);
      return () => {
        entry.disposed = true;
      };
    },
  };
  const initiator = await createPeerService({
    home: await newHome(),
    deviceName: 'my-desk',
    executor: fakeExecutor,
    listen: false,
    log: quietLog,
    mcp: { name: 'mcp-client', Config: (input) => input, apply: async () => {} },
    mountContext,
  });

  try {
    const ticket = await worker.createTicket();
    await initiator.pair({ link: ticket.link });

    // Pairing is what makes a worker usable, so the client must already be up.
    assert.equal(mounted.length, 1, 'pairing must mount the peer without a second step');
    assert.equal(mounted[0].config.url, `http://${worker.status().address}/mcp`);
    assert.match(mounted[0].config.headers.authorization, /^Bearer /u);
    assert.equal(mounted[0].config.transport, 'streamable-http');
    assert.equal(
      typeof mounted[0].module?.apply,
      'function',
      'the mounted plugin must be the MCP client module itself',
    );

    // Asking again is a no-op, not a duplicate: two clients would mean two sets
    // of identically named tools.
    const again = await initiator.mountPeers();
    assert.deepEqual(again.alreadyMounted, ['my-desk']);
    assert.equal(mounted.length, 1);

    // Re-pairing replaces the credential, so the superseded client must go.
    const second = await worker.createTicket();
    await initiator.pair({ link: second.link });

    assert.equal(mounted.length, 2, 're-pairing must connect the new credential');
    assert.equal(mounted[0].disposed, true, 'the superseded client must be disposed');
  } finally {
    await initiator.stop();
    await worker.stop();
  }
});

test('a mount failure after a successful handshake is reported as a mount failure, not a pairing failure', async () => {
  const worker = await makeWorker({ home: await newHome(), allowedDirs: [tmpdir()] });
  const initiator = await createPeerService({
    home: await newHome(),
    deviceName: 'my-desk',
    executor: fakeExecutor,
    listen: false,
    log: quietLog,
    mcp: { name: 'mcp-client', Config: (input) => input, apply: async () => {} },
    mountContext: {
      effect: () => {},
      async plugin() {
        throw new TypeError('mount refused');
      },
    },
  });

  try {
    const ticket = await worker.createTicket();
    const outcome = await initiator.pair({ link: ticket.link });

    // The handshake really did happen: the worker trusts this machine now. Saying
    // "pair-failed" would be a lie, and would hide that a retry only needs the
    // mount, not a new code.
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.mounted, false);
    assert.equal(outcome.mountError.code, 'mount-failed');
    assert.match(outcome.mountError.detail, /mount refused/u);

    // The worker's side proves the handshake completed.
    assert.equal(worker.status().trustedBy.length, 1);
    assert.equal(initiator.status().peers.length, 1, 'the credential is saved and usable later');
  } finally {
    await initiator.stop();
    await worker.stop();
  }
});

test('mounting is reported as unavailable rather than crashing when no client is wired', async () => {
  const service = await createPeerService({
    home: await newHome(),
    deviceName: 'desk',
    executor: fakeExecutor,
    listen: false,
    log: quietLog,
  });

  try {
    const result = await service.mountPeers();
    assert.deepEqual(result.mounted, []);
    assert.equal(result.code, 'mounting-unavailable');
  } finally {
    await service.stop();
  }
});
