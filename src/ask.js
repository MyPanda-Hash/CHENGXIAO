import { REJECT } from './reject.js';

/**
 * The task channel: one question from a peer, one answer from this machine.
 *
 * The channel never throws for a request it can reason about — it answers with
 * a stable code instead. Only a failure inside the task runner itself becomes an
 * execution error, so the peer can tell "you may not ask that" apart from
 * "your task ran and broke".
 */

/** Task runner refused to run because this machine is not set up for peer work. */
export const NOT_CONFIGURED = 'not-configured';

/**
 * Answer one peer task.
 *
 * A task that ran and failed is reported as a failure, never as an empty
 * success: the peer has to be able to tell "your task finished and said
 * nothing" apart from "your task died", because it decides what to do next.
 *
 * @param {{ prompt: string, cwd?: string, timeoutMs?: number }} request - the peer's request.
 * @param {{ executor: { ask: (input: { prompt: string, cwd: string, timeoutMs?: number, signal?: AbortSignal }) => Promise<{ answer: string, stderr: string, exitCode: number | null, timedOut: boolean, cancelled?: boolean }> }, defaultCwd: string, policy?: { allowedDirs?: string[] } }} deps - the task runner and Adapter policy.
 * @param {{ signal?: AbortSignal }} [options] - an abort signal from the async task manager.
 * @returns {Promise<{ ok: true, answer: string, exitCode: number, outcome: string } | { ok: false, code: string, detail?: string }>} a wire-shaped answer.
 */
export async function runAsk(request, { executor, defaultCwd, policy = {} }, { signal } = {}) {
  const cwd = request?.cwd ?? defaultCwd;
  const rejection = REJECT({ prompt: request?.prompt, cwd }, policy);
  if (rejection !== undefined) return rejection;

  const result = await executor.ask({
    prompt: request.prompt,
    cwd,
    ...(request.timeoutMs !== undefined && { timeoutMs: request.timeoutMs }),
    ...(signal !== undefined && { signal }),
  });

  // A cancellation is the caller's decision, not a task outcome: it must read
  // as cancelled rather than as a failure the caller might retry blindly.
  if (result.cancelled === true) {
    return { ok: false, code: 'task-cancelled', detail: 'the task was cancelled before it finished' };
  }
  if (result.timedOut) {
    return { ok: false, code: 'task-timeout', detail: 'the task was still running when its ceiling was reached' };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      code: 'task-failed',
      detail: describeOutcome(result),
    };
  }

  return {
    ok: true,
    answer: result.answer,
    exitCode: result.exitCode,
    outcome: describeOutcome(result),
  };
}

/**
 * Render the diagnostic tail of a task answer for the peer.
 *
 * @param {{ stderr: string, exitCode: number | null, timedOut: boolean }} result - raw runner result.
 * @returns {string} one line describing how the task ended.
 */
export function describeOutcome({ stderr, exitCode, timedOut }) {
  if (timedOut) return 'task timed out and was killed';
  if (exitCode === 0) return 'task completed';
  const detail = stderr === '' ? 'no stderr' : stderr.split('\n').slice(-3).join(' | ');
  return `task exited with code ${String(exitCode)}: ${detail}`;
}
