import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createPeerService } from '../src/service.js';

/**
 * The async task protocol over the real MCP surface.
 *
 * These tests drive a paired worker with the real MCP client, the way a peer
 * DSH would: submit returns a task id while the task is still running, status
 * and events answer while it runs, the result arrives once terminal, and a
 * cancel actually aborts the executor. The old ask tool must keep its exact
 * shape on top of the same machinery.
 */

const homes = [];
const newHome = async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peer-tasks-svc-'));
  homes.push(home);
  return home;
};
test.after(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

/** An executor the test controls: nothing settles until the test decides. */
const makeDeferredExecutor = () => {
  const pending = [];
  return {
    pending,
    async ask(input) {
      // The compat-path prompt settles immediately so the synchronous ask
      // tool call can finish without the test reaching into it.
      if (input.prompt === 'sync job') {
        return { answer: 'sync answer', stderr: '', exitCode: 0, timedOut: false };
      }
      return await new Promise((resolve) => {
        pending.push({ input, resolve });
        input.signal?.addEventListener('abort', () => {
          resolve({ answer: '', stderr: '', exitCode: null, timedOut: false, cancelled: true });
        });
      });
    },
  };
};

const call = (client, name, arguments_) => client.callTool({ name, arguments: arguments_ });
const body = (result) => JSON.parse(result.content[0].text);

test('submit returns a task id immediately, and the protocol answers around it', async () => {
  const executor = makeDeferredExecutor();
  const worker = await createPeerService({
    home: await newHome(),
    deviceName: 'worker',
    executor,
    listen: true,
    host: '127.0.0.1',
    port: 0,
    allowedDirs: [tmpdir()],
    log: () => {},
  });
  const desk = await createPeerService({
    home: await newHome(),
    deviceName: 'desk',
    executor: { ask: async () => ({ answer: '', stderr: '', exitCode: 0, timedOut: false }) },
    listen: false,
    log: () => {},
  });

  let client;
  try {
    const ticket = await worker.createTicket();
    await desk.pair({ link: ticket.link });

    client = new Client({ name: 'tasks-e2e', version: '1.0.0' }, { capabilities: {} });
    const origin = worker.status().url;
    const transport = new StreamableHTTPClientTransport(new URL(origin), {
      requestInit: { headers: { authorization: `Bearer ${desk.credentialFor('desk')}` } },
    });
    await client.connect(transport);

    // 1) submit answers while the task hangs.
    const submitted = body(await call(client, 'submit_task', { prompt: 'long job', cwd: tmpdir() }));
    assert.equal(submitted.ok, true);
    assert.match(submitted.taskId, /^task-/u);
    assert.equal(submitted.status, 'running');
    assert.equal(executor.pending.length, 1, 'the executor was entered exactly once');

    // 2) status and events answer mid-run; result is not terminal yet.
    const status = body(await call(client, 'task_status', { taskId: submitted.taskId }));
    assert.equal(status.status, 'running');

    const early = body(await call(client, 'task_events', { taskId: submitted.taskId }));
    assert.ok(early.events.some((event) => event.type === 'submitted'));
    assert.ok(early.events.some((event) => event.type === 'started'));

    const notTerminal = await call(client, 'task_result', { taskId: submitted.taskId });
    assert.equal(notTerminal.isError, true, 'a running task has no result yet');
    assert.equal(body(notTerminal).code, 'task-not-terminal');

    // 3) the executor settles; the result keeps the ask wire shape.
    executor.pending[0].resolve({ answer: 'the answer', stderr: '', exitCode: 0, timedOut: false });
    for (let tick = 0; tick < 50 && body(await call(client, 'task_status', { taskId: submitted.taskId })).status === 'running'; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const result = body(await call(client, 'task_result', { taskId: submitted.taskId }));
    assert.deepEqual(result, { ok: true, answer: 'the answer', exitCode: 0, outcome: 'task completed' });

    // 4) events after the cursor are exactly the terminal one.
    const late = body(await call(client, 'task_events', { taskId: submitted.taskId, cursor: early.nextCursor }));
    assert.deepEqual(late.events.map((event) => event.type), ['completed']);

    // 5) an idempotent resubmit returns the same task: the first submit had no
    // key (run 1), the keyed submit creates task 2 (run 2), and resubmitting
    // the key returns task 2 again without a third run.
    const again = body(await call(client, 'submit_task', { prompt: 'long job', cwd: tmpdir(), idempotencyKey: 'op-e2e' }));
    const keyed = body(await call(client, 'submit_task', { prompt: 'long job', cwd: tmpdir(), idempotencyKey: 'op-e2e' }));
    assert.equal(again.taskId, keyed.taskId, 'the same key must map to the same task');
    assert.equal(
      executor.pending.length,
      2,
      'only the unkeyed task and the new keyed task ran; the resubmit added nothing',
    );
  } finally {
    await client?.close().catch(() => {});
    await worker.stop();
    await desk.stop();
  }
});

test('cancel_task aborts a running task, and the old ask keeps its shape', async () => {
  const executor = makeDeferredExecutor();
  const worker = await createPeerService({
    home: await newHome(),
    deviceName: 'worker',
    executor,
    listen: true,
    host: '127.0.0.1',
    port: 0,
    allowedDirs: [tmpdir()],
    log: () => {},
  });
  const desk = await createPeerService({
    home: await newHome(),
    deviceName: 'desk',
    executor: { ask: async () => ({ answer: '', stderr: '', exitCode: 0, timedOut: false }) },
    listen: false,
    log: () => {},
  });

  let client;
  try {
    const ticket = await worker.createTicket();
    await desk.pair({ link: ticket.link });

    client = new Client({ name: 'tasks-cancel', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(worker.status().url), {
      requestInit: { headers: { authorization: `Bearer ${desk.credentialFor('desk')}` } },
    });
    await client.connect(transport);

    const submitted = body(await call(client, 'submit_task', { prompt: 'hangs', cwd: tmpdir() }));
    const cancelled = body(await call(client, 'cancel_task', { taskId: submitted.taskId }));
    assert.equal(cancelled.ok, true);

    for (let tick = 0; tick < 50 && body(await call(client, 'task_status', { taskId: submitted.taskId })).status !== 'cancelled'; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(body(await call(client, 'task_status', { taskId: submitted.taskId })).status, 'cancelled');
    const result = await call(client, 'task_result', { taskId: submitted.taskId });
    assert.equal(body(result).code, 'task-cancelled');

    // The compat path: ask still returns the original wire shape, end to end.
    const asked = await call(client, 'ask', { prompt: 'sync job', cwd: tmpdir() });
    assert.ok(asked.isError !== true, JSON.stringify(asked));
    const askBody = body(asked);
    assert.equal(askBody.ok, true);
    assert.equal(askBody.answer, 'sync answer');
    assert.equal(askBody.outcome, 'task completed');
  } finally {
    await client?.close().catch(() => {});
    await worker.stop();
    await desk.stop();
  }
});
