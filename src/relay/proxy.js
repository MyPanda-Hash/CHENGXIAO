import { createServer } from 'node:http';
import { once } from 'node:events';
import { seal, open } from './crypto.js';

/**
 * The initiator's loopback bridge between an MCP client and a relay peer.
 *
 * The host's MCP client only speaks HTTP to a URL, so a relay peer is served
 * by a loopback proxy: every request is sealed with the pairing-time channel
 * key, carried across the relay as an opaque envelope, replayed by the worker
 * against its own loopback adapter, and the sealed answer comes back through
 * the same path. The relay forwards ciphertext only.
 */

/** Default ceiling for one relay round trip; long tasks raise it explicitly. */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Start one loopback proxy for one relay peer.
 *
 * @param {{
 *   relayClient: { request: (input: object) => Promise<object> },
 *   to: string,
 *   channelKey: Buffer,
 *   timeoutMs?: number,
 *   log?: (line: string) => void,
 * }} options - the relay transport, the worker's device id, and the channel key.
 * @returns {Promise<{ port: number, url: string, close: () => Promise<void> }>} the loopback endpoint.
 */
export async function createRelayProxy({ relayClient, to, channelKey, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} }) {
  const http = createServer((req, res) => {
    void handle(req, res).catch((cause) => {
      log(`relay proxy request failed: ${cause?.message ?? String(cause)}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'relay-proxy-failed' }));
    });
  });

  /**
   * Translate one HTTP request into a sealed relay envelope and back.
   *
   * @param {import('node:http').IncomingMessage} req - the inbound request.
   * @param {import('node:http').ServerResponse} res - the outbound response.
   * @returns {Promise<void>}
   */
  async function handle(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBase64 = Buffer.concat(chunks).toString('base64');

    const response = await relayClient.request({
      to,
      kind: 'http-request',
      body: {
        method: String(req.method ?? 'GET'),
        path: String(req.url ?? '/'),
        sealed: seal({
          key: channelKey,
          plaintext: JSON.stringify({ headers: { ...req.headers }, bodyBase64 }),
        }),
      },
      timeoutMs,
    });

    if (response.error !== undefined) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: String(response.error) }));
      return;
    }
    if (typeof response.sealed !== 'string') {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'relay-response-malformed' }));
      return;
    }

    const opened = open({ key: channelKey, sealed: response.sealed });
    if (opened === undefined) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'relay-response-unopenable' }));
      return;
    }

    const payload = JSON.parse(opened);
    const headers = { ...(payload.headers ?? {}) };
    delete headers['transfer-encoding'];
    delete headers['content-length'];
    res.writeHead(payload.status ?? 502, headers);
    res.end(payload.bodyBase64 === undefined || payload.bodyBase64 === '' ? undefined : Buffer.from(payload.bodyBase64, 'base64'));
  }

  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const bound = http.address();
  const port = typeof bound === 'object' && bound !== null ? bound.port : 0;

  return {
    port,
    url: `http://127.0.0.1:${String(port)}/mcp`,
    async close() {
      http.close();
      http.closeAllConnections?.();
      await once(http, 'close');
    },
  };
}
