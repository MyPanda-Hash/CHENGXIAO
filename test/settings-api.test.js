import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeerService } from '../src/service.js';
import { createSettingsApi } from '../src/settings-api.js';

/**
 * The settings surface's data layer.
 *
 * The browser half of this plugin is a settings page, and a settings page is a
 * dangerous thing to get wrong: it is where an operator turns a network listener
 * on, issues a code that grants another machine the right to run work here, and
 * revokes that right again. So the route table is pinned down as its own unit
 * before any UI exists.
 *
 * Two rules the tests keep insisting on:
 *
 * - **Reading never returns a secret.** A status read must not carry a live
 *   pairing code or a peer credential, because status is what a page polls.
 * - **Refusals are data, not exceptions.** The page has to render a reason the
 *   operator can act on, so a refusal comes back as a structured code.
 */

const homes = [];
const newHome = async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peer-settings-'));
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

/** A service that is not listening, which is how the plugin ships. */
const makeIdleService = async () =>
  await createPeerService({
    home: await newHome(),
    deviceName: 'my-desk',
    executor: fakeExecutor,
    listen: false,
    log: quietLog,
  });

/** A listening service, for the flows that need an address to hand out. */
const makeListeningService = async () =>
  await createPeerService({
    home: await newHome(),
    deviceName: 'my-desk',
    executor: fakeExecutor,
    listen: true,
    host: '127.0.0.1',
    port: 0,
    allowedDirs: [tmpdir()],
    log: quietLog,
  });

/** Call the API the way the browser will: a method, a path, and optional fields. */
const request = (api, method, path, body) => api.handle({ method, path, body });

test('every route exists under one plugin prefix, so the page needs no discovery', async () => {
  const api = createSettingsApi({ service: await makeIdleService() });

  assert.match(api.prefix, /^\/plugins\/dsh-peer-mcp/u, `prefix was ${api.prefix}`);

  // Not 404 is the assertion: each path resolves to an operation, even when the
  // operation then refuses because the machine is in the wrong state.
  const status = await request(api, 'GET', `${api.prefix}/status`);
  assert.equal(status.status, 200);

  const noSuchRoute = await request(api, 'GET', `${api.prefix}/definitely-not-a-route`);
  assert.equal(noSuchRoute.status, 404, 'an unknown path must be the only 404 here');

  for (const [path, expected] of [
    ['ticket', 409],
    ['pair', 400],
    ['revoke', 400],
  ]) {
    const answer = await request(api, 'POST', `${api.prefix}/${path}`, {});
    assert.equal(answer.status, expected, `${path} must be routed (got ${JSON.stringify(answer)})`);
  }
});

test('workspace route returns and updates the safe collaboration settings', async () => {
  const service = await makeIdleService();
  const api = createSettingsApi({ service });
  try {
    const initial = await request(api, 'GET', `${api.prefix}/workspace`);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.workspace.source, 'default');
    assert.equal(initial.body.capabilities.runSystemCommand, false);

    const refused = await request(api, 'POST', `${api.prefix}/workspace`, {
      path: '',
      capabilities: { accessOutsideWorkspace: true },
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'workspace-path-missing');

    const updated = await request(api, 'POST', `${api.prefix}/workspace`, {
      path: 'C:\\Users\\alice\\DSH Workspace',
      capabilities: { writeWorkspace: false, accessOutsideWorkspace: true },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.workspace.source, 'configured');
    assert.equal(updated.body.capabilities.writeWorkspace, false);
    assert.equal(updated.body.capabilities.accessOutsideWorkspace, false);
  } finally {
    await service.stop();
  }
});

test('an unknown path or method is refused rather than guessed', async () => {
  const api = createSettingsApi({ service: await makeIdleService() });

  assert.equal((await request(api, 'GET', `${api.prefix}/nope`)).status, 404);
  assert.equal((await request(api, 'POST', `${api.prefix}/status`)).status, 405);
  assert.equal((await request(api, 'GET', `${api.prefix}/ticket`)).status, 405);
});

test('a status read reports both directions and never a secret', async () => {
  const service = await makeListeningService();
  const api = createSettingsApi({ service });

  try {
    await service.createTicket();
    const answer = await request(api, 'GET', `${api.prefix}/status`);
    const serialized = JSON.stringify(answer.body);

    assert.equal(answer.status, 200);
    assert.equal(answer.body.listening, true);
    assert.equal(typeof answer.body.address, 'string');
    assert.equal(answer.body.peers.length, 0);
    assert.equal(answer.body.trustedBy.length, 0);
    assert.equal(answer.body.pending.until !== undefined, true, 'the page needs to show a live code exists');
    assert.equal(serialized.includes('code'), false, 'a polled status must never carry the code itself');
    assert.equal(serialized.includes('credential'), false);
  } finally {
    await service.stop();
  }
});

test('issuing a code returns it exactly once, and the next status read does not', async () => {
  const service = await makeListeningService();
  const api = createSettingsApi({ service });

  try {
    const issued = await request(api, 'POST', `${api.prefix}/ticket`, { preset: 'workspace-write' });

    assert.equal(issued.status, 200);
    assert.match(issued.body.link, /^dshp:\/\/127\.0\.0\.1:\d+\/[A-Z2-9]{5}-[A-Z2-9]{5}$/u);
    assert.equal(issued.body.preset, 'workspace-write');
    assert.equal(issued.body.shortCode, issued.body.code);
    assert.equal(issued.body.capabilities.runSystemCommand, false);

    const after = await request(api, 'GET', `${api.prefix}/status`);
    assert.equal(JSON.stringify(after.body).includes(issued.body.code), false);
  } finally {
    await service.stop();
  }
});

test('issuing a code with the listener off explains what the operator must do', async () => {
  const api = createSettingsApi({ service: await makeIdleService() });

  const refused = await request(api, 'POST', `${api.prefix}/ticket`, {});

  assert.equal(refused.status, 409, 'a configuration state, not a bad request');
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.code, 'listener-off');
  assert.match(refused.body.detail, /listen/iu);
});

test('a code cannot be issued with a permission preset outside the allowed set', async () => {
  const service = await makeListeningService();
  const api = createSettingsApi({ service });

  try {
    const refused = await request(api, 'POST', `${api.prefix}/ticket`, { preset: 'root-everything' });

    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'preset-not-allowed');
  } finally {
    await service.stop();
  }
});

test('pairing a malformed link is refused with the reason the parser gave', async () => {
  const api = createSettingsApi({ service: await makeIdleService() });

  const refused = await request(api, 'POST', `${api.prefix}/pair`, { link: 'https://example.com/x' });

  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'link-scheme');
});

test('pairing an unreachable machine comes back as data, not a thrown error', async () => {
  const api = createSettingsApi({ service: await makeIdleService() });

  const answer = await request(api, 'POST', `${api.prefix}/pair`, { link: 'dshp://127.0.0.1:1/AAAAA-BBBBB' });

  assert.equal(answer.status, 200, 'the page renders the failure, so the transport succeeded');
  assert.equal(answer.body.ok, false);
  assert.equal(answer.body.code, 'worker-unreachable');
});

test('revoking reports the peer it revoked, and an unknown id is a refusal', async () => {
  const api = createSettingsApi({ service: await makeIdleService() });

  const missing = await request(api, 'POST', `${api.prefix}/revoke`, { id: 'no-such-peer' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'peer-unknown');

  const noId = await request(api, 'POST', `${api.prefix}/revoke`, {});
  assert.equal(noId.status, 400);
  assert.equal(noId.body.code, 'id-missing');
});

test('a peer cannot be granted more than the presets the operator may choose', async () => {
  const service = await makeListeningService();
  const api = createSettingsApi({ service });

  try {
    // The page offers a fixed set; the route enforces it rather than trusting the form.
    for (const preset of ['workspace-write', 'danger-full-access']) {
      const ok = await request(api, 'POST', `${api.prefix}/ticket`, { preset });
      assert.equal(ok.status, 200, `${preset} should be issuable`);
      assert.equal(ok.body.preset, preset);
    }
  } finally {
    await service.stop();
  }
});
