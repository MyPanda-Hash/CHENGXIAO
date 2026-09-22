import { createHash, randomUUID } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isPathInside } from './reject.js';

/**
 * The file channel between two peers.
 *
 * Files never move homes: what crosses the wire is bytes, and what lands on
 * this machine lands in a staging directory with a verified hash. The peer
 * cannot name a destination, so a compromised or confused peer cannot write
 * over this workspace.
 */

/** Default ceiling for one transferred file. The wire format carries base64 over JSON, so keep it modest. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Error with a stable `code`, so callers map it to a tool error instead of parsing prose. */
class TransferError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
  }
}

/**
 * Reduce any peer-supplied name to a plain basename.
 *
 * Handles Windows and POSIX separators, absolute paths, drive letters and
 * `..` segments, so the result can only ever name a child of the staging
 * directory.
 *
 * @param {string} rawName - peer-supplied file name.
 * @returns {string} a safe basename.
 */
export function safeName(rawName) {
  const text = typeof rawName === 'string' ? rawName : '';
  const withoutTraversal = text
    .split(/[\\/]+/u)
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .pop();
  const cleaned = (withoutTraversal ?? '').replace(/[<>:"|?*\u0000-\u001f]/gu, '_').trim();
  const name = basename(cleaned);
  return name === '' || name === '.' || name === '..' ? 'unnamed' : name;
}

/**
 * Read one local file for sending to a peer.
 *
 * @param {{ path: string, allowedDirs?: string[], maxBytes?: number }} options - what to read and under which policy.
 * @returns {Promise<{ name: string, bytes: number, sha256: string, content: string }>} the wire-shaped file.
 */
export async function readOutgoing({ path, allowedDirs, maxBytes = DEFAULT_MAX_BYTES }) {
  const requested = await resolveExisting(path);

  if (Array.isArray(allowedDirs) && allowedDirs.length > 0) {
    const canonicalRoots = await Promise.all(
      allowedDirs.map(async (dir) => {
        try {
          return await realpath(dir);
        } catch {
          return dir;
        }
      }),
    );
    if (!canonicalRoots.some((root) => isPathInside(requested, root))) {
      throw new TransferError('path-not-allowed', `path is outside the allowlist: ${path}`);
    }
  }

  const info = await stat(requested);
  if (!info.isFile()) {
    throw new TransferError('not-a-file', `not a regular file: ${path}`);
  }
  if (info.size > maxBytes) {
    throw new TransferError(
      'file-too-large',
      `file is ${String(info.size)} bytes, over the ${String(maxBytes)} byte limit`,
    );
  }

  const bytes = await readFileBytes(requested);
  if (bytes.byteLength > maxBytes) {
    throw new TransferError(
      'file-too-large',
      `file grew past the ${String(maxBytes)} byte limit while being read`,
    );
  }

  return {
    name: safeName(requested),
    bytes: bytes.byteLength,
    sha256: digest(bytes),
    content: bytes.toString('base64'),
  };
}

/**
 * Write one peer-supplied file into the staging directory.
 *
 * The hash is verified before anything touches the disk, and the write is
 * exclusive and atomic, so a mismatch or a name collision can never destroy an
 * existing file.
 *
 * @param {{ name: string, content: string, sha256: string, stagingDir: string, maxBytes?: number }} options - what to stage.
 * @returns {Promise<{ name: string, path: string, bytes: number, sha256: string }>} where it landed.
 */
export async function stageIncoming({
  name,
  content,
  sha256,
  stagingDir,
  maxBytes = DEFAULT_MAX_BYTES,
}) {
  const bytes = Buffer.from(typeof content === 'string' ? content : '', 'base64');
  if (bytes.byteLength > maxBytes) {
    throw new TransferError(
      'file-too-large',
      `incoming file is ${String(bytes.byteLength)} bytes, over the ${String(maxBytes)} byte limit`,
    );
  }

  const actual = digest(bytes);
  if (typeof sha256 !== 'string' || sha256.toLowerCase() !== actual) {
    throw new TransferError(
      'hash-mismatch',
      `declared sha256 ${String(sha256)} does not match the received bytes (${actual})`,
    );
  }

  const safe = safeName(name);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = attempt === 0 ? safe : withSuffix(safe, attempt);
    const path = join(stagingDir, candidate);
    const handle = await openExclusive(path);
    if (handle === undefined) continue;
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    return { name: candidate, path, bytes: bytes.byteLength, sha256: actual };
  }

  throw new TransferError('staging-collision', `could not find a free name for ${safe} in staging`);
}

/**
 * Resolve one path to its canonical form, mapping filesystem failures onto codes.
 *
 * @param {string} path - path supplied by the caller.
 * @returns {Promise<string>} the canonical absolute path.
 */
async function resolveExisting(path) {
  try {
    return await realpath(path);
  } catch (cause) {
    if (cause?.code === 'ENOENT') throw new TransferError('file-missing', `no such file: ${path}`);
    throw new TransferError('file-unreadable', `cannot resolve ${path}: ${cause?.message}`);
  }
}

/**
 * Read a whole file without keeping a file handle open.
 *
 * @param {string} path - canonical absolute path.
 * @returns {Promise<Buffer>} the file bytes.
 */
async function readFileBytes(path) {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(path);
  } catch (cause) {
    throw new TransferError('file-unreadable', `cannot read ${path}: ${cause?.message}`);
  }
}

/**
 * Open a path for writing only when it does not exist yet.
 *
 * @param {string} path - candidate destination.
 * @returns {Promise<import('node:fs/promises').FileHandle | undefined>} the handle, or undefined when taken.
 */
async function openExclusive(path) {
  try {
    return await open(path, 'wx');
  } catch (cause) {
    if (cause?.code === 'EEXIST') return undefined;
    throw new TransferError('staging-unwritable', `cannot write ${path}: ${cause?.message}`);
  }
}

/**
 * Insert a collision marker before the extension.
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

/**
 * SHA-256 as lowercase hex, the only hash format the wire contract uses.
 *
 * @param {Buffer} bytes - bytes to digest.
 * @returns {string} lowercase hex digest.
 */
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
