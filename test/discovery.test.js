import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Windows entry-point discovery.
 *
 * `dsh` on PATH is a `.cmd` shim that lives under
 * `...\host-commands\desktop\generations\<hash>\bin\`, while the real executable
 * sits at the install root. The shim's own text also goes stale: this machine's
 * shim still names `app.asar` although the install ships an unpacked `app`
 * directory. So discovery walks up the tree looking for the CLI script that
 * actually exists.
 */

const root = await mkdtemp(join(tmpdir(), 'dsh-peer-discovery-'));
test.after(() => rm(root, { recursive: true, force: true }));

/** Build a fake DSH Desktop install and return its `dsh.cmd` shim path. */
async function makeFakeInstall({ withCli = true, shimDir = 'host-commands/desktop/generations/abc/bin' } = {}) {
  const install = join(root, `install-${String(Math.trunc(Math.random() * 1e9))}`);
  const exe = join(install, 'DSH Desktop.exe');
  const cli = join(install, 'resources', 'app', 'lib', 'desktop-cli.js');
  await mkdir(join(install, 'resources', 'app', 'lib'), { recursive: true });
  await writeFile(exe, 'stub', 'utf8');
  if (withCli) await writeFile(cli, '// stub', 'utf8');

  const shimPath = join(install, shimDir, 'dsh.cmd');
  await mkdir(join(install, shimDir), { recursive: true });
  // Deliberately mirrors the real, stale shim: it names app.asar.
  await writeFile(
    shimPath,
    `@echo off\r\n"${exe}" --expose-internals "${install}\\resources\\app.asar\\lib\\desktop-cli.js" %*\r\n`,
    'utf8',
  );
  return { install, exe, cli, shim: shimPath };
}

test('a nested shim resolves to the real executable and its CLI script', async () => {
  const { discoverWindowsCommand } = await import('../src/discovery.js');
  const fake = await makeFakeInstall();

  const found = discoverWindowsCommand(fake.shim);

  assert.equal(found.command[0], fake.exe);
  assert.ok(
    found.command.includes(fake.cli),
    `expected the discovered CLI script in ${found.command.join(' ')}`,
  );
  assert.ok(found.command.includes('--profile'));
  assert.equal(found.command.at(-1), 'headless');
  assert.equal(found.env.ELECTRON_RUN_AS_NODE, '1');
});

test('an install without the CLI script is refused instead of guessed', async () => {
  const { discoverWindowsCommand } = await import('../src/discovery.js');
  const fake = await makeFakeInstall({ withCli: false });

  assert.equal(discoverWindowsCommand(fake.shim), undefined);
});

test('an unrelated .cmd is left alone rather than misread as a DSH install', async () => {
  const { discoverWindowsCommand } = await import('../src/discovery.js');
  const stray = join(root, 'unrelated', 'tool.cmd');
  await mkdir(join(root, 'unrelated'), { recursive: true });
  await writeFile(stray, '@echo off\r\necho hi\r\n', 'utf8');

  assert.equal(discoverWindowsCommand(stray), undefined);
});

test('a shim whose executable is missing is refused', async () => {
  const { discoverWindowsCommand } = await import('../src/discovery.js');
  const fake = await makeFakeInstall();
  await rm(fake.exe, { force: true });

  assert.equal(discoverWindowsCommand(fake.shim), undefined);
});
