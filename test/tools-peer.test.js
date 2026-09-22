import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeerService } from '../src/service.js';
import { PEER_TOOL_SPECS } from '../src/tools-peer.js';

/**
 * The agent-facing surface: what the model may do about peers.
 *
 * The boundary here is the point of the whole design. The model may *ask* for a
 * pairing code and report it to the operator, and it may revoke — but it must
 * never be able to open a network listener or widen a peer's permission, because
 * those are the operator's decisions. A tool the model can call to expose the
 * machine would undo every other control in this plugin.
 */

const homes = [];
const newHome = async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peer-tools-'));
  homes.push(home);
  return home;
};
test.after(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

const fakeExecutor = {
  async ask() {
    return { answer: 'x', stderr: '', exitCode: 0, timedOut: false };
  },
};

const quietLog = () => {};

const makeService = async ({ listen = false, host = '127.0.0.1' } = {}) =>
  await createPeerService({
    home: await newHome(),
    deviceName: 'my-desk',
    executor: fakeExecutor,
    allowedDirs: [tmpdir()],
    listen,
    host,
    port: 0,
    log: quietLog,
  });

test('the model gets exactly four peer tools, and none of them opens the listener', async () => {
  const names = PEER_TOOL_SPECS.map((spec) => spec.name).sort();

  assert.deepEqual(names, ['peer_pair', 'peer_revoke', 'peer_status', 'peer_ticket']);
  for (const spec of PEER_TOOL_SPECS) {
    assert.ok(spec.description.length > 20, `${spec.name} needs a description a model can act on`);
    assert.equal(typeof spec.execute, 'function');
    assert.equal(typeof spec.parameters, 'object');
  }

  const forbidden = /listen|expose|permission|policy|preset|insecure|admin/iu;
  for (const spec of PEER_TOOL_SPECS) {
    assert.equal(
      forbidden.test(spec.name),
      false,
      `${spec.name} looks like it could change the machine's exposure; that must stay the operator's decision`,
    );
  }
});

test('peer_status reports both directions without leaking any secret', async () => {
  const service = await makeService({ listen: true });
  const status = PEER_TOOL_SPECS.find((spec) => spec.name === 'peer_status');

  try {
    await service.createTicket();
    const result = await status.execute({}, { service });
    const serialized = JSON.stringify(result);

    assert.equal(result.listening, true);
    assert.ok(result.address, 'the operator needs to know where peers dial');
    assert.equal(serialized.includes('code'), false, 'a status read must never carry a pairing code');
    assert.equal(serialized.includes('credential'), false, 'a status read must never carry a credential');
    assert.equal(result.pendingUntil !== undefined, true, 'the operator needs to know a code is live');
  } finally {
    await service.stop();
  }
});

test('peer_ticket returns a code the operator can read out, and explains a closed listener', async () => {
  const open = await makeService({ listen: true });
  const closed = await makeService({ listen: false });
  const ticket = PEER_TOOL_SPECS.find((spec) => spec.name === 'peer_ticket');

  try {
    const issued = await ticket.execute({ preset: 'workspace-write' }, { service: open });
    assert.match(issued.link, /^dshp:\/\/127\.0\.0\.1:\d+\/[A-Z2-9]{5}-[A-Z2-9]{5}$/u);
    assert.equal(issued.expiresAt !== undefined, true);

    const refused = await ticket.execute({}, { service: closed });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'listener-off');
    // A bare refusal would leave the model guessing, so the answer has to say
    // what the operator must change. The service also refuses, but with a
    // developer-facing message, and that one tells the model nothing useful.
    assert.match(refused.detail, /settings/iu, 'the model must be told where the operator turns this on');
    assert.match(refused.detail, /operator/iu, 'the model must be told whose decision this is');
  } finally {
    await open.stop();
    await closed.stop();
  }
});

test('peer_ticket refuses to widen permission beyond what the operator allows', async () => {
  const service = await makeService({ listen: true });
  const ticket = PEER_TOOL_SPECS.find((spec) => spec.name === 'peer_ticket');

  try {
    // The tool has no way to name a preset the operator did not allow, so an
    // unknown value is refused rather than passed through.
    const refused = await ticket.execute({ preset: 'root-everything' }, { service });

    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'preset-not-allowed');
  } finally {
    await service.stop();
  }
});

test('peer_pair refuses a link that is not a pairing link', async () => {
  const service = await makeService();
  const pair = PEER_TOOL_SPECS.find((spec) => spec.name === 'peer_pair');

  try {
    const refused = await pair.execute({ link: 'https://example.com/whatever' }, { service });

    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'link-scheme');
  } finally {
    await service.stop();
  }
});

test('peer_pair reports a wrong code without throwing at the model', async () => {
  const service = await makeService();
  const pair = PEER_TOOL_SPECS.find((spec) => spec.name === 'peer_pair');

  try {
    const refused = await pair.execute({ link: 'dshp://127.0.0.1:1/AAAAA-BBBBB' }, { service });

    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'worker-unreachable');
  } finally {
    await service.stop();
  }
});

test('peer_pair reports a successful handshake even when the mount then fails', async () => {
  const worker = await makeService({ listen: true });
  const ticket = PEER_TOOL_SPECS.find((spec) => spec.name === 'peer_ticket');
  const pair = PEER_TOOL_SPECS.find((spec) => spec.name === 'peer_pair');

  // A service whose handshake works but whose mount cannot.
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
    const issued = await ticket.execute({}, { service: worker });
    const outcome = await pair.execute({ link: issued.link }, { service: initiator });

    // Saying "pair-failed" here would be a lie: the code is spent and the worker
    // already trusts this machine. The model must be able to tell the difference.
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.mounted, false);
    assert.equal(outcome.mountError.code, 'mount-failed');
    assert.match(outcome.detail, /spent/u, 'the model needs to know a retry does not need a new code');
  } finally {
    await initiator.stop();
    await worker.stop();
  }
});

test('peer_revoke revokes a peer and names it in the answer', async () => {
  const worker = await makeService({ listen: true });
  const initiator = await makeService();
  const ticket = PEER_TOOL_SPECS.find((spec) => spec.name === 'peer_ticket');
  const pair = PEER_TOOL_SPECS.find((spec) => spec.name === 'peer_pair');
  const revoke = PEER_TOOL_SPECS.find((spec) => spec.name === 'peer_revoke');
  const status = PEER_TOOL_SPECS.find((spec) => spec.name === 'peer_status');

  try {
    const issued = await ticket.execute({}, { service: worker });
    await pair.execute({ link: issued.link }, { service: initiator });
    const [trusted] = (await status.execute({}, { service: worker })).trustedBy;

    const revoked = await revoke.execute({ id: trusted.id }, { service: worker });

    assert.equal(revoked.ok, true);
    assert.equal(revoked.name, 'my-desk');
    assert.equal((await status.execute({}, { service: worker })).trustedBy[0].revokedAt !== undefined, true);
  } finally {
    await initiator.stop();
    await worker.stop();
  }
});

test('peer_revoke on an unknown peer answers instead of crashing the turn', async () => {
  const service = await makeService();
  const revoke = PEER_TOOL_SPECS.find((spec) => spec.name === 'peer_revoke');

  try {
    const answer = await revoke.execute({ id: 'no-such-peer' }, { service });

    assert.equal(answer.ok, false);
    assert.equal(answer.code, 'peer-unknown');
  } finally {
    await service.stop();
  }
});
