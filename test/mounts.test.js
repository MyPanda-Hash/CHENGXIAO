import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInitiatorStore } from '../src/initiator.js';

/**
 * Mounting a peer as a set of tools.
 *
 * Mounting is what makes a paired worker usable: the MCP client is added to the
 * running plugin, and its tools appear to the model. The rules worth pinning
 * down are about lifecycle — one mount per peer, unmounting on re-pair so a
 * peer's old credential is never left connected, and never mounting a peer
 * whose credential cannot be read.
 */

const homes = [];
const newStore = async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peer-mount-'));
  homes.push(home);
  return await openInitiatorStore({ home, deviceName: 'my-desk' });
};
test.after(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

/** A stand-in for `@deepseek-ai/dsh-mcp-client`, shaped like the real module. */
const makeFakeMcpClient = () => ({ name: 'mcp-client', Config: (input) => input, apply: async () => {} });

/**
 * The Cordis context surface the mount service uses.
 *
 * `ctx.plugin(module, config)` is how Cordis mounts a plugin: the module
 * namespace is the first argument and the call returns a disposer.
 */
const makeFakeContext = () => {
  const effects = [];
  const mounts = [];
  return {
    effects,
    mounts,
    async plugin(module, config) {
      const record = { module, config, disposed: false };
      mounts.push(record);
      return () => {
        record.disposed = true;
      };
    },
    effect(setup) {
      effects.push(setup);
    },
  };
};

test('the real MCP client module has the shape the mount service assumes', async () => {
  const mcp = await import('@deepseek-ai/dsh-mcp-client');

  // This test exists because the first version of this service called a `plugin`
  // property the package does not have, and every fake in these tests had it.
  // Mounting is `ctx.plugin(moduleNamespace, config)`; the namespace is passed
  // whole, and the package exports nothing but these four names.
  assert.deepEqual(Object.keys(mcp).sort(), ['Config', 'apply', 'inject', 'name']);
  assert.equal(mcp.plugin, undefined, 'there is no `plugin` export to call');
  assert.equal(typeof mcp.apply, 'function');
  assert.ok(
    mcp.Config({
      transport: 'streamable-http',
      serverName: 'srv-a',
      url: 'http://10.0.0.5:7331/mcp',
      headers: { authorization: 'Bearer cred-1' },
    }),
    'the shaped config must satisfy the real schema',
  );
});

test('a paired worker is mounted through ctx.plugin with transport, url and credential', async () => {
  const { createPeerMounts } = await import('../src/mounts.js');
  const store = await newStore();
  await store.addPeer({ credential: 'cred-1', address: '10.0.0.5:7331', name: 'srv-a' });

  const mcp = makeFakeMcpClient();
  const ctx = makeFakeContext();
  const mounts = createPeerMounts({ ctx, store, mcp });

  const result = await mounts.mountAll();

  assert.deepEqual(result.mounted, ['srv-a']);
  assert.equal(ctx.mounts.length, 1);
  assert.equal(ctx.mounts[0].module, mcp, 'the MCP client module itself is what gets mounted');
  assert.equal(ctx.mounts[0].config.transport, 'streamable-http');
  assert.equal(ctx.mounts[0].config.url, 'http://10.0.0.5:7331/mcp');
  assert.equal(ctx.mounts[0].config.headers.authorization, 'Bearer cred-1');
  assert.equal(ctx.mounts[0].config.serverName, 'srv-a');
});

test('mounting twice does not produce two clients for one peer', async () => {
  const { createPeerMounts } = await import('../src/mounts.js');
  const store = await newStore();
  await store.addPeer({ credential: 'cred-1', address: '10.0.0.5:7331', name: 'srv-a' });

  const ctx = makeFakeContext();
  const mounts = createPeerMounts({ ctx, store, mcp: makeFakeMcpClient() });

  await mounts.mountAll();
  const second = await mounts.mountAll();

  assert.equal(ctx.mounts.length, 1, 'a second mountAll must not duplicate the client');
  assert.deepEqual(second.alreadyMounted, ['srv-a']);
});

test('a worker whose stored credential cannot be read is reported, not mounted', async () => {
  const { createPeerMounts } = await import('../src/mounts.js');
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const store = await newStore();
  await store.addPeer({ credential: 'cred-1', address: '10.0.0.5:7331', name: 'srv-a' });

  // Corrupt the sealed credential exactly as tampering would.
  const home = homes.at(-1);
  await mkdir(join(home, 'dsh-peer'), { recursive: true });
  const statePath = join(home, 'dsh-peer', 'initiator.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.peers[0].sealedCredential = 'dead:beef:00';
  await writeFile(statePath, JSON.stringify(state), 'utf8');

  const reopened = await openInitiatorStore({ home, deviceName: 'my-desk' });
  const ctx = makeFakeContext();
  const mounts = createPeerMounts({ ctx, store: reopened, mcp: makeFakeMcpClient() });

  const result = await mounts.mountAll();

  assert.deepEqual(result.mounted, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].name, 'srv-a');
  assert.equal(ctx.mounts.length, 0, 'an unreadable credential must never be mounted');
});

test('unmounting a worker disposes its client, and re-pairing replaces it', async () => {
  const { createPeerMounts } = await import('../src/mounts.js');
  const store = await newStore();
  const peer = await store.addPeer({ credential: 'cred-old', address: '10.0.0.5:7331', name: 'srv-a' });

  const ctx = makeFakeContext();
  const mounts = createPeerMounts({ ctx, store, mcp: makeFakeMcpClient() });
  await mounts.mountAll();

  await mounts.unmount(peer.id);
  assert.equal(ctx.mounts[0].disposed, true, 'unmounting must dispose the client, not just forget it');

  await store.addPeer({ credential: 'cred-new', address: '10.0.0.5:7331', name: 'srv-a' });
  await mounts.mountAll();

  assert.equal(ctx.mounts.length, 2);
  assert.equal(ctx.mounts[1].config.headers.authorization, 'Bearer cred-new');
  assert.equal(ctx.mounts[0].disposed, true);
});

test('unmounting by peer name disposes the client too', async () => {
  const { createPeerMounts } = await import('../src/mounts.js');
  const store = await newStore();
  await store.addPeer({ credential: 'cred-1', address: '10.0.0.5:7331', name: 'srv-a' });

  const ctx = makeFakeContext();
  const mounts = createPeerMounts({ ctx, store, mcp: makeFakeMcpClient() });
  await mounts.mountAll();

  // A caller that only knows the peer's name is the common case, since the name
  // is what the tools are named after.
  await mounts.unmount('srv-a');

  assert.equal(ctx.mounts[0].disposed, true, 'unmounting by name must dispose, not merely forget');
  const again = await mounts.mountAll();
  assert.deepEqual(again.mounted, ['srv-a'], 'a forgotten-and-still-live client would block a remount');
});

test('unmounting something that was never mounted is harmless', async () => {
  const { createPeerMounts } = await import('../src/mounts.js');
  const ctx = makeFakeContext();
  const mounts = createPeerMounts({ ctx, store: await newStore(), mcp: makeFakeMcpClient() });

  await mounts.unmount('never-mounted');
  await mounts.unmount('no-such-id');

  assert.equal(ctx.mounts.length, 0);
});

test('every mount is registered for disposal when the plugin unloads', async () => {
  const { createPeerMounts } = await import('../src/mounts.js');
  const store = await newStore();
  await store.addPeer({ credential: 'cred-1', address: '10.0.0.5:7331', name: 'srv-a' });

  const ctx = makeFakeContext();
  const mounts = createPeerMounts({ ctx, store, mcp: makeFakeMcpClient() });
  await mounts.mountAll();

  assert.equal(ctx.effects.length, 1, 'the plugin must hand Cordis a disposer');
  const dispose = ctx.effects[0]();
  assert.equal(typeof dispose, 'function');
  dispose();

  assert.equal(ctx.mounts[0].disposed, true, 'unloading the plugin must unmount the peers');
});

test('a mount failure names the peer instead of rejecting the whole pairing', async () => {
  const { createPeerMounts } = await import('../src/mounts.js');
  const store = await newStore();
  await store.addPeer({ credential: 'cred-1', address: '10.0.0.5:7331', name: 'srv-a' });

  const ctx = makeFakeContext();
  ctx.plugin = async () => {
    throw new Error('mount refused');
  };
  const mounts = createPeerMounts({ ctx, store, mcp: makeFakeMcpClient() });

  await assert.rejects(() => mounts.mountAll(), /mount refused/u);
});
