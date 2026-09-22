import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The standalone entry point's command resolution.
 *
 * The plugin runs inside DSH and can discover the real executable from the `dsh`
 * on PATH. The standalone Adapter has to do the same, because the operator's
 * PATH on Windows is a `.cmd` shim that Node refuses to spawn — and being handed
 * a shim, it must resolve it rather than fail with a message that sends the
 * operator looking for a missing install.
 *
 * This runs the real entry point, because the resolution happens at startup.
 */

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'k'.repeat(43);

/** Build a fake DSH Desktop install and return the shim the operator would name. */
async function makeFakeInstall(root) {
  const install = join(root, 'DSH Desktop');
  const shimDir = join(install, 'host-commands', 'desktop', 'generations', 'abc', 'bin');
  await mkdir(join(install, 'resources', 'app', 'lib'), { recursive: true });
  await mkdir(shimDir, { recursive: true });

  // A "real executable" that behaves like `node` for our purposes: it prints a
  // marker and exits, so the test can prove which command actually ran.
  const exe = join(install, 'DSH Desktop.exe');
  await writeFile(exe, 'stub', 'utf8');
  const cli = join(install, 'resources', 'app', 'lib', 'desktop-cli.js');
  await writeFile(cli, '// stub', 'utf8');

  const shim = join(shimDir, 'dsh.cmd');
  // Mirrors the real shim, including its stale app.asar reference.
  await writeFile(
    shim,
    `@echo off\r\n"${exe}" --expose-internals "${install}\\resources\\app.asar\\lib\\desktop-cli.js" %*\r\n`,
    'utf8',
  );
  return { install, exe, cli, shim };
}

/** Start the entry point and return the banner it prints. */
async function startAndReadBanner(env, timeoutMs = 25_000) {
  const child = spawn(process.execPath, [join(projectRoot, 'src', 'bin.js')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let collected = '';
  const banner = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no banner: ${collected}`)), timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      collected += chunk;
      if (collected.includes('listening on')) {
        clearTimeout(timer);
        resolve(collected);
      }
    });
    child.on('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${String(code)}: ${collected}`));
    });
  });

  return { child, banner };
}

test('a shim handed in by configuration is resolved to the real executable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-peer-bin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await makeFakeInstall(root);

  const { child, banner } = await startAndReadBanner({
    DSH_PEER_KEY: KEY,
    DSH_PEER_HOST: '127.0.0.1',
    DSH_PEER_PORT: '0',
    DSH_PEER_ALLOWED_DIRS: root,
    DSH_PEER_COMMAND: `"${fake.shim}" --profile headless`,
  });

  try {
    assert.match(banner, /listening on/u, `expected a listener, got: ${banner}`);
    // The banner names the command it will actually run: it must be the real
    // executable, not the shim it was handed.
    assert.match(banner, /task command: .*DSH Desktop\.exe/u, banner);
    assert.match(banner, /desktop-cli\.js/u, banner);
    assert.match(banner, /task environment: .*ELECTRON_RUN_AS_NODE/u, banner);
  } finally {
    child.kill('SIGKILL');
  }
});

test('a shim that cannot be resolved is reported instead of silently accepted', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-peer-bin-bad-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // A .cmd that names no DSH executable anywhere.
  const stray = join(root, 'stray.cmd');
  await writeFile(stray, '@echo off\r\necho not a dsh\r\n', 'utf8');

  const child = spawn(process.execPath, [join(projectRoot, 'src', 'bin.js')], {
    env: {
      ...process.env,
      DSH_PEER_KEY: KEY,
      DSH_PEER_HOST: '127.0.0.1',
      DSH_PEER_PORT: '0',
      DSH_PEER_ALLOWED_DIRS: root,
      DSH_PEER_COMMAND: `"${stray}" --profile headless`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on('close', resolve));

  assert.notEqual(code, 0, 'a .cmd task command must not start a listener that cannot run tasks');
  assert.match(stderr, /\.cmd/u);
  assert.match(stderr, /DSH_PEER_COMMAND/u, 'the operator must be told which setting to change');
});
