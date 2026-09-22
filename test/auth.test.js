import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

/**
 * The Adapter capability lets one machine run arbitrary work on another. The
 * shared key is therefore not a nicety: without a key that is present and
 * long enough, the process must refuse to start rather than serve an open
 * remote-execution endpoint.
 */

const KEY = randomBytes(32).toString('base64url');

test('a short configured key is refused at construction', async () => {
  const { createAuth } = await import('../src/auth.js');

  assert.throws(
    () => createAuth({ key: 'short' }),
    (error) => error.code === 'key-too-short',
  );
  assert.throws(
    () => createAuth({ key: '' }),
    (error) => error.code === 'key-too-short',
  );
});

test('a missing key is only tolerated when explicitly declared insecure', async () => {
  const { createAuth } = await import('../src/auth.js');

  assert.throws(
    () => createAuth({}),
    (error) => error.code === 'key-too-short',
  );
  const insecure = createAuth({ insecure: true });
  assert.equal(insecure.verifies({ headers: {} }), true);
});

/** Start a one-route server guarded by the given verifier and return its authority. */
async function withGuardedServer(auth, run) {
  const server = createServer((req, res) => {
    if (!auth.verifies(req)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unauthorized');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${String(port)}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

const statusOf = async (url, headers) => (await fetch(url, { headers })).status;

test('a request without the shared key is refused', async () => {
  const { createAuth } = await import('../src/auth.js');
  const auth = createAuth({ key: KEY });

  await withGuardedServer(auth, async (origin) => {
    assert.equal(await statusOf(`${origin}/mcp`), 401);
  });
});

test('a request with the wrong key is refused, whatever its length', async () => {
  const { createAuth } = await import('../src/auth.js');
  const auth = createAuth({ key: KEY });
  const shorter = randomBytes(16).toString('base64url');

  await withGuardedServer(auth, async (origin) => {
    assert.equal(await statusOf(`${origin}/mcp`, { authorization: `Bearer ${shorter}` }), 401);
    assert.equal(
      await statusOf(`${origin}/mcp`, { authorization: `Bearer ${randomBytes(32).toString('base64url')}` }),
      401,
    );
    assert.equal(await statusOf(`${origin}/mcp`, { authorization: KEY }), 401, 'the scheme is required');
  });
});

test('a request with the right key is served', async () => {
  const { createAuth } = await import('../src/auth.js');
  const auth = createAuth({ key: KEY });

  await withGuardedServer(auth, async (origin) => {
    assert.equal(await statusOf(`${origin}/mcp`, { authorization: `Bearer ${KEY}` }), 200);
  });
});

test('a truncated key is refused end to end', async () => {
  const { createAuth } = await import('../src/auth.js');
  const auth = createAuth({ key: KEY });

  await withGuardedServer(auth, async (origin) => {
    const prefix = KEY.slice(0, KEY.length - 1);
    assert.equal(await statusOf(`${origin}/mcp`, { authorization: `Bearer ${prefix}` }), 401);
    assert.equal(await statusOf(`${origin}/mcp`, { authorization: `bearer ${KEY}` }), 401);
  });
});

test('the key comparison is byte-exact on the raw header value', async () => {
  const { createAuth } = await import('../src/auth.js');
  const auth = createAuth({ key: KEY });

  // Asserted on the raw value, not through an HTTP client: clients normalise
  // header whitespace, so only the verifier can prove the comparison is exact.
  assert.equal(auth.verifies({ headers: { authorization: `Bearer ${KEY} ` } }), false);
  assert.equal(auth.verifies({ headers: { authorization: `Bearer ${KEY}` } }), true);
  assert.equal(auth.verifies({ headers: { authorization: ['Bearer ' + KEY] } }), true);
  assert.equal(auth.verifies({ headers: { authorization: `Bearer ${KEY.slice(0, -1)}` } }), false);
});
