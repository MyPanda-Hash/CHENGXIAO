import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

/**
 * Configuration is where the Adapter's safety defaults live, so it is worth
 * pinning down in tests: a mistyped environment variable must not silently
 * turn a loopback experiment into a network-exposed remote-execution endpoint.
 */

const KEY = randomBytes(32).toString('base64url');

test('the Adapter listens on loopback unless a host is asked for', async () => {
  const { readConfig } = await import('../src/config.js');

  const config = readConfig({ DSH_PEER_KEY: KEY }, 'C:\\work');

  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 7331);
  assert.equal(config.key, KEY);
});

test('a missing key stops startup instead of serving an open endpoint', async () => {
  const { readConfig } = await import('../src/config.js');

  assert.throws(
    () => readConfig({}, 'C:\\work'),
    (error) => error.code === 'key-too-short',
  );
});

test('an explicit host and port are honoured', async () => {
  const { readConfig } = await import('../src/config.js');

  const config = readConfig(
    { DSH_PEER_KEY: KEY, DSH_PEER_HOST: '0.0.0.0', DSH_PEER_PORT: '8081' },
    'C:\\work',
  );

  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 8081);
});

test('a non-numeric port is refused rather than guessed', async () => {
  const { readConfig } = await import('../src/config.js');

  assert.throws(
    () => readConfig({ DSH_PEER_KEY: KEY, DSH_PEER_PORT: 'eight' }, 'C:\\work'),
    (error) => error.code === 'port-invalid',
  );
});

test('allowed directories default to the configured workspace, split on the path separator', async () => {
  const { readConfig } = await import('../src/config.js');

  const fallback = readConfig({ DSH_PEER_KEY: KEY }, 'C:\\work');
  assert.deepEqual(fallback.allowedDirs, ['C:\\work']);

  const explicit = readConfig(
    { DSH_PEER_KEY: KEY, DSH_PEER_ALLOWED_DIRS: 'C:\\one;C:\\two' },
    'C:\\work',
  );
  assert.deepEqual(explicit.allowedDirs, ['C:\\one', 'C:\\two']);
});

test('the task command template defaults to this machine DSH and can be overridden', async () => {
  const { readConfig } = await import('../src/config.js');

  const fallback = readConfig({ DSH_PEER_KEY: KEY }, 'C:\\work');
  assert.ok(fallback.command.length >= 2, 'the default command must name an executable and its profile');
  assert.ok(
    fallback.command.some((part) => part.includes('dsh')),
    'the default command must invoke dsh',
  );

  const custom = readConfig(
    { DSH_PEER_KEY: KEY, DSH_PEER_COMMAND: 'node C:\\fake\\runner.mjs --flag' },
    'C:\\work',
  );
  assert.deepEqual(custom.command, ['node', 'C:\\fake\\runner.mjs', '--flag']);
});

test('a quoted executable path survives the whitespace split', async () => {
  const { readConfig } = await import('../src/config.js');

  const config = readConfig(
    {
      DSH_PEER_KEY: KEY,
      DSH_PEER_COMMAND: '"C:\\Program Files\\DSH Desktop\\dsh.cmd" --profile headless',
    },
    'C:\\work',
  );

  assert.deepEqual(config.command, [
    'C:\\Program Files\\DSH Desktop\\dsh.cmd',
    '--profile',
    'headless',
  ]);
});

test('staging lives under the harness home rather than in the workspace', async () => {
  const { readConfig } = await import('../src/config.js');

  const config = readConfig({ DSH_PEER_KEY: KEY, DSH_HOME: 'C:\\home\\.dsh' }, 'C:\\work');

  assert.match(config.stagingDir, /dsh-peer[\\/]incoming$/u);
  assert.ok(
    config.stagingDir.startsWith('C:\\home\\.dsh'),
    'staged files belong to the harness home, not to a project directory',
  );
});
