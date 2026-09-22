import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The ask channel's failure vocabulary. A peer decides what to do next from
 * these answers, so "your task died" must never masquerade as "your task
 * finished and said nothing".
 */

const workspace = await mkdtemp(join(tmpdir(), 'dsh-peer-askrun-'));
test.after(() => rm(workspace, { recursive: true, force: true }));

/** An executor that plays back one canned result. */
const executorReturning = (result) => ({
  asked: [],
  async ask(input) {
    this.asked.push(input);
    return result;
  },
});

test('a task that ran and failed is reported as a failure, not an empty success', async () => {
  const { runAsk } = await import('../src/ask.js');
  const executor = executorReturning({
    answer: '',
    stderr: 'no such profile: headless',
    exitCode: 1,
    timedOut: false,
  });

  const answer = await runAsk({ prompt: 'x', cwd: workspace }, { executor, defaultCwd: workspace });

  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'task-failed');
  assert.match(answer.detail, /no such profile/u);
});

test('a task killed at its ceiling is reported as a timeout', async () => {
  const { runAsk } = await import('../src/ask.js');
  const executor = executorReturning({ answer: 'partial', stderr: '', exitCode: null, timedOut: true });

  const answer = await runAsk({ prompt: 'x', cwd: workspace }, { executor, defaultCwd: workspace });

  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'task-timeout');
});

test('a completed task returns its stdout verbatim with an outcome line', async () => {
  const { runAsk } = await import('../src/ask.js');
  const executor = executorReturning({
    answer: 'all good',
    stderr: '',
    exitCode: 0,
    timedOut: false,
  });

  const answer = await runAsk({ prompt: 'x', cwd: workspace }, { executor, defaultCwd: workspace });

  assert.deepEqual(answer, {
    ok: true,
    answer: 'all good',
    exitCode: 0,
    outcome: 'task completed',
  });
});

test('a rejected request never reaches the task runner', async () => {
  const { runAsk } = await import('../src/ask.js');
  const executor = executorReturning({ answer: 'should not happen', stderr: '', exitCode: 0, timedOut: false });

  const answer = await runAsk(
    { prompt: 'x', cwd: tmpdir() },
    { executor, defaultCwd: workspace, policy: { allowedDirs: [workspace] } },
  );

  assert.deepEqual(answer, { ok: false, code: 'cwd-not-allowed' });
  assert.deepEqual(executor.asked, []);
});

test('a request without a working directory falls back to the Adapter default', async () => {
  const { runAsk } = await import('../src/ask.js');
  const executor = executorReturning({ answer: 'ok', stderr: '', exitCode: 0, timedOut: false });

  await runAsk({ prompt: 'x' }, { executor, defaultCwd: workspace });

  assert.equal(executor.asked[0].cwd, workspace);
});
