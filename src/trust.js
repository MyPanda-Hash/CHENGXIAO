import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The trust store: who is allowed to run work on this machine.
 *
 * Two rules shape it:
 *
 * - **Credentials are stored as hashes.** A copy of the trust file must not be
 *   a working credential for anyone. The raw key is returned to the peer once,
 *   at pairing time, and never written.
 * - **Refusing beats resetting.** A trust file that cannot be understood is an
 *   error, never a fresh start: silently resetting would drop every pairing and
 *   leave the machine accepting work from nobody while looking healthy.
 *
 * Writes serialize through one chain and land through a temp file plus rename,
 * so a reader never sees a half-written store and concurrent adds all survive.
 */

/** On-disk format version; a newer file is refused rather than misread. */
const FORMAT_VERSION = 1;

/** Bytes of randomness behind one peer credential. */
const CREDENTIAL_BYTES = 32;

/** Policy applied to a peer that was paired without an explicit one. */
export const DEFAULT_PEER_POLICY = Object.freeze({ preset: 'workspace-write' });

/** Stores that hold credentials or the identity are owner-only. */
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

/** Stable error with a `code`, so callers branch on the code and not on prose. */
class TrustError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'TrustError';
    this.code = code;
  }
}

/**
 * SHA-256 of a credential, as lowercase hex. The only form ever written down.
 *
 * @param {string} credential - the raw peer credential.
 * @returns {string} lowercase hex digest.
 */
export function hashCredential(credential) {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}

/**
 * Open (or create) the trust store for one harness home.
 *
 * @param {{ home: string }} options - harness home directory.
 * @returns {Promise<{
 *   identity: { installId: string, publicKey: string },
 *   listPeers: () => object[],
 *   identify: (credential: unknown) => object | undefined,
 *   addPeer: (input: { name: string, publicKey: string, policy?: object }) => Promise<{ peer: object, credential: string }>,
 *   revokePeer: (id: string) => Promise<object>,
 *   assertPublicKeyMatches: (credential: unknown, publicKey: string) => true,
 * }>} the store.
 * @throws {TrustError} when the existing file is unreadable or from a newer version.
 */
export async function openTrustStore({ home }) {
  const directory = join(home, 'dsh-peer');
  const path = join(directory, trustFileName());

  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });

  const existing = await readState(path);
  const state = existing ?? newState();
  if (existing === undefined) await writeState(path, state);

  const credentialIndex = new Map(
    state.peers.filter((peer) => typeof peer.keyHash === 'string').map((peer) => [peer.keyHash, peer.id]),
  );

  /** Serializes writes so two concurrent adds cannot clobber each other. */
  let writes = Promise.resolve();

  const persist = () => {
    writes = writes.then(async () => {
      await writeState(path, state);
    });
    return writes;
  };

  const peerById = (id) => state.peers.find((peer) => peer.id === id);

  return {
    identity: state.identity,

    listPeers() {
      return state.peers.map((peer) => ({ ...peer }));
    },

    identify(credential) {
      if (typeof credential !== 'string' || credential === '') return undefined;
      const id = credentialIndex.get(hashCredential(credential));
      if (id === undefined) return undefined;
      const peer = peerById(id);
      if (peer === undefined || peer.revokedAt !== undefined) return undefined;
      return { ...peer };
    },

    async addPeer({ name, publicKey, policy = DEFAULT_PEER_POLICY, channelKey, relayDeviceId }) {
      const credential = randomBytes(CREDENTIAL_BYTES).toString('base64url');
      const peer = {
        id: randomUUID(),
        name: name,
        publicKey: publicKey,
        keyHash: hashCredential(credential),
        policy: { ...policy },
        pairedAt: new Date().toISOString(),
        // The relay message channel key and the peer's relay device id, present
        // only for peers paired over a relay; the worker needs both to open
        // sealed relay traffic from that peer.
        ...(typeof channelKey === 'string' && { channelKey }),
        ...(typeof relayDeviceId === 'string' && { relayDeviceId }),
      };

      state.peers.push(peer);
      credentialIndex.set(peer.keyHash, peer.id);
      await persist();

      return { peer: { ...peer }, credential };
    },

    async revokePeer(id) {
      const peer = peerById(id);
      if (peer === undefined) throw new TrustError('peer-unknown', `no such peer: ${id}`);
      if (peer.revokedAt !== undefined) return { ...peer };

      peer.revokedAt = new Date().toISOString();
      await persist();
      return { ...peer };
    },

    assertPublicKeyMatches(credential, publicKey) {
      const peer = this.identify(credential);
      if (peer === undefined) throw new TrustError('credential-unknown', 'unknown credential');
      if (peer.publicKey !== publicKey) {
        throw new TrustError(
          'public-key-mismatch',
          'the presented public key does not match the paired peer',
        );
      }
      return true;
    },
  };
}

/**
 * Name of the trust file. DSH reads its own secrets next to it, so the plugin
 * keeps its own file rather than sharing one.
 *
 * @returns {string} file name.
 */
function trustFileName() {
  return 'trust.json';
}

/**
 * Fresh state with a new installation identity.
 *
 * @returns {{ version: number, identity: { installId: string, publicKey: string }, peers: object[] }} the state.
 */
function newState() {
  return {
    version: FORMAT_VERSION,
    identity: {
      installId: randomUUID(),
      publicKey: randomBytes(CREDENTIAL_BYTES).toString('base64url'),
    },
    peers: [],
  };
}

/**
 * Read and validate the store, distinguishing "absent" from "broken".
 *
 * @param {string} path - trust file path.
 * @returns {Promise<object | undefined>} the state, or undefined when the file does not exist.
 * @throws {TrustError} when the file exists but cannot be trusted.
 */
async function readState(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (cause?.code === 'ENOENT') return undefined;
    throw new TrustError('trust-unreadable', `cannot read ${path}: ${cause?.message}`, { cause });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new TrustError('trust-unreadable', `${path} is not valid JSON; refusing to reset it`, {
      cause,
    });
  }

  if (parsed?.version !== FORMAT_VERSION) {
    throw new TrustError(
      'trust-version-unsupported',
      `${path} has format version ${String(parsed?.version)}; this build understands ${String(FORMAT_VERSION)}`,
    );
  }
  if (parsed.identity?.installId === undefined || !Array.isArray(parsed.peers)) {
    throw new TrustError('trust-unreadable', `${path} is missing its identity or peer list`);
  }

  return parsed;
}

/**
 * Write the store atomically, so a reader never observes a partial file.
 *
 * @param {string} path - trust file path.
 * @param {object} state - the state to write.
 * @returns {Promise<void>} resolves once the rename landed.
 */
async function writeState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: PRIVATE_FILE_MODE,
  });
  await rename(temporary, path);
}
