/**
 * The settings page's data layer.
 *
 * The browser half of this plugin is a page where an operator does the
 * dangerous things: turns a network listener on, issues a code that lets another
 * machine run work here, and revokes that right again. That work belongs on the
 * host, so the page talks to these routes instead of holding any authority of
 * its own.
 *
 * The route table is deliberately plain: a method, a path, and a body in, a
 * status and a JSON body out. No HTTP objects, no framework — which is what
 * makes every refusal above testable without a server.
 */

/** Presets an operator may grant through the page. */
export const ALLOWED_PRESETS = ['workspace-write', 'danger-full-access'];

/** Path prefix every route lives under, matching how other plugins name theirs. */
export const PREFIX = '/plugins/dsh-peer-mcp';

/** Refusal codes that are a configuration state rather than a bad request. */
const CONFLICT_CODES = new Set(['listener-off']);

/** Stable error with a `code`. */
class SettingsApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SettingsApiError';
    this.code = code;
  }
}

/**
 * Build the settings API over a peer service.
 *
 * @param {{ service: object }} deps - the peer service the page drives.
 * @returns {{ prefix: string, handle: (request: { method?: string, path?: string, body?: unknown }) => Promise<{ status: number, body: object }> }} the API.
 */
export function createSettingsApi({ service }) {
  return {
    prefix: PREFIX,

    async handle({ method, path, body }) {
      const route = routeFor(method, path);
      if (route === undefined) {
        // A path we serve under another verb is a 405; a path we do not serve at
        // all is a 404. Getting these the wrong way round sends whoever is
        // debugging the page looking in the wrong place.
        return {
          status: methodAllowed(path) ? 405 : 404,
          body: { ok: false, code: methodAllowed(path) ? 'method-not-allowed' : 'no-such-route' },
        };
      }

      try {
        return await route(body ?? {});
      } catch (cause) {
        const code = typeof cause?.code === 'string' ? cause.code : 'request-failed';
        return {
          status: statusFor(code),
          body: { ok: false, code, detail: String(cause?.message ?? cause) },
        };
      }
    },
  };

  /**
   * Turn a method and path into one operation, or nothing when unrouted.
   *
   * @param {string | undefined} method - the HTTP method.
   * @param {string | undefined} path - the request path.
   * @returns {((body: object) => Promise<{ status: number, body: object }>) | undefined} the operation.
   */
  function routeFor(method, path) {
    const routes = {
      'GET status': async () => ({ status: 200, body: statusBody() }),
      'POST ticket': async (input) => await ticketRoute(input),
      'POST pair': async (input) => await pairRoute(input),
      'POST revoke': async (input) => await revokeRoute(input),
    };
    return routes[`${String(method).toUpperCase()} ${String(path).slice(PREFIX.length + 1)}`];
  }

  /**
   * Whether a path exists under another method, so a wrong verb reads as 405.
   *
   * @param {string | undefined} path - the request path.
   * @returns {boolean} true when the path is one of ours.
   */
  function methodAllowed(path) {
    const tail = String(path).slice(PREFIX.length + 1);
    return ['status', 'ticket', 'pair', 'revoke'].includes(tail);
  }

  /**
   * What the page polls: state and lists, and never a secret.
   *
   * @returns {object} the status body.
   */
  function statusBody() {
    const status = service.status();
    return {
      ok: true,
      listening: status.listening === true,
      ...(status.address !== undefined && { address: status.address }),
      deviceName: status.deviceName,
      installId: status.installId,
      // The page must be able to say "a code is live until T" without ever
      // holding the code: this is a polled read.
      ...(status.pending !== undefined && { pending: { until: status.pending.expiresAt, address: status.pending.address } }),
      peers: status.peers.map((peer) => ({ id: peer.id, name: peer.name, address: peer.address, pairedAt: peer.pairedAt })),
      trustedBy: status.trustedBy.map((peer) => ({
        id: peer.id,
        name: peer.name,
        preset: peer.policy?.preset ?? 'unknown',
        pairedAt: peer.pairedAt,
        ...(peer.revokedAt !== undefined && { revokedAt: peer.revokedAt }),
      })),
    };
  }

  /**
   * Issue a one-time pairing code.
   *
   * @param {object} input - the request body.
   * @returns {Promise<{ status: number, body: object }>} the answer.
   */
  async function ticketRoute(input) {
    const preset = input.preset;
    if (preset !== undefined && !ALLOWED_PRESETS.includes(preset)) {
      return {
        status: 400,
        body: { ok: false, code: 'preset-not-allowed', detail: `preset must be one of ${ALLOWED_PRESETS.join(', ')}` },
      };
    }

    const ticket = await service.createTicket({ ...(preset !== undefined && { policy: { preset } }) });
    return {
      status: 200,
      body: {
        ok: true,
        code: ticket.code,
        link: ticket.link,
        expiresAt: ticket.expiresAt,
        preset: preset ?? 'workspace-write',
      },
    };
  }

  /**
   * Claim a code from another machine.
   *
   * The link parser and the handshake both describe their failures with codes,
   * so they travel through unchanged; a refusal here is still a served request,
   * because the page has to render it.
   *
   * @param {object} input - the request body.
   * @returns {Promise<{ status: number, body: object }>} the answer.
   */
  async function pairRoute(input) {
    const link = input.link;
    if (typeof link !== 'string' || link.trim() === '') {
      return { status: 400, body: { ok: false, code: 'link-missing' } };
    }

    try {
      const outcome = await service.pair({ link });
      return { status: 200, body: outcome };
    } catch (cause) {
      return {
        status: statusFor(cause?.code),
        body: { ok: false, code: cause?.code ?? 'pair-failed', detail: String(cause?.message ?? cause) },
      };
    }
  }

  /**
   * Revoke a machine's access.
   *
   * @param {object} input - the request body.
   * @returns {Promise<{ status: number, body: object }>} the answer.
   */
  async function revokeRoute(input) {
    const id = input.id;
    if (typeof id !== 'string' || id.trim() === '') {
      return { status: 400, body: { ok: false, code: 'id-missing' } };
    }

    const peer = await service.revoke(id);
    return { status: 200, body: { ok: true, id: peer.id, name: peer.name, revokedAt: peer.revokedAt } };
  }
}

/**
 * Map a refusal code onto an HTTP status.
 *
 * The distinction that matters to the page: 409 means "the machine is in a state
 * you must change first", 404 means "that thing is not here", 400 means "the
 * request itself was wrong".
 *
 * @param {string | undefined} code - the refusal code.
 * @returns {number} the status to answer with.
 */
function statusFor(code) {
  if (typeof code !== 'string') return 500;
  if (CONFLICT_CODES.has(code)) return 409;
  if (code === 'peer-unknown' || code === 'credential-unknown') return 404;
  if (code === 'link-malformed' || code === 'link-scheme' || code === 'link-code-missing' || code === 'link-address-missing') {
    return 400;
  }
  if (code === 'preset-not-allowed' || code === 'id-missing' || code === 'link-missing') return 400;
  return 500;
}

export { SettingsApiError };
