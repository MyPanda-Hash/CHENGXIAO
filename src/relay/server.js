import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMailbox, validateEnvelope } from './protocol.js';

/**
 * The relay: a tiny HTTP forwarder that connects two devices that cannot reach
 * each other directly.
 *
 * Routes (all POST, JSON in/out):
 *   /relay/register { deviceId }                 -> 200
 *   /relay/send     { to, from, kind, id, body } -> 200 | 404 device-unknown | 400
 *   /relay/poll     { deviceId, timeoutMs }      -> envelope | {} on timeout
 *   /relay/ack      { deviceId, id }             -> 200
 *
 * The relay is deliberately dumb: it validates routing fields, delivers into an
 * in-memory mailbox, and never reads `body`. Nothing is written to disk, so the
 * relay cannot leak task content, file names or pairing codes it never holds.
 */

const MAX_BODY_BYTES = 16 * 1024 * 1024; // matches the file-transfer ceiling
const MAX_POLL_MS = 30_000;
const POLL_CHECK_MS = 50;

/**
 * Start one relay.
 *
 * @param {{ mailbox?: ReturnType<typeof createMailbox>, maxBodyBytes?: number, host?: string, port?: number, log?: (line: string) => void }} [options] - injectable mailbox, limits and bind address.
 * @returns {Promise<{ http: import('node:http').Server, port: number, url: string, close: () => Promise<void> }>} the running relay.
 */
export async function createRelayServer({
  mailbox = createMailbox(),
  maxBodyBytes = MAX_BODY_BYTES,
  host = '127.0.0.1',
  port = 0,
  log = () => {},
} = {}) {
  const devices = new Set();

  const http = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (cause) {
      log(`relay request failed: ${cause?.message ?? String(cause)}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'relay-failed' }));
    }
  });

  /**
   * Route one request.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>}
   */
  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://relay.invalid');

    if (url.pathname === '/relay/register' && req.method === 'POST') {
      const body = await readJson(req, maxBodyBytes);
      if (typeof body?.deviceId !== 'string' || body.deviceId === '') {
        return json(res, 400, { ok: false, code: 'device-id-missing' });
      }
      devices.add(body.deviceId);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/relay/send' && req.method === 'POST') {
      const body = await readJson(req, maxBodyBytes);
      const invalid = validateEnvelope(body);
      if (invalid !== undefined) return json(res, 400, { ok: false, code: invalid });
      if (!devices.has(body.to)) return json(res, 404, { ok: false, code: 'device-unknown' });
      mailbox.push(body);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/relay/ack' && req.method === 'POST') {
      const body = await readJson(req, maxBodyBytes);
      if (typeof body?.deviceId !== 'string' || typeof body?.id !== 'string') {
        return json(res, 400, { ok: false, code: 'ack-malformed' });
      }
      mailbox.ack(body.deviceId, body.id);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/relay/poll' && req.method === 'POST') {
      const body = await readJson(req, maxBodyBytes);
      if (typeof body?.deviceId !== 'string' || body.deviceId === '') {
        return json(res, 400, { ok: false, code: 'device-id-missing' });
      }
      const requested = Number(body.timeoutMs);
      const timeoutMs = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), MAX_POLL_MS) : 1000;
      const envelope = await waitForMessage(body.deviceId, timeoutMs);
      return json(res, 200, envelope ?? {});
    }

    return json(res, 404, { ok: false, code: 'no-such-route' });
  }

  /**
   * Long-poll: wait up to timeoutMs for one message for a device.
   *
   * @param {string} deviceId - the polling device.
   * @param {number} timeoutMs - how long to hold the request open.
   * @returns {Promise<object | undefined>} the next envelope, or undefined on timeout.
   */
  function waitForMessage(deviceId, timeoutMs) {
    return new Promise((resolve) => {
      const immediate = mailbox.takeNext(deviceId);
      if (immediate !== undefined) {
        resolve(immediate);
        return;
      }

      let settled = false;
      const settle = (envelope) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(interval);
        resolve(envelope);
      };

      const timer = setTimeout(() => settle(undefined), timeoutMs);
      const interval = setInterval(() => {
        const envelope = mailbox.takeNext(deviceId);
        if (envelope !== undefined) settle(envelope);
      }, POLL_CHECK_MS);
    });
  }

  http.listen(port, host);
  await once(http, 'listening');
  const bound = http.address();
  const actualPort = typeof bound === 'object' && bound !== null ? bound.port : port;

  return {
    http,
    port: actualPort,
    url: `http://${host}:${String(actualPort)}`,
    async close() {
      http.close();
      // Keep-alive sockets (undici's global agent) would otherwise hold the
      // listener open until their own timeout; dropping them makes teardown
      // immediate and deterministic.
      http.closeAllConnections?.();
      await once(http, 'close');
    },
  };
}

/**
 * Read and parse a bounded JSON body.
 *
 * @param {import('node:http').IncomingMessage} req - the request stream.
 * @param {number} maxBytes - the size ceiling.
 * @returns {Promise<object>} the parsed body, or an empty object.
 */
async function readJson(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`body exceeds ${String(maxBytes)} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text === '' ? {} : JSON.parse(text);
}

/**
 * Write one JSON answer.
 *
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - the HTTP status.
 * @param {object} body - the JSON body.
 * @returns {void}
 */
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
