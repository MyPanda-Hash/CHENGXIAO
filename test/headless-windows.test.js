import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Windows task launching.
 *
 * The obvious way to run DSH on Windows — spawning `dsh.cmd` — cannot work:
 * Node refuses to spawn a .cmd without a shell (CVE-2024-27980), and going
 * through `cmd.exe` makes the prompt shell syntax, so a task containing `&` or
 * `|` is split into two commands. These tests pin the launch strategy that
 * avoids both problems: run the real executable with an argument array.
 */

const workspace = await mkdtemp(join(tmpdir(), 'dsh-peer-win-'));
test.after(() => rm(workspace, { recursive: true, force: true }));

/** A `.cmd` file, to prove the executor relies on docs rather than on shell mode. */
const cmdStub = join(workspace, 'stub.cmd');
await (await import('node:fs/promises')).writeFile(cmdStub, '@echo off\r\necho ran\r\n', 'utf8');

test('the default command is the portable one when no entry point is supplied', async () => {
  const { readConfig } = await import('../src/config.js');
  const { DEFAULT_COMMAND } = await import('../src/config.js');

  const config = readConfig({ DSH_PEER_KEY: 'k'.repeat(40) }, workspace);

  assert.deepEqual(config.command, DEFAULT_COMMAND);
  assert.equal(
    DEFAULT_COMMAND.some((part) => /\.cmd$/iu.test(part)),
    false,
    'the portable default must not name a Windows shell shim',
  );
});

test('a task runner receives its Windows launch environment', async () => {
  const { createHeadlessExecutor } = await import('../src/headless.js');

  const executor = createHeadlessExecutor({
    command: [process.execPath, '-e', 'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? "unset")'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
  const result = await executor.ask({ prompt: 'x', cwd: workspace });

  assert.equal(result.exitCode, 0);
  assert.equal(result.answer, '1');
});

test('a .cmd shim is refused with the real command spelled out', async () => {
  const { createHeadlessExecutor } = await import('../src/headless.js');
  const { mkdir, writeFile } = await import('node:fs/promises');

  // Shaped like a real DSH Desktop install, so the replacement hint is checkable.
  const install = join(workspace, 'FakeInstall');
  const shimDir = join(install, 'host-commands', 'desktop', 'generations', 'abc', 'bin');
  await mkdir(join(install, 'resources', 'app', 'lib'), { recursive: true });
  await mkdir(shimDir, { recursive: true });
  await writeFile(join(install, 'DSH Desktop.exe'), 'stub', 'utf8');
  await writeFile(join(install, 'resources', 'app', 'lib', 'desktop-cli.js'), '// stub', 'utf8');
  const shim = join(shimDir, 'dsh.cmd');
  await writeFile(shim, '@echo off\r\n', 'utf8');

  const executor = createHeadlessExecutor({ command: [shim, '--profile', 'headless'] });
  const result = await executor.ask({ prompt: 'x', cwd: workspace });

  assert.notEqual(result.exitCode, 0);
  // The operator must be told this is a misconfiguration, not a missing install...
  assert.match(result.stderr, /launcher was found/u);
  assert.match(result.stderr, /not a missing install/u);
  // ...and handed the exact replacement, arguments included.
  assert.match(result.stderr, /DSH Desktop\.exe/u);
  assert.match(result.stderr, /desktop-cli\.js/u);
  assert.match(result.stderr, /ELECTRON_RUN_AS_NODE/u);
});

test('a missing executable says the task never started, and what to change', async () => {
  const { createHeadlessExecutor } = await import('../src/headless.js');

  const executor = createHeadlessExecutor({ command: [join(workspace, 'nothing-here.exe')] });
  const result = await executor.ask({ prompt: 'x', cwd: workspace });

  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /no such executable/u);
  assert.match(result.stderr, /task never started/u);
  assert.match(result.stderr, /DSH_PEER_COMMAND/u);
});

test('a prompt containing shell syntax reaches the child intact', async () => {
  const { createHeadlessExecutor } = await import('../src/headless.js');

  const executor = createHeadlessExecutor({
    // Write each argument as JSON, so nothing about the transport is ambiguous.
    command: [
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      '--',
    ],
  });
  const prompt = 'fix "quotes" & pipe | other %PATH% !bang!';
  const result = await executor.ask({ prompt, cwd: workspace });

  assert.deepEqual(JSON.parse(result.answer), [prompt]);
});
