import { createSettingsApi } from './settings-api.js';

/**
 * The host half of the settings page: the plugin's own loopback routes.
 *
 * The browser half is a settings section where an operator turns listening on,
 * issues pairing codes and revokes peers. It cannot do any of that itself — the
 * authority lives on the host — so the page calls these routes.
 *
 * Two details are deliberate, both copied from how other plugins serve a
 * settings page:
 *
 * - **Loopback only.** The routes are served by the Web UI's own carrier, and
 *   the handler refuses any request whose Host header is not loopback. The page
 *   is for the person at this machine; a request arriving through a proxy or
 *   another interface is not that person.
 * - **The carrier is registered through `ctx.webServer`**, so these routes live
 *   on the UI's origin and the browser can call them same-origin. This is a
 *   different port from the peer-facing Adapter, which is the only listener this
 *   plugin exposes to the network.
 */

/** Path prefix every settings route lives under. */
const PREFIX = '/plugins/dsh-peer-mcp';

/** Routes the page calls, and the methods they answer. */
const ROUTES = [
  { path: `${PREFIX}/status`, method: 'GET' },
  { path: `${PREFIX}/workspace`, methods: ['GET', 'POST'] },
  { path: `${PREFIX}/ticket`, method: 'POST' },
  { path: `${PREFIX}/pair`, method: 'POST' },
  { path: `${PREFIX}/revoke`, method: 'POST' },
];

/** Largest request body accepted from the page. */
const MAX_BODY_BYTES = 16 * 1024;

/** The HTTP methods one route answers, normalised to upper case. */
const methodsOf = (route) => (route.methods ?? [route.method]).map((method) => method.toUpperCase());

/**
 * Whether a request came from this machine's own loopback interface.
 *
 * A Host header naming anything else means the request was proxied or aimed at
 * a network address, so it is refused rather than guessed about. An absent
 * header is accepted, matching the convention other plugins use.
 *
 * @param {object} req - the Node request.
 * @returns {boolean} true when the request may be served.
 */
export function isLoopbackRequest(req) {
  const host = String(req?.headers?.host ?? '');
  return host === '' || /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/u.test(host);
}

/**
 * Register the settings routes on the Web UI carrier.
 *
 * @param {{ ctx: object, service: object, log?: (line: string) => void }} deps - plugin context and the service the page drives.
 * @returns {{ dispose: () => void }} the registration handle.
 */
export function registerSettingsRoutes({ ctx, service, log = () => {} }) {
  const api = createSettingsApi({ service });
  const registrations = ROUTES.map((route) =>
    ctx.webServer.register({
      kind: 'exact',
      path: route.path,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          log(`refused a non-loopback settings request for ${route.path}`);
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('forbidden');
          return;
        }

        if (!methodsOf(route).includes(String(req.method).toUpperCase())) {
          res.writeHead(405, { 'content-type': 'application/json', allow: methodsOf(route).join(', ') });
          res.end(JSON.stringify({ ok: false, code: 'method-not-allowed' }));
          return;
        }

        let body;
        try {
          body = String(req.method).toUpperCase() === 'POST' ? await readJsonBody(req) : undefined;
        } catch (cause) {
          log(`settings body rejected for ${route.path}: ${cause?.message ?? String(cause)}`);
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, code: 'body-malformed' }));
          return;
        }

        const answer = await api.handle({ method: String(req.method), path: route.path, body });
        res.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(answer.body));
      },
    }),
  );

  log(`settings routes ready under ${PREFIX}`);

  return {
    dispose() {
      for (const registration of registrations) {
        try {
          registration?.();
        } catch {
          // A failing unregister must not block the others during unload.
        }
      }
    },
  };
}

/**
 * Read a bounded JSON body.
 *
 * @param {object} req - the Node request stream.
 * @returns {Promise<object>} the parsed body, or an empty object for an empty body.
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error(`body exceeds ${String(MAX_BODY_BYTES)} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text === '' ? {} : JSON.parse(text);
}
