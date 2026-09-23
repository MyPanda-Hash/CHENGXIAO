import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskManager } from '../src/tasks.js';

/**
 * The worker-side task manager.
 *
 * Tasks run on this machine, so this machine holds their state: a submit
 * returns a task id immediately, and status/events/result/cancel survive any
 * number of caller reconnects — including the relay dropping mid-run. What is
 * pinned here is the whole contract the async protocol promises.
 */

/** A controllable run: resolves when the test decides. */
const makeDeferredRun = () => {
  const runs = [];
  return {
    runs,
    run(task, options) {
      return new Promise((resolve) => runs.push({ task, options, resolve }));
    },
  };
};

test('submit returns a task id immediately and the task runs', async () => {
  const deferred = makeDeferredRun();
  const manager = createTaskManager({ run: deferred.run });
  const submitted = manager.submit({ request: { prompt: 'p' } });

  assert.match(submitted.taskId, /^task-/u);
  assert.equal(submitted.status, 'running', 'with maxConcurrent 1 the first task starts immediately');
  assert.equal(manager.statusOf(submitted.taskId).status, 'running');

  deferred.runs[0].resolve({ ok: true, answer: 'a', exitCode: 0, outcome: 'task completed' });
  await manager.settled();

  assert.equal(manager.statusOf(submitted.taskId).status, 'completed');
  assert.deepEqual(manager.resultOf(submitted.taskId), {
    ok: true,
    answer: 'a',
    exitCode: 0,
    outcome: 'task completed',
  });
});

test('a second task queues behind a running one, then starts', async () => {
  const deferred = makeDeferredRun();
  const manager = createTaskManager({ run: deferred.run });
  const first = manager.submit({ request: { prompt: '1' } });
  const second = manager.submit({ request: { prompt: '2' } });

  assert.equal(manager.statusOf(second.taskId).status, 'queued');

  deferred.runs[0].resolve({ ok: true, answer: '', exitCode: 0, outcome: 'task completed' });
  await manager.settled();

  assert.equal(manager.statusOf(first.taskId).status, 'completed');
  assert.equal(manager.statusOf(second.taskId).status, 'running', 'the queued task starts when a slot frees');
});

test('an idempotency key returns the same task instead of running it twice', async () => {
  const deferred = makeDeferredRun();
  const manager = createTaskManager({ run: deferred.run });
  const first = manager.submit({ request: { prompt: 'p' }, idempotencyKey: 'op-1' });
  const again = manager.submit({ request: { prompt: 'p' }, idempotencyKey: 'op-1' });

  assert.equal(again.taskId, first.taskId);
  assert.equal(deferred.runs.length, 1, 'the task must not run twice');
});

test('events stream with a cursor, incrementally', async () => {
  const deferred = makeDeferredRun();
  const manager = createTaskManager({ run: deferred.run });
  const { taskId } = manager.submit({ request: { prompt: 'p' } });

  const early = manager.eventsOf(taskId);
  assert.ok(early.events.some((event) => event.type === 'submitted'));
  assert.ok(early.events.some((event) => event.type === 'started'));
  assert.equal(typeof early.nextCursor, 'number');

  deferred.runs[0].resolve({ ok: true, answer: '', exitCode: 0, outcome: 'task completed' });
  await manager.settled();

  const late = manager.eventsOf(taskId, early.nextCursor);
  assert.deepEqual(late.events.map((event) => event.type), ['completed'], 'only events after the cursor');
  assert.equal(manager.eventsOf(taskId, late.nextCursor).events.length, 0);
});

test('cancelling a running task aborts it and records cancelled', async () => {
  const signals = [];
  const manager = createTaskManager({
    run: (task, { signal }) =>
      new Promise((resolve) => {
        signals.push(signal);
        signal.addEventListener('abort', () => resolve({ ok: false, code: 'task-cancelled' }));
      }),
  });
  const { taskId } = manager.submit({ request: { prompt: 'p' } });

  const cancelled = manager.cancel(taskId);
  assert.equal(cancelled.ok, true);
  await manager.settled();

  assert.equal(manager.statusOf(taskId).status, 'cancelled');
  assert.equal(signals[0].aborted, true);
});

test('cancelling a queued task skips it entirely', async () => {
  const deferred = makeDeferredRun();
  const manager = createTaskManager({ run: deferred.run });
  manager.submit({ request: { prompt: 'first' } });
  const queued = manager.submit({ request: { prompt: 'second' } });

  manager.cancel(queued.taskId);
  await manager.settled();

  assert.equal(manager.statusOf(queued.taskId).status, 'cancelled');
  deferred.runs[0].resolve({ ok: true, answer: '', exitCode: 0, outcome: 'task completed' });
  await manager.settled();
  assert.equal(deferred.runs.length, 1, 'the cancelled task never ran');
});

test('terminal results expire after the retention window', async () => {
  let now = 1_000_000;
  const manager = createTaskManager({
    run: async () => ({ ok: true, answer: '', exitCode: 0, outcome: 'task completed' }),
    clock: () => new Date(now),
    retentionMs: 60_000,
  });
  const { taskId } = manager.submit({ request: { prompt: 'p' } });
  await manager.settled();
  assert.equal(manager.statusOf(taskId).status, 'completed');

  now += 61_000;
  assert.equal(manager.statusOf(taskId).status, 'expired', 'past retention the result is gone');
  assert.equal(manager.resultOf(taskId), undefined);
  assert.ok(manager.eventsOf(taskId).events.some((event) => event.type === 'expired'));
});

test('a failing run records failed with the refusal as its result', async () => {
  const manager = createTaskManager({
    run: async () => ({ ok: false, code: 'task-failed', detail: 'boom' }),
  });
  const { taskId } = manager.submit({ request: { prompt: 'p' } });
  await manager.settled();

  assert.equal(manager.statusOf(taskId).status, 'failed');
  assert.deepEqual(manager.resultOf(taskId), { ok: false, code: 'task-failed', detail: 'boom' });
});

test('an unknown task id is an answer, not a throw', () => {
  const manager = createTaskManager({ run: async () => ({ ok: true }) });
  assert.equal(manager.statusOf('no-such-task'), undefined);
  assert.equal(manager.cancel('no-such-task').ok, false);
  assert.equal(manager.cancel('no-such-task').code, 'task-unknown');
});
