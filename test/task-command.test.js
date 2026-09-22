import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolving a task command, shared by the plugin and the standalone Adapter.
 *
 * The first version of this logic lived only in the standalone entry point, so
 * the plugin shipped on Windows with a default command that could never run: it
 * named the `dsh` shim, which Node refuses to spawn. This suite pins the rule
 * for both callers.
 */

const roots = [];
const newRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-peer-taskcmd-'));
  roots.push(root);
  return root;
};
test.after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** Build a fake DSH Desktop install whose shim names the real executable. */
async function makeInstall(root) {
  const install = join(root, 'DSH Desktop');
  const shimDir = join(install, 'host-commands', 'desktop', 'generations', 'abc', 'bin');
  await mkdir(join(install, 'resources', 'app', 'lib'), { recursive: true });
  await mkdir(shimDir, { recursive: true });
  const exe = join(install, 'DSH Desktop.exe');
  const cli = join(install, 'resources', 'app', 'lib', 'desktop-cli.js');
  await writeFile(exe, 'stub', 'utf8');
  await writeFile(cli, '// stub', 'utf8');
  const shim = join(shimDir, 'dsh.cmd');
  await writeFile(shim, `@echo off\r\n"${exe}" --expose-internals "${cli}" %*\r\n`, 'utf8');
  return { install, exe, cli, shim };
}

test('a plain executable is used as-is, with no launch environment added', async () => {
  const { resolveTaskCommand } = await import('../src/task-command.js');

  const resolved = resolveTaskCommand([process.execPath, '--version']);

  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.command, [process.execPath, '--version']);
  assert.deepEqual(resolved.env, {});
});

test('a missing executable is refused with the setting to change', async () => {
  const { resolveTaskCommand } = await import('../src/task-command.js');

  const resolved = resolveTaskCommand(['definitely-not-a-real-command-xyz', '--profile', 'headless']);

  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, 'command-not-found');
  assert.match(resolved.detail, /DSH_PEER_COMMAND|command/u);
});

test('on Windows a shim resolves to the real executable and its launch environment', async () => {
  const { resolveTaskCommand } = await import('../src/task-command.js');
  const fake = await makeInstall(await newRoot());

  const resolved = resolveTaskCommand([fake.shim, '--profile', 'headless'], { platform: 'win32' });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.command[0], fake.exe);
  assert.ok(resolved.command.includes(fake.cli));
  assert.equal(resolved.env.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(resolved.env.DSH_HOME, 'the task needs to know which harness home to use');
});

test('a shim whose install cannot be found is refused, not passed through', async () => {
  const { resolveTaskCommand } = await import('../src/task-command.js');
  const root = await newRoot();
  const stray = join(root, 'stray.cmd');
  await writeFile(stray, '@echo off\r\necho not a dsh\r\n', 'utf8');

  const resolved = resolveTaskCommand([stray], { platform: 'win32' });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, 'shim-unresolvable');
  assert.match(resolved.detail, /DSH Desktop\.exe/u, 'the message must show what to point at instead');
});

test('a bare command name is found on PATH', async () => {
  const { resolveTaskCommand } = await import('../src/task-command.js');

  // The test runner's own executable directory is on PATH and holds node.
  const resolved = resolveTaskCommand(['node', '-e', '0']);

  assert.equal(resolved.ok, true);
  assert.match(resolved.command[0], /node(?:\.exe)?$/u);
});

test('the plugin default command resolves on Windows instead of failing at task time', async () => {
  const { DEFAULT_COMMAND } = await import('../src/config.js');
  const { resolveTaskCommand } = await import('../src/task-command.js');

  // This is the exact failure that reached the field: the plugin ran the default
  // template, and on Windows that template names a shim Node will not spawn.
  const resolved = resolveTaskCommand(DEFAULT_COMMAND, { platform: 'win32' });

  if (process.platform === 'win32') {
    assert.equal(
      resolved.ok,
      true,
      `the default command must be runnable on Windows, got: ${JSON.stringify(resolved)}`,
    );
    assert.equal(resolved.env.ELECTRON_RUN_AS_NODE, '1');
  }
  // On any other platform the default is a plain `dsh` on PATH, resolved or not.
  assert.ok(resolved.ok === true || resolved.code === 'command-not-found');
});
