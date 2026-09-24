import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { getRequestListener } from '@hono/node-server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { runAsk } from './ask.js';
import { REJECT } from './reject.js';
import { readOutgoing, stageIncoming } from './transfer.js';
import { TOOLS } from './tools.js';
import { createTaskManager } from './tasks.js';

/**
 * The HTTP face of the Adapter: one authenticated MCP endpoint that a peer DSH
 * reaches over the network.
 *
 * The endpoint is stateless — every request gets its own MCP server and
 * transport pair, which is what the Streamable HTTP transport requires when no
 * session id is issued. A dropped connection therefore leaves nothing behind,
 * and a peer that restarts mid-conversation can simply ask again.
 */

/** Path a peer connects to. */
export const MCP_PATH = '/mcp';

/** Path used for the pairing handshake. */
export const PAIR_PATH = '/pair';

/** Largest accepted request body. A file transfer is base64 in JSON, so this bounds one file. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Start one Adapter.
 *
 * @param {{
 *   verifier?: (request: unknown) => { ok: boolean, kind?: string, peer?: object, status?: number, code?: string },
 *   auth?: { verifies: (request: unknown) => boolean },
 *   executor: { ask: (input: object) => Promise<object> },
 *   tasks: { submit: (input: object) => object, statusOf: (taskId: string) => object | undefined, eventsOf: (taskId: string, cursor?: number) => object | undefined, resultOf: (taskId: string) => object | undefined, cancel: (taskId: string) => object, whenSettled: (taskId: string) => Promise<object | undefined> },
 *   stagingDir: string,
 *   allowedDirs?: string[],
 *   defaultCwd?: string,
 *   host?: string,
 *   port?: number,
 *   maxBytes?: number,
 *   pairEndpoint?: (request: unknown, body: unknown) => Promise<{ status: number, body: object } | undefined>,
 *   log?: (line: string) => void,
 * }} options - Adapter wiring.
 * @returns {Promise<{ port: number, host: string, url: string, close: () => Promise<void> }>} the running Adapter.
 */
export async function startAdapter({
  verifier,
  auth,
  executor,
  tasks,
  stagingDir,
  allowedDirs,
  defaultCwd = process.cwd(),
  host = '127.0.0.1',
  port = 0,
  maxBytes,
  pairEndpoint,
  log = () => {},
}) {
  await mkdir(stagingDir, { recursive: true });

  const identify = toVerifier(verifier, auth);
  // A caller that wires no manager (the standalone bin, direct unit tests)
  // still gets a working one: the ask/submit surface is not optional. The
  // service passes its own so both ingress paths share a single queue.
  const manager =
    tasks ??
    createTaskManager({
      run: (task, { signal }) =>
        runAsk(
          {
            prompt: task.prompt,
            ...(task.cwd !== undefined && { cwd: task.cwd }),
            ...(task.timeoutMs !== undefined && { timeoutMs: task.timeoutMs }),
          },
          {
            executor,
            defaultCwd,
            policy: task.meta?.policy ?? { allowedDirs: allowedDirs ?? [defaultCwd] },
          },
          { signal },
        ),
    });
  const deps = { executor, stagingDir, defaultCwd, defaultAllowedDirs: allowedDirs, maxBytes, tasks: manager };
  const listener = createMcpListener(deps, log);

  const http = createServer((req, res) => {
    try {
      routeRequest({ req, res, identify, listener, pairEndpoint, log });
    } catch (cause) {
      // A hung request would stall the peer's agent turn; always answer.
      log(`request handling failed: ${cause?.name} ${JSON.stringify(cause?.message)}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
  });

  http.listen(port, host);
  await once(http, 'listening');
  const bound = http.address();
  const actualPort = typeof bound === 'object' && bound !== null ? bound.port : port;

  return {
    host,
    port: actualPort,
    url: `http://${host}:${String(actualPort)}${MCP_PATH}`,
    async close() {
      http.close();
      await once(http, 'close');
    },
  };
}

/**
 * Normalise the two accepted fence shapes into one caller-identifying function.
 *
 * @param {((request: unknown) => object) | undefined} verifier - the caller-identifying fence.
 * @param {{ verifies: (request: unknown) => boolean } | undefined} auth - the older boolean fence.
 * @returns {(request: unknown) => { ok: boolean, kind?: string, peer?: object, status?: number, code?: string }} the normalised fence.
 */
function toVerifier(verifier, auth) {
  if (typeof verifier === 'function') return verifier;
  if (auth === undefined) throw new TypeError('dsh-peer-mcp: startAdapter needs a verifier or an auth fence');
  return (request) =>
    auth.verifies(request) ? { ok: true, kind: 'legacy' } : { ok: false, status: 401, code: 'credential-unknown' };
}

/**
 * Identify the caller, then route to pairing or to the MCP endpoint.
 *
 * Pairing is an exception in one direction only: the `/pair` route is the one
 * place an unauthenticated request may land, because a pairing code *is* the
 * authentication there. Every other path needs an identified caller.
 *
 * @param {{
 *   req: import('node:http').IncomingMessage,
 *   res: import('node:http').ServerResponse,
 *   identify: (request: unknown) => object,
 *   listener: (req: object, res: object, caller: object) => void,
 *   pairEndpoint?: (input: { req: object, res: object }) => void,
 *   log: (line: string) => void,
 * }} input - one request.
 * @returns {void}
 */
function routeRequest({ req, res, identify, listener, pairEndpoint, log }) {
  const url = new URL(req.url ?? '/', 'http://adapter.invalid');

  if (url.pathname === PAIR_PATH) {
    if (pairEndpoint === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('pairing is not enabled on this machine');
      return;
    }
    pairEndpoint({ req, res });
    return;
  }

  const caller = identify(req);
  if (caller.ok !== true) {
    log(`rejected ${caller.code ?? 'unauthenticated'} ${req.method ?? '?'} ${url.pathname}`);
    res.writeHead(caller.status ?? 401, { 'content-type': 'text/plain', 'www-authenticate': 'Bearer' });
    res.end('unauthorized');
    return;
  }

  listener(req, res, caller);
}

/**
 * Build the HTTP listener that turns one request into one MCP exchange.
 *
 * Two details are load-bearing and were found the hard way:
 *
 * - The Web-standard transport is used directly. The Node wrapper
 *   (`StreamableHTTPServerTransport`) builds its own Node-to-Web adapter, so
 *   calling it with an already-adapted request nests two adapters and fails.
 * - JSON responses are enabled. In SSE mode `handleRequest` resolves with a
 *   stream that has not started flowing yet, so closing the per-request server
 *   would truncate the answer; in JSON mode the body is complete when
 *   `handleRequest` resolves, which makes the lifecycle provable.
 *
 * @param {{ executor: object, stagingDir: string, defaultCwd: string, defaultAllowedDirs?: string[], maxBytes?: number }} deps - tool dependencies.
 * @param {(line: string) => void} log - diagnostic sink.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, caller: object) => void} the listener.
 */
function createMcpListener(deps, log) {
  return (req, res, caller) =>
    getRequestListener(
      async (webRequest) => {
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = buildMcpServer(deps, caller);
        // Registration must happen before connect: a connected server refuses new
        // tool capabilities, which is exactly the error that surfaced as a bare 500.
        await server.connect(transport);
        try {
          return await transport.handleRequest(webRequest);
        } finally {
          await server.close().catch(() => {});
        }
      },
      {
        // Keeps the SDK's Response class out of the global scope, and turns an
        // adapter-layer throw into a diagnosable answer instead of a bare 500.
        overrideGlobalObjects: false,
        errorHandler: async (cause) => {
          log(`transport failed: ${cause?.name} ${JSON.stringify(cause?.message)}`);
          return new Response(
            JSON.stringify({ ok: false, code: 'transport-failed', detail: cause?.message }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          );
        },
      },
    )(req, res);
}

/**
 * Build one MCP server with the peer tools registered for one caller.
 *
 * Registration happens here, before the caller connects a transport: a
 * connected server refuses to take on new tool capabilities.
 *
 * @param {{ executor: object, stagingDir: string, defaultCwd: string, defaultAllowedDirs?: string[], maxBytes?: number }} deps - tool dependencies.
 * @param {object} caller - the identified caller.
 * @returns {McpServer} the configured, not-yet-connected server.
 */
function buildMcpServer(deps, caller) {
  const server = new McpServer({ name: 'dsh-peer-mcp', version: '0.1.0' });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      tool.config,
      async (args) => await dispatch(tool.name, args, { ...deps, caller }),
    );
  }

  return server;
}

/**
 * Run one tool call and shape the answer for the wire.
 *
 * Tool-level refusals come back as `isError` with a stable code, so the peer
 * model can tell a policy refusal from a transport failure.
 *
 * @param {string} name - tool name.
 * @param {Record<string, unknown>} args - validated tool arguments.
 * @param {{ executor: object, stagingDir: string, defaultCwd: string, defaultAllowedDirs?: string[], maxBytes?: number, caller: object }} deps - tool dependencies.
 * @returns {Promise<{ content: { type: 'text', text: string }[], isError?: true }>} the tool result.
 */
async function dispatch(name, args, deps) {
  const { executor, stagingDir, defaultCwd, maxBytes, caller, tasks } = deps;
  const allowedDirs = deps.caller?.peer?.policy?.allowedDirs ?? deps.defaultAllowedDirs;
  const policy = { allowedDirs };

  try {
    // ask and submit_task share one submission path: the policy check runs at
    // submit time so a refusal never creates a task, and the caller's policy
    // travels with the task for the run itself.
    if (name === 'ask' || name === 'submit_task') {
      const rejection = REJECT({ prompt: args?.prompt, cwd: args?.cwd ?? defaultCwd }, policy);
      if (rejection !== undefined) return asError(rejection.code, rejection.detail);

      const submitted = tasks.submit({
        request: {
          prompt: args.prompt,
          ...(args?.cwd !== undefined && { cwd: args.cwd }),
          ...(args?.timeoutMs !== undefined && { timeoutMs: args.timeoutMs }),
        },
        ...(args?.idempotencyKey !== undefined && { idempotencyKey: args.idempotencyKey }),
        meta: { policy },
      });

      if (name === 'submit_task') return asText({ ok: true, ...submitted });

      // ask, the compatibility wrapper: one task, waited out, same shape as
      // before the async protocol existed.
      await tasks.whenSettled(submitted.taskId);
      const answer = tasks.resultOf(submitted.taskId);
      if (answer === undefined || answer.ok !== true) {
        const refusal = answer ?? { code: 'task-lost', detail: 'the task ended without a result' };
        return asError(refusal.code, refusal.detail);
      }
      return asText(answer);
    }

    if (name === 'task_status') {
      const taskId = String(args?.taskId ?? '');
      const status = tasks.statusOf(taskId);
      if (status === undefined) return asError('task-unknown', `no task with id ${taskId}`);
      return asText({ ok: true, ...status });
    }

    if (name === 'task_events') {
      const taskId = String(args?.taskId ?? '');
      const cursor = Number.isInteger(args?.cursor) && (args?.cursor ?? 0) >= 0 ? args.cursor : 0;
      const read = tasks.eventsOf(taskId, cursor);
      if (read === undefined) return asError('task-unknown', `no task with id ${taskId}`);
      return asText({ ok: true, ...read });
    }

    if (name === 'task_result') {
      const taskId = String(args?.taskId ?? '');
      const status = tasks.statusOf(taskId);
      if (status === undefined) return asError('task-unknown', `no task with id ${taskId}`);
      if (status.status === 'expired') return asError('task-expired', 'the result passed its retention window');
      const result = tasks.resultOf(taskId);
      if (result === undefined) return asError('task-not-terminal', `the task is still ${status.status}`);
      return asText(result);
    }

    if (name === 'cancel_task') {
      const taskId = String(args?.taskId ?? '');
      const outcome = tasks.cancel(taskId);
      if (outcome.ok !== true) return asError(outcome.code, outcome.detail);
      return asText({ ok: true, taskId, cancelled: true });
    }

    if (name === 'fetch_file') {
      const file = await readOutgoing({
        path: /** @type {string} */ (args.path),
        allowedDirs,
        ...(maxBytes !== undefined && { maxBytes }),
      });
      return asText(file);
    }

    if (name === 'send_file') {
      const staged = await stageIncoming({
        name: /** @type {string} */ (args.name),
        content: /** @type {string} */ (args.content),
        sha256: /** @type {string} */ (args.sha256),
        stagingDir,
        ...(maxBytes !== undefined && { maxBytes }),
      });
      return asText({ ...staged, note: 'staged for this machine to move into place itself' });
    }

    return asError('unknown-tool', `caller=${String(caller?.kind ?? 'unknown')}`);
  } catch (cause) {
    const code = typeof cause?.code === 'string' ? cause.code : 'tool-failed';
    return asError(code, cause?.message);
  }
}

/**
 * Wrap a machine-readable answer as one text part.
 *
 * @param {Record<string, unknown>} value - the answer.
 * @returns {{ content: { type: 'text', text: string }[] }} the tool result.
 */
function asText(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/**
 * Wrap a refusal so the peer can branch on the code.
 *
 * @param {string} code - stable refusal code.
 * @param {string} [detail] - extra prose, safe to show a model.
 * @returns {{ content: { type: 'text', text: string }[], isError: true }} the tool result.
 */
function asError(code, detail) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: false, code, ...(detail !== undefined && { detail }) }),
      },
    ],
  };
}
