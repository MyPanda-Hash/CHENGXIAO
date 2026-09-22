/**
 * Claiming a pairing code over the network.
 *
 * This is the initiating half of the handshake: it reads the link the operator
 * pasted, asks the worker to accept this device, and stores what comes back.
 *
 * Every failure is an answer, never an exception: a wrong code and an
 * unreachable machine are both things the operator must be told about, and
 * neither of them should look like a crash or leave a half-saved peer behind.
 */

/** Scheme a pairing link must use. */
const LINK_SCHEME = 'dshp:';

/** How long to wait for a worker to answer before calling it unreachable. */
export const PAIR_TIMEOUT_MS = 20_000;

/** Stable error with a `code`. */
class PairLinkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PairLinkError';
    this.code = code;
  }
}

/**
 * Parse the link an operator pasted.
 *
 * @param {string} link - the `dshp://host:port/CODE` link.
 * @returns {{ address: string, code: string, origin: string }} the parts.
 * @throws {PairLinkError} when the link cannot be used.
 */
export function parsePairLink(link) {
  if (typeof link !== 'string' || link.trim() === '') {
    throw new PairLinkError('link-malformed', 'a pairing link is required');
  }

  let url;
  try {
    url = new URL(link.trim());
  } catch {
    throw new PairLinkError('link-malformed', `${link} is not a URL`);
  }

  if (url.protocol !== LINK_SCHEME) {
    throw new PairLinkError('link-scheme', `a pairing link starts with ${LINK_SCHEME}// , got ${url.protocol}//`);
  }

  const address = url.host;
  if (address === '') {
    throw new PairLinkError('link-address-missing', 'the pairing link names no machine');
  }

  const code = url.pathname.replace(/^\/+/u, '');
  if (code === '') {
    throw new PairLinkError('link-code-missing', 'the pairing link carries no code');
  }

  return { address, code, origin: `http://${address}` };
}

/**
 * Ask a worker to accept this device.
 *
 * @param {{
 *   link: { address: string, code: string, origin: string },
 *   deviceName: string,
 *   identity: { publicKey: string },
 *   store: { addPeer: (input: object) => Promise<object> },
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} input - one pairing attempt.
 * @returns {Promise<{ ok: true, peer: object, worker: object } | { ok: false, code: string, detail: string }>} the outcome.
 */
export async function pairWith({
  link,
  deviceName,
  identity,
  store,
  timeoutMs = PAIR_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(`${link.origin}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: link.code,
        name: deviceName,
        publicKey: identity.publicKey,
      }),
      signal: controller.signal,
    });
  } catch (cause) {
    const aborted = cause?.name === 'AbortError';
    return {
      ok: false,
      code: aborted ? 'pairing-timeout' : 'worker-unreachable',
      detail: aborted
        ? `${link.address} did not answer within ${String(timeoutMs)}ms`
        : `cannot reach ${link.address}: ${String(cause?.message ?? cause)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  const payload = await readJson(response);

  if (response.ok !== true || payload?.ok !== true) {
    return {
      ok: false,
      code: typeof payload?.code === 'string' ? payload.code : `worker-http-${String(response.status)}`,
      detail: typeof payload?.detail === 'string' ? payload.detail : 'the worker refused this pairing',
    };
  }

  const peer = await store.addPeer({
    credential: payload.credential,
    address: link.address,
    name: deviceName,
    ...(payload.worker?.installId !== undefined && { workerInstallId: payload.worker.installId }),
  });

  return { ok: true, peer, worker: payload.worker ?? {} };
}

/**
 * Read a JSON body, tolerating a worker that answered with something else.
 *
 * @param {Response} response - the HTTP response.
 * @returns {Promise<any>} the parsed body, or undefined when it is not JSON.
 */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
