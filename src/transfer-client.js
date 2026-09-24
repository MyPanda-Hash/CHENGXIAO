import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * The programmatic half of the chunked file channel.
 *
 * The model cannot meaningfully relay a hundred chunks through a
 * conversation, so these drivers are what actually move big files: a tight
 * open/read/verify loop for downloads and begin/chunk/finish for uploads,
 * with a digest check on every chunk and a bounded retry so a dropped link
 * resumes the transfer instead of failing it. Everything lands through a
 * temp file and an atomic rename; nothing half-written ever appears under a
 * real name on either machine.
 */

/** Attempts per chunk before the transfer is declared failed. */
const CHUNK_ATTEMPTS = 3;

/** Error with a stable `code`. */
class TransferClientError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'TransferClientError';
    this.code = code;
  }
}

/** SHA-256 of a buffer, lowercase hex. */
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Build a callTool over raw MCP JSON-RPC, for programmatic transfers.
 *
 * The peer's endpoint is stateless Streamable HTTP, so a plain tools/call
 * POST per request works without a session; the Accept header must name both
 * response media types or the endpoint answers 406. Tool-level refusals come
 * back as `isError` bodies and are mapped onto thrown codes here, matching
 * what the session drivers expect from a callTool.
 *
 * @param {{ url: string, authorization: string, fetchImpl?: typeof fetch }} input - endpoint and credential.
 * @returns {(name: string, args: object) => Promise<object>} the caller.
 */
export function createJsonRpcCaller({ url, authorization, fetchImpl = fetch }) {
  let nextId = 1;
  return async function callTool(name, args) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
    });

    const payload = await response.json().catch(() => undefined);
    if (!response.ok || payload?.error !== undefined) {
      throw new TransferClientError(
        `rpc-${String(response.status)}`,
        payload?.error?.message ?? `the endpoint answered ${String(response.status)}`,
      );
    }

    const text = payload?.result?.content?.[0]?.text;
    let body;
    try {
      body = typeof text === 'string' ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (payload?.result?.isError === true) {
      throw new TransferClientError(body?.code ?? 'tool-failed', body?.detail ?? name);
    }
    if (body === undefined) {
      throw new TransferClientError('rpc-unreadable', 'the endpoint answered without a readable body');
    }
    return body;
  };
}

/**
 * Call one tool with retries, mapping transport failures onto codes.
 *
 * @param {(name: string, args: object) => Promise<object>} callTool - the transport.
 * @param {string} name - tool name.
 * @param {object} args - tool arguments.
 * @param {number} attempts - remaining attempts.
 * @returns {Promise<object>} the parsed tool body.
 */
async function callWithRetry(callTool, name, args, attempts = CHUNK_ATTEMPTS) {
  let lastCause;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const body = await callTool(name, args);
      if (body?.ok === false && typeof body.code === 'string') {
        // A tool-level refusal is an answer, not a transient failure.
        throw new TransferClientError(body.code, body.detail ?? name);
      }
      return body;
    } catch (cause) {
      if (cause instanceof TransferClientError) throw cause;
      lastCause = cause;
    }
  }
  throw new TransferClientError(
    'chunk-transport-failed',
    `${name} failed after ${String(attempts)} attempts: ${lastCause?.message ?? String(lastCause)}`,
  );
}

/**
 * Pull one file from the peer, chunk by chunk, into a local path.
 *
 * @param {{
 *   callTool: (name: string, args: object) => Promise<object>,
 *   remotePath: string,
 *   localPath: string,
 *   onProgress?: (update: { received: number, totalChunks: number }) => void,
 * }} input - the transport, the source and the destination.
 * @returns {Promise<{ bytes: number, sha256: string }>} the landed local file.
 */
export async function fetchChunked({ callTool, remotePath, localPath, onProgress }) {
  const opened = await callWithRetry(callTool, 'open_read', { path: remotePath }, 1);
  if (opened?.ok !== true || typeof opened.transferId !== 'string') {
    throw new TransferClientError('open-failed', 'open_read did not yield a transfer');
  }

  const exists = await stat(localPath).then(
    () => true,
    () => false,
  );
  if (exists) {
    await callWithRetry(callTool, 'close_read', { transferId: opened.transferId }, 1).catch(() => {});
    throw new TransferClientError('local-exists', `${localPath} already exists; refusing to overwrite it`);
  }

  const tempPath = `${localPath}.${randomUUID().slice(0, 8)}.part`;
  const handle = await open(tempPath, 'wx').catch((cause) => {
    throw new TransferClientError('local-unwritable', `cannot create ${tempPath}: ${cause.message}`);
  });

  try {
    const hash = createHash('sha256');
    for (let index = 0; index < opened.totalChunks; index += 1) {
      const chunk = await callWithRetry(callTool, 'read_chunk', { transferId: opened.transferId, index });
      const bytes = Buffer.from(typeof chunk?.data === 'string' ? chunk.data : '', 'base64');
      if (chunk?.sha256 !== digest(bytes)) {
        throw new TransferClientError('chunk-hash-mismatch', `chunk ${String(index)} failed its digest check`);
      }
      hash.update(bytes);
      await handle.write(bytes, 0, bytes.byteLength, index * opened.chunkSize);
      onProgress?.({ received: index + 1, totalChunks: opened.totalChunks });
    }

    const whole = hash.digest('hex');
    if (whole !== opened.sha256) {
      throw new TransferClientError('hash-mismatch', `pulled sha256 ${whole} does not match the announced ${opened.sha256}`);
    }

    await handle.close();
    await rename(tempPath, localPath);
    return { bytes: opened.bytes, sha256: whole };
  } catch (cause) {
    await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    if (cause instanceof TransferClientError) throw cause;
    throw new TransferClientError('transfer-failed', String(cause?.message ?? cause));
  } finally {
    await callWithRetry(callTool, 'close_read', { transferId: opened.transferId }, 1).catch(() => {});
  }
}

/**
 * Push one local file to the peer, chunk by chunk, into its staging.
 *
 * @param {{
 *   callTool: (name: string, args: object) => Promise<object>,
 *   localPath: string,
 *   onProgress?: (update: { sent: number, totalChunks: number }) => void,
 * }} input - the transport and the source.
 * @returns {Promise<{ name: string, path: string, bytes: number }>} where it landed on the peer.
 */
export async function sendChunked({ callTool, localPath, onProgress }) {
  const info = await stat(localPath).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    throw new TransferClientError('file-missing', `no such file: ${localPath}`);
  }

  const bytes = await readFile(localPath);
  const sha256 = digest(bytes);
  const name = basename(localPath);

  const begun = await callWithRetry(callTool, 'send_begin', { name, bytes: bytes.byteLength, sha256 }, 1);
  if (begun?.ok !== true || typeof begun.transferId !== 'string') {
    throw new TransferClientError('begin-failed', 'send_begin did not yield a transfer');
  }

  try {
    for (let index = 0; index < begun.totalChunks; index += 1) {
      const start = index * begun.chunkSize;
      const slice = bytes.subarray(start, Math.min(start + begun.chunkSize, bytes.byteLength));
      await callWithRetry(callTool, 'send_chunk', {
        transferId: begun.transferId,
        index,
        data: slice.toString('base64'),
        sha256: digest(slice),
      });
      onProgress?.({ sent: index + 1, totalChunks: begun.totalChunks });
    }
    const landed = await callWithRetry(callTool, 'send_finish', { transferId: begun.transferId }, 1);
    return { name: landed.name, path: landed.path, bytes: landed.bytes };
  } catch (cause) {
    await callWithRetry(callTool, 'send_cancel', { transferId: begun.transferId }, 1).catch(() => {});
    if (cause instanceof TransferClientError) throw cause;
    throw new TransferClientError('transfer-failed', String(cause?.message ?? cause));
  }
}
