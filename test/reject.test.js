import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The Adapter must refuse a peer request for identifiable reasons instead of
 * silently doing nothing. Every case here is a request the Adapter can never
 * answer honestly, so the answer has to be a rejection with a stable code.
 */
test('an invalid ask request is rejected with its own code', async () => {
  const { REJECT } = await import('../src/reject.js');

  const tooLong = { prompt: 'x'.repeat(8001), cwd: 'C:\\work' };
  const missingPrompt = { cwd: 'C:\\work' };
  const emptyPrompt = { prompt: '   ', cwd: 'C:\\work' };
  const missingCwd = { prompt: 'hello' };

  assert.deepEqual(REJECT(tooLong), { ok: false, code: 'prompt-too-long' });
  assert.deepEqual(REJECT(missingPrompt), { ok: false, code: 'prompt-missing' });
  assert.deepEqual(REJECT(emptyPrompt), { ok: false, code: 'prompt-missing' });
  assert.deepEqual(REJECT(missingCwd), { ok: false, code: 'cwd-missing' });
});

test('a well-formed ask request is accepted', async () => {
  const { REJECT } = await import('../src/reject.js');

  assert.equal(
    REJECT({ prompt: 'run the tests', cwd: 'C:\\work' }),
    undefined,
  );
});

test('a cwd outside the allowlist is rejected by path, not by guessing', async () => {
  const { REJECT } = await import('../src/reject.js');

  const inside = REJECT(
    { prompt: 'x', cwd: 'C:\\work\\sub' },
    { allowedDirs: ['C:\\work'] },
  );
  const outside = REJECT(
    { prompt: 'x', cwd: 'C:\\other' },
    { allowedDirs: ['C:\\work'] },
  );
  const sibling = REJECT(
    { prompt: 'x', cwd: 'C:\\work-evil' },
    { allowedDirs: ['C:\\work'] },
  );

  assert.equal(inside, undefined, 'a child directory of an allowed dir is allowed');
  assert.deepEqual(outside, { ok: false, code: 'cwd-not-allowed' });
  assert.deepEqual(
    sibling,
    { ok: false, code: 'cwd-not-allowed' },
    'a name that merely shares a prefix must not pass the allowlist',
  );
});
