/**
 * RelayTransport: the outbound client half of the relay.
 *
 * A machine with no reachable inbound address registers with the relay and
 * long-polls for envelopes; messages to other devices go out through the same
 * relay. The transport itself does not care what `body` contains — encryption
 * is the caller's job — but every failure is a stable-code answer rather than
 * a bare throw.
 */

/** Stable error with a `code`. */
class RelayClientError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'RelayClientError';
    this.code = code;
  }
}

/**
 * Create one relay client.
 *
 * @param {{
 *   url: string,
 *   deviceId: string,
 *   fetchImpl?: typeof fetch,
 *   pollIntervalMs?: number,
 *   pollWaitMs?: number,
 *   timeoutMs?: number,
 * }} options - relay origin, this device's id, and loop tuning.
 * @returns {{
 *   register: () => Promise<void>,
 *   send: (envelope: object) => Promise<void>,
 *   onMessage: (handler: (envelope: object) => void | Promise<void>) => () => void,
 *   request: (input: { to: string, kind?: string, body?: object, timeoutMs?: number }) => Promise<object>,
 *   stop: () => Promise<void>,
 * }} the client.
 */
export function createRelayClient({
  url,
  deviceId,
  fetchImpl = fetch,
  pollIntervalMs = 50,
  pollWaitMs = 2000,
  timeoutMs = 10_000,
}) {
  let running = false;
  let pollTimer;
  const listeners = new Set();
  const pending = new Map(); // envelope id -> { resolve, timer }

  /**
   * Call one relay route.
   *
   * @param {string} path - route path.
   * @param {object} body - the JSON body.
   * @returns {Promise<object>} the parsed answer.
   */
  const call = async (path, body) => {
    let response;
    try {
      response = await fetchImpl(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new RelayClientError('relay-unreachable', String(cause?.message ?? cause));
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new RelayClientError(
        typeof payload?.code === 'string' ? payload.code : `relay-http-${String(response.status)}`,
        typeof payload?.detail === 'string' ? payload.detail : 'the relay refused the request',
      );
    }
    return payload;
  };

  /**
   * One poll cycle: take at most one envelope, acknowledge it, hand it to the
   * listeners, and resolve a matching pending request.
   *
   * @returns {Promise<void>}
   */
  const pollOnce = async () => {
    if (!running) return;
    try {
      const envelope = await call('/relay/poll', { deviceId, timeoutMs: pollWaitMs });
      if (envelope !== null && typeof envelope === 'object' && typeof envelope.id === 'string') {
        await call('/relay/ack', { deviceId, id: envelope.id });
        for (const handler of listeners) await handler(envelope);
        const waiter = pending.get(envelope.id);
        if (waiter !== undefined && envelope.kind === 'response') {
          clearTimeout(waiter.timer);
          pending.delete(envelope.id);
          waiter.resolve(envelope.body ?? {});
        }
      }
    } catch {
      // A transient poll failure must not kill the loop; keep trying.
    } finally {
      if (running) pollTimer = setTimeout(pollOnce, pollIntervalMs);
    }
  };

  /**
   * Send one envelope to another device.
   *
   * @param {object} envelope - routing fields plus an opaque body.
   * @returns {Promise<void>}
   */
  const send = async (envelope) => {
    await call('/relay/send', envelope);
  };

  return {
    async register() {
      try {
        await call('/relay/register', { deviceId });
      } catch (cause) {
        throw new RelayClientError(cause.code ?? 'relay-register-failed', cause.message, { cause });
      }
      running = true;
      pollTimer = setTimeout(pollOnce, pollIntervalMs);
    },

    send,

    onMessage(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },

    request({ to, kind = 'request', body = {}, timeoutMs: requestTimeoutMs = timeoutMs }) {
      return new Promise((resolve, reject) => {
        const id = `req-${deviceId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new RelayClientError('relay-request-timeout', `no answer from ${to} within ${String(requestTimeoutMs)}ms`));
        }, requestTimeoutMs);

        pending.set(id, { resolve, timer });
        send({ to, from: deviceId, kind, id, body }).catch((cause) => {
          clearTimeout(timer);
          pending.delete(id);
          reject(cause);
        });
      });
    },

    async stop() {
      running = false;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}
