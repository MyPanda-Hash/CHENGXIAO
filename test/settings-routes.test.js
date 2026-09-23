import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeerService } from '../src/service.js';
import { isLoopbackRequest, registerSettingsRoutes } from '../src/settings-routes.js';

/**
 * The settings routes as the host registers them.
 *
 * The page they serve is where an operator turns a network listener on and hands
 * out access, so the fence around these routes matters as much as the handlers
 * behind them: they must be reachable from this machine and refused from
 * anywhere else. `isLoopbackRequest` is that fence, and it is tested on its own
 * because the consequence of getting it wrong is silent.
 */

const homes = [];
const newHome = async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peer-routes-'));
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

const makeService = async (listen) =>
  await createPeerService({
    home: await newHome(),
    deviceName: 'my-desk',
    executor: fakeExecutor,
    listen,
    ...(listen && { host: '127.0.0.1', port: 0, allowedDirs: [tmpdir()] }),
    log: () => {},
  });

test('a loopback Host is accepted, and nothing else is', async () => {
  const accepted = [
    { headers: {} },
    { headers: { host: '127.0.0.1:65168' } },
    { headers: { host: '127.0.0.1' } },
    { headers: { host: 'localhost:3080' } },
    { headers: { host: '[::1]:65168' } },
  ];
  for (const request of accepted) {
    assert.equal(isLoopbackRequest(request), true, `should accept ${JSON.stringify(request.headers)}`);
  }

  const refused = [
    { headers: { host: '10.60.31.127:65168' } },
    { headers: { host: '192.168.1.20' } },
    { headers: { host: 'evil.example.com' } },
    { headers: { host: '127.0.0.1.evil.com' } },
    { headers: { host: 'localhost.evil.com:65168' } },
  ];
  for (const request of refused) {
    assert.equal(isLoopbackRequest(request), false, `should refuse ${JSON.stringify(request.headers)}`);
  }
});

/** A response double that records what the handler wrote. */
const makeResponse = () => {
  const recorded = { status: 0, body: '', headers: {} };
  return {
    recorded,
    writeHead(status, headers) {
      recorded.status = status;
      Object.assign(recorded.headers, headers ?? {});
      return this;
    },
    end(body) {
      recorded.body = body ?? '';
      return this;
    },
  };
};

/** A request double: AsyncIterable body plus headers and method. */
const makeRequest = ({ method = 'GET', host = '127.0.0.1:65168', body } = {}) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    method,
    url: '/',
    headers: { host },
    async *[Symbol.asyncIterator]() {
      if (text !== '') yield Buffer.from(text, 'utf8');
    },
  };
};

/** Register the routes against a fake carrier and return a caller. */
const withRoutes = async (service, run) => {
  const registered = [];
  const ctx = {
    webServer: {
      register(spec) {
        registered.push(spec);
        return () => {
          spec.disposed = true;
        };
      },
    },
  };
  const handle = registerSettingsRoutes({ ctx, service, log: () => {} });
  try {
    await run({
      registered,
      call: async (path, request) => {
        const spec = registered.find((entry) => entry.path === path);
        assert.ok(spec, `no route registered for ${path}`);
        const res = makeResponse();
        await spec.handler(request, res);
        return res.recorded;
      },
    });
  } finally {
    handle.dispose();
  }
};

test('all four routes are registered as exact paths under the plugin prefix', async () => {
  const service = await makeService(false);
  await withRoutes(service, async ({ registered }) => {
    assert.deepEqual(
      registered.map((entry) => entry.path).sort(),
      [
        '/plugins/dsh-peer-mcp/pair',
        '/plugins/dsh-peer-mcp/revoke',
        '/plugins/dsh-peer-mcp/status',
        '/plugins/dsh-peer-mcp/ticket',
      ],
    );
    for (const entry of registered) {
      assert.equal(entry.kind, 'exact', 'a prefix route would catch unrelated paths');
      assert.equal(typeof entry.handler, 'function');
    }
  });
});

test('a non-loopback caller is refused before anything is served', async () => {
  const service = await makeService(false);
  await withRoutes(service, async ({ call }) => {
    const answer = await call('/plugins/dsh-peer-mcp/status', makeRequest({ host: '10.60.31.127:65168' }));

    assert.equal(answer.status, 403);
    assert.equal(answer.body, 'forbidden');
  });
});

test('a route answers only its own method', async () => {
  const service = await makeService(false);
  await withRoutes(service, async ({ call }) => {
    const wrong = await call('/plugins/dsh-peer-mcp/status', makeRequest({ method: 'POST', body: {} }));

    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.allow, 'GET');
    assert.equal(JSON.parse(wrong.body).code, 'method-not-allowed');
  });
});

test('a status read comes back as JSON with no-store caching', async () => {
  const service = await makeService(false);
  await withRoutes(service, async ({ call }) => {
    const answer = await call('/plugins/dsh-peer-mcp/status', makeRequest());

    assert.equal(answer.status, 200);
    assert.match(answer.headers['content-type'], /application\/json/u);
    assert.equal(answer.headers['cache-control'], 'no-store', 'a stale status would mislead the page');
    assert.equal(JSON.parse(answer.body).listening, false);
  });
});

test('a malformed body is refused as a bad request, not as a crash', async () => {
  const service = await makeService(false);
  await withRoutes(service, async ({ call }) => {
    const broken = makeRequest({ method: 'POST' });
    broken[Symbol.asyncIterator] = async function* () {
      yield Buffer.from('{ this is not json', 'utf8');
    };

    const answer = await call('/plugins/dsh-peer-mcp/pair', broken);

    assert.equal(answer.status, 400);
    assert.equal(JSON.parse(answer.body).code, 'body-malformed');
  });
});

test('an oversized body is refused rather than buffered', async () => {
  const service = await makeService(false);
  await withRoutes(service, async ({ call }) => {
    const huge = makeRequest({ method: 'POST' });
    huge[Symbol.asyncIterator] = async function* () {
      // 20 KiB of JSON, over the 16 KiB ceiling.
      yield Buffer.from(JSON.stringify({ link: 'x'.repeat(20 * 1024) }), 'utf8');
    };

    const answer = await call('/plugins/dsh-peer-mcp/pair', huge);

    assert.equal(answer.status, 400);
    assert.equal(JSON.parse(answer.body).code, 'body-malformed');
  });
});

test('disposing the registration releases every route', async () => {
  const service = await makeService(false);
  const registered = [];
  const ctx = {
    webServer: {
      register(spec) {
        registered.push(spec);
        return () => {
          spec.disposed = true;
        };
      },
    },
  };

  const handle = registerSettingsRoutes({ ctx, service, log: () => {} });
  handle.dispose();

  for (const entry of registered) {
    assert.equal(entry.disposed, true, `${entry.path} must be released on unload`);
  }
});
