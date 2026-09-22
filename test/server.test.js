import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * These tests exercise the real wire: a real HTTP listener, the real MCP
 * Streamable HTTP transport, and the real MCP client. Only the Headless task
 * runner is a stand-in, because spawning a billable agent run is not a unit test.
 */

const KEY = randomBytes(32).toString('base64url');
const workspace = await mkdtemp(join(tmpdir(), 'dsh-peer-server-'));
test.after(() => rm(workspace, { recursive: true, force: true }));

/** An executor that records what it was asked, standing in for a Headless run. */
const makeExecutor = () => {
  const asked = [];
  return {
    asked,
    async ask({ prompt, cwd }) {
      asked.push({ prompt, cwd });
      return { answer: `did: ${prompt}`, stderr: '', exitCode: 0, timedOut: false };
    },
  };
};

/** Start one Adapter on an OS-chosen port and hand its URL to the test body. */
async function withAdapter(options, run) {
  const { startAdapter } = await import('../src/server.js');
  const { createAuth } = await import('../src/auth.js');
  const adapter = await startAdapter({
    auth: createAuth({ key: options.key ?? KEY }),
    executor: options.executor,
    stagingDir: join(workspace, 'staging'),
    allowedDirs: [workspace],
    port: 0,
  });
  try {
    await run(`http://127.0.0.1:${String(adapter.port)}/mcp`);
  } finally {
    await adapter.close();
  }
}

/** Connect one MCP client with the given token, or expect the connection to be refused. */
async function withClient(url, token, run) {
  const client = new Client({ name: 'dsh-peer-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  try {
    await run(client, transport);
  } finally {
    await client.close().catch(() => {});
  }
}

test('a peer that presents the shared key can list and call tools', async () => {
  const executor = makeExecutor();
  await withAdapter({ executor }, async (url) => {
    await withClient(url, KEY, async (client, transport) => {
      await client.connect(transport);

      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, ['ask', 'fetch_file', 'send_file']);

      const result = await client.callTool({
        name: 'ask',
        arguments: { prompt: 'run the tests', cwd: workspace },
      });
      const text = result.content.map((part) => part.text).join('\n');
      assert.match(text, /did: run the tests/);
      assert.deepEqual(executor.asked, [{ prompt: 'run the tests', cwd: workspace }]);
    });
  });
});

test('a peer without the shared key cannot reach the tools', async () => {
  await withAdapter({ executor: makeExecutor() }, async (url) => {
    const client = new Client({ name: 'intruder', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    try {
      await assert.rejects(async () => {
        await client.connect(transport);
      }, 'an unauthenticated session must not be established');
    } finally {
      await client.close().catch(() => {});
    }
  });
});

test('a task request outside the allowlist comes back as a tool error, not a crash', async () => {
  const executor = makeExecutor();
  await withAdapter({ executor }, async (url) => {
    await withClient(url, KEY, async (client, transport) => {
      await client.connect(transport);

      const result = await client.callTool({
        name: 'ask',
        arguments: { prompt: 'read the secrets', cwd: tmpdir() },
      });

      assert.equal(result.isError, true);
      const text = result.content.map((part) => part.text).join('\n');
      assert.match(text, /cwd-not-allowed/);
      assert.deepEqual(executor.asked, [], 'a rejected request must never reach the executor');
    });
  });
});

test('a filesystem round trip works between two connections', async () => {
  await withAdapter({ executor: makeExecutor() }, async (url) => {
    const { writeFile, readFile } = await import('node:fs/promises');
    const source = join(workspace, 'handoff.md');
    await writeFile(source, '# handoff\n- step one\n', 'utf8');

    await withClient(url, KEY, async (outbound, outboundTransport) => {
      await outbound.connect(outboundTransport);
      const sent = await outbound.callTool({
        name: 'fetch_file',
        arguments: { path: source },
      });
      const payload = JSON.parse(sent.content.map((part) => part.text).join('\n'));

      await withClient(url, KEY, async (inbound, inboundTransport) => {
        await inbound.connect(inboundTransport);
        const staged = await inbound.callTool({
          name: 'send_file',
          arguments: payload,
        });
        const receipt = JSON.parse(staged.content.map((part) => part.text).join('\n'));

        assert.equal(await readFile(receipt.path, 'utf8'), '# handoff\n- step one\n');
        assert.equal(receipt.name, 'handoff.md');
        assert.equal(receipt.sha256, payload.sha256);
      });
    });
  });
});

/** Start an Adapter whose fence is the per-peer trust store, and pair one peer. */
async function withPairedAdapter({ policy, executor = makeExecutor() }, run) {
  const { startAdapter } = await import('../src/server.js');
  const { createVerifier } = await import('../src/auth.js');
  const { openTrustStore } = await import('../src/trust.js');
  const trust = await openTrustStore({ home: join(workspace, `home-${String(Math.random()).slice(2)}`) });
  const { credential, peer } = await trust.addPeer({ name: 'desk-pc', publicKey: 'PK-1', policy });

  const adapter = await startAdapter({
    verifier: createVerifier({ trust }),
    executor,
    stagingDir: join(workspace, 'staging'),
    allowedDirs: [workspace],
    port: 0,
  });
  try {
    await run({ url: `http://127.0.0.1:${String(adapter.port)}/mcp`, credential, peer, trust });
  } finally {
    await adapter.close();
  }
}

test('a paired peer reaches the tools with its own credential', async () => {
  await withPairedAdapter({ policy: { preset: 'workspace-write' } }, async ({ url, credential }) => {
    await withClient(url, credential, async (client, transport) => {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ['ask', 'fetch_file', 'send_file'],
      );
    });
  });
});

test('a per-peer directory policy is enforced, not merely recorded', async () => {
  const narrow = join(workspace, 'narrow');
  await (await import('node:fs/promises')).mkdir(narrow, { recursive: true });
  const executor = makeExecutor();

  await withPairedAdapter({ policy: { allowedDirs: [narrow] }, executor }, async ({ url, credential }) => {
    await withClient(url, credential, async (client, transport) => {
      await client.connect(transport);

      const inside = await client.callTool({
        name: 'ask',
        arguments: { prompt: 'work here', cwd: narrow },
      });
      assert.equal(inside.isError ?? false, false, 'the peer must be able to work inside its own grant');

      const outside = await client.callTool({
        name: 'ask',
        arguments: { prompt: 'work there', cwd: workspace },
      });
      assert.equal(outside.isError, true, 'the peer must not work outside the directory it was granted');
      assert.match(outside.content.map((part) => part.text).join('\n'), /cwd-not-allowed/u);
    });
  });
});

test('revoking a peer closes the door without restarting the Adapter', async () => {
  await withPairedAdapter({ policy: { preset: 'workspace-write' } }, async ({ url, credential, peer, trust }) => {
    await withClient(url, credential, async (client, transport) => {
      await client.connect(transport);
      assert.deepEqual((await client.listTools()).tools.length, 3);

      await trust.revokePeer(peer.id);
    });

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const after = new Client({ name: 'revoked', version: '0' });
    try {
      await assert.rejects(
        async () => {
          await after.connect(
            new StreamableHTTPClientTransport(new URL(url), {
              requestInit: { headers: { authorization: `Bearer ${credential}` } },
            }),
          );
        },
        'the next connection must be refused once the peer is revoked',
      );
    } finally {
      await after.close().catch(() => {});
    }
  });
});

test('the whole journey works over HTTP: pair, then use the credential', async () => {
  const { startAdapter, PAIR_PATH } = await import('../src/server.js');
  const { createVerifier } = await import('../src/auth.js');
  const { openTrustStore } = await import('../src/trust.js');
  const { openPairingStore } = await import('../src/pairing.js');
  const { handlePair } = await import('../src/handshake.js');

  const home = join(workspace, `journey-${String(Math.random()).slice(2)}`);
  const trust = await openTrustStore({ home });
  const pairing = await openPairingStore({ home });
  const executor = makeExecutor();

  const adapter = await startAdapter({
    verifier: createVerifier({ trust }),
    executor,
    stagingDir: join(workspace, 'staging'),
    allowedDirs: [workspace],
    port: 0,
    pairEndpoint: async ({ req, res }) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const answer = await handlePair({
        body,
        address: '127.0.0.1:0',
        trust,
        pairing,
      });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    },
  });

  try {
    const origin = `http://127.0.0.1:${String(adapter.port)}`;
    const ticket = await pairing.create({ address: '127.0.0.1', policy: { preset: 'workspace-write' } });

    // No credential yet: the pairing route is reachable, the MCP route is not.
    const refused = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(refused.status, 401, 'MCP must stay closed before pairing');

    const paired = await fetch(`${origin}${PAIR_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ticket.code, name: 'desk-pc', publicKey: 'PK-desk' }),
    });
    const answer = await paired.json();
    assert.equal(paired.status, 201, JSON.stringify(answer));
    assert.ok(answer.credential);

    // The credential the handshake returned must open the MCP route.
    await withClient(`${origin}/mcp`, answer.credential, async (client, transport) => {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 3);

      const asked = await client.callTool({
        name: 'ask',
        arguments: { prompt: 'hello from the paired peer', cwd: workspace },
      });
      assert.match(asked.content.map((part) => part.text).join('\n'), /did: hello from the paired peer/u);
    });

    // A second attempt with the same code must fail: it was spent.
    const replay = await fetch(`${origin}${PAIR_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ticket.code, name: 'attacker', publicKey: 'PK-bad' }),
    });
    assert.equal(replay.status, 403);
    assert.equal(trust.listPeers().length, 1);
  } finally {
    await adapter.close();
  }
});
