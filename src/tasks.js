import { randomUUID } from 'node:crypto';

/**
 * The worker-side async task manager.
 *
 * Tasks run on this machine, so this machine holds their state: a submit
 * returns a task id immediately, and status/events/result/cancel answer later
 * calls — including after the caller disconnected and reconnected, which is
 * the whole point of the async protocol. Idempotency keys make retries safe,
 * a bounded concurrency queue keeps one peer from stacking unlimited agent
 * turns on this machine, and terminal results expire on a retention clock
 * instead of accumulating forever.
 */

/** How long a terminal task's result stays readable. */
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Task states, per the design spec. */
export const TASK_STATES = Object.freeze([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'expired',
]);

/** Stable error with a `code`. */
class TaskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
  }
}

/**
 * Create one task manager.
 *
 * @param {{
 *   run: (task: object, options: { signal: AbortSignal }) => Promise<{ ok: boolean } & Record<string, unknown>>,
 *   clock?: () => Date,
 *   retentionMs?: number,
 *   maxConcurrent?: number,
 * }} options - the task runner (returns the wire-shaped answer), clock and limits.
 * @returns {{
 *   submit: (input: { request: object, idempotencyKey?: string, meta?: object }) => { taskId: string, status: string, createdAt: string },
 *   statusOf: (taskId: string) => object | undefined,
 *   eventsOf: (taskId: string, cursor?: number) => { events: object[], nextCursor: number } | undefined,
 *   resultOf: (taskId: string) => object | undefined,
 *   cancel: (taskId: string) => { ok: boolean, code?: string },
 *   settled: () => Promise<void>,
 * }} the manager.
 */
export function createTaskManager({
  run,
  clock = () => new Date(),
  retentionMs = DEFAULT_RETENTION_MS,
  maxConcurrent = 1,
}) {
  if (typeof run !== 'function') throw new TaskError('run-required', 'a task manager needs a run function');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new TaskError('max-concurrent-invalid', 'maxConcurrent must be a positive integer');
  }

  const tasks = new Map(); // taskId -> record
  const byIdempotencyKey = new Map(); // key -> taskId
  const queue = []; // taskIds waiting for a slot

  /** Append one lifecycle event to a record. */
  const append = (record, type) => {
    record.events.push({ seq: record.events.length + 1, type, at: clock().toISOString() });
  };

  /** Drop the result of a terminal task past its retention window. */
  const sweepRecord = (record) => {
    if (record.status === 'expired') return record;
    if (!TERMINAL.has(record.status) || record.endedAt === undefined) return record;
    if (clock().getTime() - new Date(record.endedAt).getTime() <= retentionMs) return record;

    record.status = 'expired';
    record.result = undefined;
    if (record.idempotencyKey !== undefined) byIdempotencyKey.delete(record.idempotencyKey);
    append(record, 'expired');
    return record;
  };

  const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

  /** Start as many queued tasks as the concurrency limit allows. */
  const pump = () => {
    while (runningCount() < maxConcurrent && queue.length > 0) {
      const taskId = queue.shift();
      const record = tasks.get(taskId);
      if (record === undefined || record.status !== 'queued') continue;
      start(record);
    }
  };

  const runningCount = () => {
    let count = 0;
    for (const record of tasks.values()) if (record.status === 'running') count += 1;
    return count;
  };

  /** Run one task to its terminal state, then pump the queue. */
  const start = (record) => {
    record.status = 'running';
    record.startedAt = clock().toISOString();
    append(record, 'started');

    const controller = new AbortController();
    record.controller = controller;

    // The run is invoked synchronously so the caller can rely on state (and
    // the signal) existing the moment submit returns; a synchronous throw is
    // still handled as a rejected run.
    let running;
    try {
      running = run({ ...record.request, taskId: record.taskId }, { signal: controller.signal });
    } catch (cause) {
      running = Promise.reject(cause);
    }

    Promise.resolve(running).then(
      (result) => {
        record.result = result ?? { ok: false, code: 'task-empty-result' };
        record.endedAt = clock().toISOString();
        // A cancellation the manager initiated is a cancellation, whatever
        // shape the aborted run settled with.
        record.status = record.cancelRequested ? 'cancelled' : record.result.ok === true ? 'completed' : 'failed';
        append(record, record.status);
        pump();
      },
      (cause) => {
        record.result = { ok: false, code: 'task-crashed', detail: String(cause?.message ?? cause) };
        record.endedAt = clock().toISOString();
        record.status = record.cancelRequested ? 'cancelled' : 'failed';
        append(record, record.status);
        pump();
      },
    );
  };

  /** The public summary of a record. */
  const summaryOf = (record) => ({
    taskId: record.taskId,
    status: record.status,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    queued: record.status === 'queued',
  });

  return {
    submit({ request, idempotencyKey, meta } = {}) {
      if (idempotencyKey !== undefined && byIdempotencyKey.has(idempotencyKey)) {
        const existing = tasks.get(byIdempotencyKey.get(idempotencyKey));
        if (existing !== undefined && existing.status !== 'expired') {
          return summaryOf(existing);
        }
      }

      const taskId = `task-${randomUUID()}`;
      const record = {
        taskId,
        status: 'queued',
        request,
        ...(meta !== undefined && { meta }),
        ...(idempotencyKey !== undefined && { idempotencyKey }),
        events: [],
        createdAt: clock().toISOString(),
      };
      append(record, 'submitted');
      tasks.set(taskId, record);
      if (idempotencyKey !== undefined) byIdempotencyKey.set(idempotencyKey, taskId);
      queue.push(taskId);
      pump();
      return summaryOf(record);
    },

    statusOf(taskId) {
      const record = tasks.get(taskId);
      if (record === undefined) return undefined;
      return summaryOf(sweepRecord(record));
    },

    eventsOf(taskId, cursor = 0) {
      const record = tasks.get(taskId);
      if (record === undefined) return undefined;
      sweepRecord(record);
      const events = record.events.filter((event) => event.seq > cursor);
      const nextCursor = events.length > 0 ? events[events.length - 1].seq : cursor;
      return { events, nextCursor };
    },

    resultOf(taskId) {
      const record = tasks.get(taskId);
      if (record === undefined) return undefined;
      sweepRecord(record);
      if (!TERMINAL.has(record.status)) return undefined;
      return record.result;
    },

    cancel(taskId) {
      const record = tasks.get(taskId);
      if (record === undefined) return { ok: false, code: 'task-unknown' };

      if (record.status === 'queued') {
        const index = queue.indexOf(taskId);
        if (index !== -1) queue.splice(index, 1);
        record.status = 'cancelled';
        record.endedAt = clock().toISOString();
        append(record, 'cancelled');
        return { ok: true };
      }

      if (record.status === 'running') {
        record.cancelRequested = true;
        record.controller?.abort();
        return { ok: true };
      }

      return { ok: false, code: 'task-terminal', detail: `the task already ended as ${record.status}` };
    },

    settled: async () => {
      // Drain the microtask queue past every bookkeeping chain a settled run
      // can schedule. Deterministic (microtask order is fixed), bounded (runs
      // still pending by design are never awaited), and enough margin for the
      // resolve → terminal-handler → pump chain.
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    },
  };
}
