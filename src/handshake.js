import { DEFAULT_PEER_POLICY } from './trust.js';

/**
 * The pairing handshake: one HTTP request that turns a pairing code into a peer.
 *
 * Two rules are enforced here rather than left to callers:
 *
 * - **The claimant never chooses its own privilege.** The permission preset
 *   comes from the ticket the operator issued, never from the request body. A
 *   peer that asks for `danger-full-access` is paired at the operator's level.
 * - **Malformed input never burns the live code.** Validation happens before
 *   the code is consumed, so a typo costs an attempt, not the pairing.
 *
 * Brute force is answered with per-source throttling: a wrong code is cheap to
 * try, so counting failures by source is what keeps guessing impractical.
 */

/** Longest accepted peer display name. */
const MAX_NAME = 64;

/** Longest accepted public key. Real keys are far shorter; this only stops abuse. */
const MAX_PUBLIC_KEY = 512;

/** Status codes this module answers with. */
const STATUS = Object.freeze({
  created: 201,
  badRequest: 400,
  forbidden: 403,
  throttled: 429,
});

/** Stable error with a `code`. */
class HandshakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HandshakeError';
    this.code = code;
  }
}

/**
 * Build a per-source failure counter.
 *
 * @param {{ maxFailures?: number }} [options] - how many failures a source may accumulate.
 * @returns {{ blocked: (source: string) => boolean, recordFailure: (source: string) => void, clear: (source: string) => void, failuresFor: (source: string) => number }} the throttle.
 */
export function createPairThrottle({ maxFailures = 5 } = {}) {
  const failures = new Map();
  const countFor = (source) => failures.get(source) ?? 0;

  return {
    blocked(source) {
      return countFor(source) >= maxFailures;
    },
    recordFailure(source) {
      failures.set(source, countFor(source) + 1);
    },
    clear(source) {
      failures.delete(source);
    },
    failuresFor: countFor,
  };
}

/**
 * Handle one pairing request.
 *
 * `source` and `address` are deliberately two parameters, because they answer
 * two different questions and only one of them may key the throttle. `address`
 * is this worker's own address, which is the same on every request and is
 * reported back to the peer. `source` identifies the caller. Keying the throttle
 * on `address` would give every caller one shared failure budget, so one noisy
 * machine could lock out every other machine.
 *
 * @param {{
 *   body: unknown,
 *   address: string,
 *   source?: string,
 *   trust: { identity: { installId: string }, addPeer: (input: object) => Promise<{ peer: object, credential: string }> },
 *   pairing: { consume: (code: string, claim: object) => Promise<object> },
 *   throttle?: ReturnType<typeof createPairThrottle>,
 *   peerFields?: object,
 * }} input - one handshake attempt.
 * @returns {Promise<{ status: number, body: object }>} the HTTP answer.
 */
export async function handlePair({ body, address, source, trust, pairing, throttle, peerFields }) {
  if (source !== undefined && throttle?.blocked(source) === true) {
    return {
      status: STATUS.throttled,
      body: { ok: false, code: 'throttled', detail: 'too many failed pairing attempts from this machine' },
    };
  }

  const invalid = validateClaim(body);
  if (invalid !== undefined) {
    return { status: STATUS.badRequest, body: { ok: false, code: invalid } };
  }

  const claim = /** @type {{ code: string, name: string, publicKey: string }} */ (body);

  let consumed;
  try {
    consumed = await pairing.consume(claim.code, {
      name: claim.name.trim(),
      publicKey: claim.publicKey,
    });
  } catch (cause) {
    if (source !== undefined) throttle?.recordFailure(source);
    return {
      status: STATUS.forbidden,
      body: { ok: false, code: cause?.code ?? 'pairing-refused', detail: cause?.message },
    };
  }

  // The preset is the operator's grant, carried by the ticket. A request body
  // that names a policy was already ignored by validation above. `peerFields`
  // is caller-side data (never request data) the record should carry, such as
  // the relay channel key for peers paired through a relay.
  const { peer, credential } = await trust.addPeer({
    name: claim.name.trim(),
    publicKey: claim.publicKey,
    policy: consumed.policy ?? DEFAULT_PEER_POLICY,
    ...(peerFields !== undefined && { ...peerFields }),
  });

  if (source !== undefined) throttle?.clear(source);

  return {
    status: STATUS.created,
    body: {
      ok: true,
      credential,
      peer,
      worker: {
        installId: trust.identity.installId,
        address,
      },
    },
  };
}

/**
 * Check a claim before any secret is spent.
 *
 * @param {unknown} body - the parsed request body.
 * @returns {string | undefined} a stable code describing the problem, or undefined when acceptable.
 */
function validateClaim(body) {
  if (typeof body !== 'object' || body === null) return 'claim-malformed';
  const { code, name, publicKey } = /** @type {Record<string, unknown>} */ (body);

  if (typeof code !== 'string' || code.trim() === '') return 'code-missing';
  if (typeof name !== 'string' || name.trim() === '') return 'name-missing';
  if (name.trim().length > MAX_NAME) return 'name-too-long';
  if (typeof publicKey !== 'string' || publicKey.trim() === '') return 'public-key-missing';
  if (publicKey.length > MAX_PUBLIC_KEY) return 'public-key-too-long';

  return undefined;
}
