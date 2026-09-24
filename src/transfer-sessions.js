import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { isPathInside } from './reject.js';
import { safeName } from './transfer.js';

/**
 * Chunked transfer sessions: the worker-side halves of the upgraded file
 * channel.
 *
 * A read session serves one policy-checked local file in chunks, any order,
 * as often as the peer asks — that re-readability is the whole resume story
 * for a download whose link dropped halfway. A receive session assembles a
 * peer's file chunk by chunk into a temp file, idempotently per index, and
 * only renames it into staging after the whole-file hash verifies; a failed
 * or cancelled transfer therefore never lands half a file under a real name.
 *
 * Sessions are swept lazily: touching the map drops anything idle past its
 * window, releasing read state and deleting half-written temp files, so a
 * vanished peer cannot pin resources forever.
 */

/** Default chunk size: ~1.4 MiB on the wire after base64, under every body ceiling in the path. */
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;

/** Ceiling for one session-transfered file; whole-file tools stay at their smaller ceiling. */
export const DEFAULT_SESSION_MAX_BYTES = 100 * 1024 * 1024;

/** How long an untouched session survives before its resources are released. */
export const DEFAULT_IDLE_MS = 10 * 60 * 1000;

/** Error with a stable `code`. */
class SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

/** SHA-256 of a buffer, lowercase hex — the only digest format on the wire. */
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Create the read-session manager (serving local files to a peer).
 *
 * @param {{ allowedDirs?: string[], chunkSize?: number, maxBytes?: number, clock?: () => Date, idleMs?: number }} options - policy and limits.
 * @returns {{ open: (input: { path: string }) => Promise<object>, chunk: (transferId: string, index: number) => Promise<object>, close: (transferId: string) => Promise<object> }} the manager.
 */
export function createReadSessions({
  allowedDirs,
  chunkSize = DEFAULT_CHUNK_SIZE,
  maxBytes = DEFAULT_SESSION_MAX_BYTES,
  clock = () => new Date(),
  idleMs = DEFAULT_IDLE_MS,
} = {}) {
  const sessions = new Map(); // transferId -> { path, bytes, sha256, chunkSize, totalChunks, lastUsed }

  /** Drop sessions idle past the window. */
  const sweep = () => {
    const now = clock().getTime();
    for (const [id, session] of sessions) {
      if (now - session.lastUsed.getTime() > idleMs) sessions.delete(id);
    }
  };

  return {
    async open({ path }) {
      sweep();

      let canonical;
      try {
        canonical = await realpath(path);
      } catch (cause) {
        if (cause?.code === 'ENOENT') throw new SessionError('file-missing', `no such file: ${path}`);
        throw new SessionError('file-unreadable', `cannot resolve ${path}: ${cause.message}`);
      }

      if (Array.isArray(allowedDirs) && allowedDirs.length > 0) {
        const roots = await Promise.all(
          allowedDirs.map(async (dir) => {
            try {
              return await realpath(dir);
            } catch {
              return dir;
            }
          }),
        );
        if (!roots.some((root) => isPathInside(canonical, root))) {
          throw new SessionError('path-not-allowed', `path is outside the allowlist: ${path}`);
        }
      }

      const info = await stat(canonical).catch(() => undefined);
      if (info === undefined || !info.isFile()) {
        throw new SessionError('not-a-file', `not a regular file: ${path}`);
      }
      if (info.size > maxBytes) {
        throw new SessionError('file-too-large', `file is ${String(info.size)} bytes, over the ${String(maxBytes)} byte limit`);
      }

      // The whole-file digest is computed once, up front: the peer verifies
      // every chunk against it at assembly time, so it must exist before the
      // first chunk is served.
      const bytes = await readFile(canonical).catch((cause) => {
        throw new SessionError('file-unreadable', `cannot read ${canonical}: ${cause.message}`);
      });

      const transferId = `read-${randomUUID()}`;
      sessions.set(transferId, {
        path: canonical,
        bytes: bytes.byteLength,
        sha256: digest(bytes),
        chunkSize,
        totalChunks: Math.max(1, Math.ceil(bytes.byteLength / chunkSize)),
        lastUsed: clock(),
      });

      return {
        transferId,
        name: safeName(canonical),
        bytes: bytes.byteLength,
        sha256: digest(bytes),
        chunkSize,
        totalChunks: Math.max(1, Math.ceil(bytes.byteLength / chunkSize)),
      };
    },

    async chunk(transferId, index) {
      sweep();
      const session = sessions.get(transferId);
      if (session === undefined) throw new SessionError('transfer-unknown', `no such transfer: ${transferId}`);

      if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
        throw new SessionError('chunk-out-of-range', `chunk ${String(index)} of ${String(session.totalChunks)}`);
      }
      session.lastUsed = clock();

      const handle = await open(session.path, 'r').catch((cause) => {
        throw new SessionError('file-unreadable', `cannot reopen ${session.path}: ${cause.message}`);
      });
      try {
        const start = index * session.chunkSize;
        const length = Math.min(session.chunkSize, session.bytes - start);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        const slice = buffer.subarray(0, bytesRead);
        return { index, data: slice.toString('base64'), sha256: digest(slice) };
      } finally {
        await handle.close();
      }
    },

    async close(transferId) {
      sweep();
      if (!sessions.delete(transferId)) {
        throw new SessionError('transfer-unknown', `no such transfer: ${transferId}`);
      }
      return { ok: true };
    },
  };
}

/**
 * Create the receive-session manager (assembling a peer's file into staging).
 *
 * @param {{ stagingDir: string, chunkSize?: number, maxBytes?: number, clock?: () => Date, idleMs?: number }} options - where assemblies land and the limits.
 * @returns {{ begin: (input: { name: string, bytes: number, sha256: string }) => Promise<object>, chunk: (input: { transferId: string, index: number, data: string, sha256: string }) => Promise<object>, finish: (transferId: string) => Promise<object>, cancel: (transferId: string) => Promise<object> }} the manager.
 */
export function createReceiveSessions({
  stagingDir,
  chunkSize = DEFAULT_CHUNK_SIZE,
  maxBytes = DEFAULT_SESSION_MAX_BYTES,
  clock = () => new Date(),
  idleMs = DEFAULT_IDLE_MS,
} = {}) {
  const sessions = new Map(); // transferId -> { tempPath, target, bytes, sha256, chunkSize, totalChunks, received:Set, handle, lastUsed }

  /** Release one session's resources (handle + temp file). */
  const release = async (session) => {
    await session.handle?.close().catch(() => {});
    session.handle = undefined;
    await unlink(session.tempPath).catch(() => {});
  };

  /** Drop sessions idle past the window, temp files included. */
  const sweep = async () => {
    const now = clock().getTime();
    for (const [id, session] of sessions) {
      if (now - session.lastUsed.getTime() > idleMs) {
        sessions.delete(id);
        await release(session);
      }
    }
  };

  return {
    async begin({ name, bytes, sha256 }) {
      await sweep();

      if (!Number.isInteger(bytes) || bytes < 0) {
        throw new SessionError('bytes-invalid', 'the declared size must be a non-negative integer');
      }
      if (bytes > maxBytes) {
        throw new SessionError('file-too-large', `incoming file is ${String(bytes)} bytes, over the ${String(maxBytes)} byte limit`);
      }
      if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sha256)) {
        throw new SessionError('hash-invalid', 'the declared whole-file sha256 must be lowercase hex');
      }

      const target = safeName(name);
      const tempPath = join(stagingDir, `.incoming-${randomUUID()}.tmp`);
      const handle = await open(tempPath, 'w').catch((cause) => {
        throw new SessionError('staging-unwritable', `cannot create the temp file in staging: ${cause.message}`);
      });

      const transferId = `recv-${randomUUID()}`;
      sessions.set(transferId, {
        tempPath,
        target,
        bytes,
        sha256,
        chunkSize,
        totalChunks: Math.max(1, Math.ceil(bytes / chunkSize)),
        received: new Set(),
        handle,
        lastUsed: clock(),
      });

      return {
        transferId,
        chunkSize,
        totalChunks: Math.max(1, Math.ceil(bytes / chunkSize)),
      };
    },

    async chunk({ transferId, index, data, sha256 }) {
      await sweep();
      const session = sessions.get(transferId);
      if (session === undefined) throw new SessionError('transfer-unknown', `no such transfer: ${transferId}`);

      if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
        throw new SessionError('chunk-out-of-range', `chunk ${String(index)} of ${String(session.totalChunks)}`);
      }
      session.lastUsed = clock();

      const buffer = Buffer.from(typeof data === 'string' ? data : '', 'base64');
      const expectedLength = Math.min(session.chunkSize, session.bytes - index * session.chunkSize);
      if (buffer.byteLength !== expectedLength) {
        throw new SessionError(
          'chunk-length-mismatch',
          `chunk ${String(index)} carries ${String(buffer.byteLength)} bytes, expected ${String(expectedLength)}`,
        );
      }
      if (typeof sha256 !== 'string' || sha256 !== digest(buffer)) {
        throw new SessionError('chunk-hash-mismatch', `chunk ${String(index)} failed its digest check`);
      }

      // Idempotent per index: a re-sent chunk is acknowledged, not rewritten,
      // which is what makes an upload resumable after a dropped link.
      if (!session.received.has(index)) {
        await session.handle.write(buffer, 0, buffer.byteLength, index * session.chunkSize);
        session.received.add(index);
      }
      return { index, received: session.received.size, totalChunks: session.totalChunks };
    },

    async finish(transferId) {
      await sweep();
      const session = sessions.get(transferId);
      if (session === undefined) throw new SessionError('transfer-unknown', `no such transfer: ${transferId}`);

      if (session.received.size < session.totalChunks) {
        throw new SessionError(
          'transfer-incomplete',
          `received ${String(session.received.size)} of ${String(session.totalChunks)} chunks`,
        );
      }
      session.lastUsed = clock();

      await session.handle.close();
      session.handle = undefined;

      const assembled = await readFile(session.tempPath).catch((cause) => {
        throw new SessionError('staging-unreadable', `cannot read the assembled temp file: ${cause.message}`);
      });
      const actual = digest(assembled);
      if (actual !== session.sha256) {
        await release(session);
        sessions.delete(transferId);
        throw new SessionError('hash-mismatch', `assembled sha256 ${actual} does not match the declared ${session.sha256}`);
      }

      // Exclusive landing: never overwrite, suffix on collision, rename is
      // atomic so staging never holds a half-visible name.
      let landed;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = attempt === 0 ? session.target : withSuffix(session.target, attempt);
        const path = join(stagingDir, candidate);
        const exists = await access(path)
          .then(() => true)
          .catch(() => false);
        if (exists) continue;
        try {
          await rename(session.tempPath, path);
          landed = { name: candidate, path, bytes: session.bytes, sha256: actual };
          break;
        } catch (cause) {
          if (cause?.code === 'EEXIST' || cause?.code === 'EPERM') continue;
          throw new SessionError('staging-unwritable', `cannot land ${path}: ${cause.message}`);
        }
      }
      if (landed === undefined) {
        await release(session);
        throw new SessionError('staging-collision', `could not find a free name for ${session.target} in staging`);
      }

      sessions.delete(transferId);
      return landed;
    },

    async cancel(transferId) {
      await sweep();
      const session = sessions.get(transferId);
      if (session === undefined) throw new SessionError('transfer-unknown', `no such transfer: ${transferId}`);
      sessions.delete(transferId);
      await release(session);
      return { ok: true };
    },
  };
}

/**
 * Insert a collision marker before the extension, mirroring transfer.js.
 *
 * @param {string} name - safe basename.
 * @param {number} attempt - collision counter, at least 1.
 * @returns {string} the suffixed name.
 */
function withSuffix(name, attempt) {
  const dot = name.lastIndexOf('.');
  const marker = `-${String(attempt)}-${randomUUID().slice(0, 4)}`;
  return dot <= 0 ? `${name}${marker}` : `${name.slice(0, dot)}${marker}${name.slice(dot)}`;
}
