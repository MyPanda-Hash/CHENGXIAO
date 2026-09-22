import { isAbsolute, relative, resolve } from 'node:path';

/**
 * The Adapter answers a peer DSH, which may be running a different model with
 * a different idea of what is reasonable. Everything that can be decided
 * without running anything is decided here, up front, so a rejected request
 * costs one round trip and never touches this machine.
 */

/** Longest prompt the Adapter forwards; beyond this the peer is not asking, it is dumping. */
export const MAX_PROMPT_CHARS = 8000;

/**
 * Whether `candidate` is `root` itself or lives below it.
 *
 * Compares resolved paths component-wise, so `C:\work-evil` is not inside
 * `C:\work` even though the string starts the same way.
 *
 * @param {string} candidate - absolute path to test.
 * @param {string} root - absolute directory that may contain it.
 * @returns {boolean} true when candidate is root or a descendant of it.
 */
export function isPathInside(candidate, root) {
  const from = resolve(root);
  const to = resolve(candidate);
  const step = relative(from, to);
  return step === '' || (!step.startsWith('..') && !isAbsolute(step));
}

/**
 * Decide whether an ask request can be answered at all.
 *
 * @param {{ prompt?: unknown, cwd?: unknown }} request - peer-supplied fields.
 * @param {{ allowedDirs?: string[] }} [policy] - Adapter policy; no allowlist means no path limit.
 * @returns {{ ok: false, code: string } | undefined} a rejection, or undefined when the request is acceptable.
 */
export function REJECT(request, policy = {}) {
  const prompt = request?.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, code: 'prompt-missing' };
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { ok: false, code: 'prompt-too-long' };
  }

  const cwd = request?.cwd;
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return { ok: false, code: 'cwd-missing' };
  }

  const allowedDirs = policy.allowedDirs;
  if (Array.isArray(allowedDirs) && allowedDirs.length > 0) {
    const permitted = allowedDirs.some((dir) => isPathInside(cwd, dir));
    if (!permitted) return { ok: false, code: 'cwd-not-allowed' };
  }

  return undefined;
}
