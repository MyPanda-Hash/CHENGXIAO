import { timingSafeEqual } from 'node:crypto';

/**
 * The shared-key fence in front of every Adapter route.
 *
 * One machine can run arbitrary work on another through this Adapter, so the
 * key is load-bearing: a key that is absent or trivially short is a
 * configuration error, not a warning. `insecure: true` is the only way past
 * it, and it exists for loopback experiments, never for a network service.
 */

/** Shortest accepted key. 32 base64url bytes is 43 characters; shorter keys are a mistake, not a policy. */
export const MIN_KEY_CHARS = 32;

/** Header the peer presents the shared key in. */
export const KEY_HEADER = 'authorization';

const BEARER = /^Bearer (?<token>[A-Za-z0-9._~+/-]+=*)$/u;

/** Error with a stable `code`, so startup failures are testable and greppable. */
class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/**
 * Read the bearer token out of a request without deciding anything.
 *
 * @param {{ headers?: Record<string, unknown> }} request - an incoming request.
 * @returns {string | undefined} the token, or undefined when the header is absent or malformed.
 */
export function readBearerToken(request) {
  const raw = request?.headers?.[KEY_HEADER];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== 'string') return undefined;
  const match = BEARER.exec(header);
  return match?.groups?.token;
}

/**
 * Build the request verifier.
 *
 * @param {{ key?: string, insecure?: boolean }} options - shared key, or an explicit insecure opt-out.
 * @returns {{ verifies: (request: { headers: Record<string, unknown> }) => boolean, insecure: boolean }} the verifier.
 * @throws {AuthError} when the configuration would expose an unauthenticated Adapter.
 */
export function createAuth({ key, insecure = false } = {}) {
  if (insecure) return { verifies: () => true, insecure: true };

  const sameKey = keyMatcher(key);

  return {
    insecure: false,
    verifies(request) {
      const token = readBearerToken(request);
      return token !== undefined && sameKey(token);
    },
  };
}

/**
 * Build a byte-exact comparison against one key.
 *
 * @param {string} key - the expected key.
 * @returns {(candidate: string) => boolean} the comparison.
 * @throws {AuthError} when the key is too short to be a secret.
 */
function keyMatcher(key) {
  if (typeof key !== 'string' || key.length < MIN_KEY_CHARS) {
    throw new AuthError(
      'key-too-short',
      `dsh-peer-mcp: the shared key must be at least ${String(MIN_KEY_CHARS)} characters; refusing to serve an unauthenticated Adapter`,
    );
  }

  const expected = Buffer.from(key, 'utf8');
  return (candidate) => {
    const actual = Buffer.from(candidate, 'utf8');
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  };
}

/**
 * Answer "who is calling, and what may they do".
 *
 * A shared key can only say whether *someone* may call. A paired credential says
 * *which* machine is calling and carries that peer's policy, which is what makes
 * per-peer revocation and per-peer permission presets real rather than nominal.
 * A credential that is present but wrong never falls through to a weaker path.
 *
 * @param {{
 *   trust: { identify: (credential: unknown) => object | undefined },
 *   legacyKey?: string,
 *   insecure?: boolean,
 * }} options - the trust store and any legacy access path.
 * @returns {(request: { headers?: Record<string, unknown> }) => { ok: true, kind: string, peer?: object } | { ok: false, status: number, code: string }} the verifier.
 */
export function createVerifier({ trust, legacyKey, insecure = false }) {
  const sameLegacyKey = legacyKey === undefined ? undefined : keyMatcher(legacyKey);

  return (request) => {
    const token = readBearerToken(request);

    if (token === undefined) {
      return insecure
        ? { ok: true, kind: 'insecure' }
        : { ok: false, status: 401, code: 'credential-missing' };
    }

    if (sameLegacyKey !== undefined && sameLegacyKey(token)) {
      return { ok: true, kind: 'legacy' };
    }

    const peer = trust.identify(token);
    if (peer !== undefined) return { ok: true, kind: 'peer', peer };

    return { ok: false, status: 401, code: 'credential-unknown' };
  };
}
