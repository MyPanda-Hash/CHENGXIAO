import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One throwaway workspace directory per test file run. */
const workspace = await mkdtemp(join(tmpdir(), 'dsh-peer-ask-'));
test.after(() => rm(workspace, { recursive: true, force: true }));

/**
 * A stand-in for `dsh --profile headless <task>`: a real child process that
 * echoes what it received, so tests exercise the real spawn path and can never
 * pass by asserting against a mock.
 */
const taskEndingWith = (text) => [
  process.execPath,
  '-e',
  `process.stdout.write(${JSON.stringify(text)})`,
];

test('a finished task yields its answer and exit code', async () => {
  const { createHeadlessExecutor } = await import('../src/headless.js');

  const executor = createHeadlessExecutor({
    command: taskEndingWith('42 tests passed\n'),
  });
  const result = await executor.ask({ prompt: 'run the tests', cwd: workspace });

  assert.equal(result.answer, '42 tests passed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test('the child runs in the requested working directory, not the server one', async () => {
  const { createHeadlessExecutor } = await import('../src/headless.js');
  await writeFile(join(workspace, 'marker.txt'), 'here', 'utf8');

  const executor = createHeadlessExecutor({
    command: [
      process.execPath,
      '-e',
      "process.stdout.write(require('node:fs').readdirSync('.').sort().join(','))",
    ],
  });
  const result = await executor.ask({ prompt: 'list', cwd: workspace });

  assert.match(result.answer, /marker\.txt/);
});

test('a task that never finishes is killed and reported as a timeout', async () => {
  const { createHeadlessExecutor } = await import('../src/headless.js');

  const executor = createHeadlessExecutor({
    command: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'],
    timeoutMs: 1_500,
  });
  const started = Date.now();
  const result = await executor.ask({ prompt: 'hang', cwd: workspace });

  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.ok(
    Date.now() - started < 20_000,
    'the executor must not wait for the child to finish on its own',
  );
});

test('a failing task keeps its stderr for diagnosis', async () => {
  const { createHeadlessExecutor } = await import('../src/headless.js');

  const executor = createHeadlessExecutor({
    command: [
      process.execPath,
      '-e',
      'process.stderr.write("boom: no such profile"); process.exit(1)',
    ],
  });
  const result = await executor.ask({ prompt: 'fail', cwd: workspace });

  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
  assert.match(result.stderr, /boom/);
});

test('the prompt reaches the child as one argument, unmangled', async () => {
  const { createHeadlessExecutor } = await import('../src/headless.js');

  const executor = createHeadlessExecutor({
    command: [
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      '--',
    ],
  });
  const prompt = 'fix "quotes" & pipe | other';
  const result = await executor.ask({ prompt, cwd: workspace });

  assert.deepEqual(JSON.parse(result.answer), [prompt]);
});

test('a child that cannot be started reports the spawn failure instead of throwing', async () => {
  const { createHeadlessExecutor } = await import('../src/headless.js');

  const executor = createHeadlessExecutor({
    command: [join(workspace, 'definitely-missing-binary.exe')],
  });
  const result = await executor.ask({ prompt: 'x', cwd: workspace });

  assert.equal(result.timedOut, false);
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.stderr.length > 0, 'a spawn failure must be diagnosable');
});

test('the executor never shells out, so a prompt cannot inject a command', async () => {
  const { createHeadlessExecutor } = await import('../src/headless.js');

  const probe = join(workspace, 'injected.txt');
  const executor = createHeadlessExecutor({
    command: taskEndingWith('done'),
  });
  await executor.ask({
    prompt: `x & echo pwned > "${probe}"`,
    cwd: workspace,
  });

  await assert.rejects(
    () => import('node:fs/promises').then((fs) => fs.stat(probe)),
    'shell metacharacters in a prompt must not reach a shell',
  );
  assert.equal(spawnSync(process.execPath, ['-e', '0']).status, 0);
});

test('a cancelled task reports cancellation, not failure', async () => {
  const { runAsk } = await import('../src/ask.js');
  const controller = new AbortController();
  const executor = {
    ask: (input) =>
      new Promise((resolve) => {
        input.signal?.addEventListener('abort', () =>
          resolve({ answer: '', stderr: '', exitCode: null, timedOut: false, cancelled: true }),
        );
      }),
  };

  const pending = runAsk(
    { prompt: 'p' },
    { executor, defaultCwd: workspace, policy: {} },
    { signal: controller.signal },
  );
  controller.abort();
  const answer = await pending;

  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'task-cancelled');
});

test('an abort signal kills a hanging child and reports cancellation', async () => {
  const { createHeadlessExecutor } = await import('../src/headless.js');

  const executor = createHeadlessExecutor({
    command: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'],
  });
  const controller = new AbortController();
  const started = Date.now();
  const pending = executor.ask({ prompt: 'hang', cwd: workspace, signal: controller.signal });

  await new Promise((resolve) => setTimeout(resolve, 300));
  controller.abort();
  const result = await pending;

  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.ok(
    Date.now() - started < 20_000,
    'an aborted child must be killed, not waited out',
  );
});

test('an already-aborted signal never starts the child', async () => {
  const { createHeadlessExecutor } = await import('../src/headless.js');

  const executor = createHeadlessExecutor({
    command: taskEndingWith('should never run'),
  });
  const controller = new AbortController();
  controller.abort();

  const result = await executor.ask({ prompt: 'x', cwd: workspace, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.answer, '');
});
