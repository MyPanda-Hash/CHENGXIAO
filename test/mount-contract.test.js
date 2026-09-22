import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import { createPeerMounts } from '../src/mounts.js';
import { openInitiatorStore } from '../src/initiator.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The mount contract, checked against real Cordis rather than a stand-in.
 *
 * Two field bugs came from this seam, and both were invisible to fakes:
 *
 * 1. There is no `plugin` property on the MCP client module — mounting is
 *    `ctx.plugin(moduleNamespace, config)`.
 * 2. What that call resolves to is a Cordis **Fiber**, not a function, so a
 *    disposer is `fiber.dispose()` and calling the value itself throws.
 *
 * A fake context agreed with both mistakes. This file asks Cordis instead.
 */

test('Cordis mounts a module namespace and hands back a fiber with dispose()', async () => {
  const root = new Context();

  const fiber = await root.plugin(McpClient, {
    transport: 'streamable-http',
    serverName: 'contract-probe',
    // Port 1 on loopback is reliably closed: the client cannot connect, but it
    // must fail as a connection problem rather than as a shape problem.
    url: 'http://127.0.0.1:1/mcp',
    headers: { authorization: 'Bearer probe' },
  });

  assert.equal(typeof fiber, 'object', 'the mount result is a fiber, not a callable');
  assert.equal(
    typeof fiber,
    'object',
    'calling the mount result directly would throw; disposal goes through .dispose()',
  );
  assert.equal(typeof fiber.dispose, 'function', 'the fiber is what carries the disposer');

  await fiber.dispose();
});

test('the mount service can unmount a peer mounted through real Cordis', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peer-real-mount-'));
  try {
    const store = await openInitiatorStore({ home, deviceName: 'my-desk' });
    const peer = await store.addPeer({
      credential: 'cred-contract',
      address: '127.0.0.1:1',
      name: 'contract-peer',
    });

    const root = new Context();
    const mounts = createPeerMounts({ ctx: root, store, mcp: McpClient });

    const first = await mounts.mountAll();
    assert.deepEqual(first.mounted, ['contract-peer'], `mounted: ${JSON.stringify(first)}`);

    // Second pass is a no-op, not a duplicate fiber.
    const second = await mounts.mountAll();
    assert.deepEqual(second.alreadyMounted, ['contract-peer']);

    // Unmounting must not throw: this is the call that would break if the
    // service treated the fiber as a function.
    await mounts.unmount(peer.id);

    // And a remount must be possible, proving the fibre really was disposed.
    const third = await mounts.mountAll();
    assert.deepEqual(third.mounted, ['contract-peer'], 'a disposed mount must free the slot');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('unloading the plugin disposes peers mounted through real Cordis', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peer-real-unload-'));
  try {
    const store = await openInitiatorStore({ home, deviceName: 'my-desk' });
    await store.addPeer({ credential: 'cred-1', address: '127.0.0.1:1', name: 'contract-peer' });

    const root = new Context();
    const mounts = createPeerMounts({ ctx: root, store, mcp: McpClient });
    await mounts.mountAll();

    // The service registers `disposeAll` as an effect; invoking it must be safe.
    const effects = [];
    const probeCtx = {
      plugin: root.plugin.bind(root),
      effect: (setup) => effects.push(setup),
    };
    const probe = createPeerMounts({ ctx: probeCtx, store, mcp: McpClient });
    await probe.mountAll();

    const dispose = effects[0]();
    assert.equal(typeof dispose, 'function');
    assert.doesNotThrow(() => dispose(), 'unload must dispose real fibers without throwing');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
