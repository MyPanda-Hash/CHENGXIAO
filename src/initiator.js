import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mintKey, open as openSealed, seal } from './secrets.js';

/**
 * The initiating machine's record of the workers it may drive.
 *
 * Credentials here are live secrets: this side replays them on every request.
 * They are therefore sealed with a key kept in a separate file, so a stray copy
 * of the peer list — a backup, a synced folder, a pasted file — carries
 * ciphertext rather than access.
 */

const FORMAT_VERSION = 1;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

/** Stable error with a `code`. */
class InitiatorError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'InitiatorError';
    this.code = code;
  }
}

/**
 * Open (or create) the initiating store.
 *
 * @param {{ home: string, deviceName?: string }} options - harness home and an optional device label.
 * @returns {Promise<{
 *   identity: { deviceName: string, publicKey: string },
 *   listPeers: () => object[],
 *   identify: (name: string) => object | undefined,
 *   addPeer: (input: { credential: string, address: string, name: string, workerInstallId?: string }) => Promise<object>,
 *   removePeer: (id: string) => Promise<void>,
 * }>} the store.
 * @throws {InitiatorError} when the existing file cannot be trusted.
 */
export async function openInitiatorStore({ home, deviceName = hostname() }) {
  const directory = join(home, 'dsh-peer');
  const path = join(directory, 'initiator.json');
  const keyPath = join(directory, 'initiator.key');

  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  const key = await loadOrCreateKey(keyPath);
  const state = await readState(path, deviceName);
  await writeState(path, state);

  let writes = Promise.resolve();
  const persist = () => {
    writes = writes.then(async () => {
      await writeState(path, state);
    });
    return writes;
  };

  const toPublicPeer = (record) => ({
    id: record.id,
    name: record.name,
    address: record.address,
    workerInstallId: record.workerInstallId,
    pairedAt: record.pairedAt,
    // Relay routing for peers paired through a relay; the channel key stays
    // sealed and is only opened by identify() at call time.
    ...(record.relay !== undefined && {
      relay: { url: record.relay.url, deviceId: record.relay.deviceId },
    }),
  });

  return {
    identity: state.identity,

    listPeers() {
      return state.peers.map(toPublicPeer);
    },

    identify(name) {
      const record = state.peers.find((peer) => peer.name === name);
      if (record === undefined) return undefined;
      const credential = openSealed(key, record.sealedCredential);
      if (credential === undefined) {
        throw new InitiatorError(
          'credential-unreadable',
          `the stored credential for ${name} cannot be opened; re-pair that worker`,
        );
      }
      // A relay peer also carries the end-to-end channel key, sealed like the
      // credential so a copied file carries no usable secret.
      const channelKey =
        record.relay?.sealedChannelKey !== undefined ? openSealed(key, record.relay.sealedChannelKey) : undefined;
      return {
        ...toPublicPeer(record),
        credential,
        ...(channelKey !== undefined && { channelKey }),
      };
    },

    async addPeer({ credential, address, name, workerInstallId, relay }) {
      const record = {
        id: randomUUID(),
        name,
        address,
        sealedCredential: seal(key, credential),
        ...(workerInstallId !== undefined && { workerInstallId }),
        pairedAt: new Date().toISOString(),
        ...(relay !== undefined && {
          relay: {
            url: relay.url,
            deviceId: relay.deviceId,
            sealedChannelKey: seal(key, relay.channelKey),
          },
        }),
      };

      // Re-pairing the same worker replaces its record: two entries for one
      // machine would mean two MCP clients and duplicate tool names.
      state.peers = state.peers.filter((peer) => peer.name !== name);
      state.peers.push(record);
      await persist();

      return toPublicPeer(record);
    },

    async removePeer(id) {
      state.peers = state.peers.filter((peer) => peer.id !== id);
      await persist();
    },
  };
}

/**
 * Load the sealing key, creating it on first use.
 *
 * @param {string} keyPath - key file path.
 * @returns {Promise<Buffer>} the 32-byte key.
 */
async function loadOrCreateKey(keyPath) {
  try {
    const hex = (await readFile(keyPath, 'utf8')).trim();
    const key = Buffer.from(hex, 'hex');
    if (key.length !== 32) {
      throw new InitiatorError('initiator-key-invalid', `${keyPath} is not a 32-byte key`);
    }
    return key;
  } catch (cause) {
    if (cause instanceof InitiatorError) throw cause;
    if (cause?.code !== 'ENOENT') {
      throw new InitiatorError('initiator-key-unreadable', `cannot read ${keyPath}: ${cause?.message}`, { cause });
    }
  }

  const key = mintKey();
  const temporary = `${keyPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${key.toString('hex')}\n`, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  await rename(temporary, keyPath);
  return key;
}

/**
 * Read the store, distinguishing "absent" from "broken".
 *
 * @param {string} path - store path.
 * @param {string} deviceName - the local device label to use for a fresh store.
 * @returns {Promise<object>} the state.
 * @throws {InitiatorError} when the file exists but cannot be trusted.
 */
async function readState(path, deviceName) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (cause?.code === 'ENOENT') return newState(deviceName);
    throw new InitiatorError('initiator-unreadable', `cannot read ${path}: ${cause?.message}`, { cause });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new InitiatorError('initiator-unreadable', `${path} is not valid JSON; refusing to reset it`, {
      cause,
    });
  }

  if (parsed?.version !== FORMAT_VERSION) {
    throw new InitiatorError(
      'initiator-version-unsupported',
      `${path} has format version ${String(parsed?.version)}; this build understands ${String(FORMAT_VERSION)}`,
    );
  }
  if (parsed.identity?.publicKey === undefined || !Array.isArray(parsed.peers)) {
    throw new InitiatorError('initiator-unreadable', `${path} is missing its identity or peer list`);
  }

  return parsed;
}

/**
 * Fresh state for a machine that has never paired.
 *
 * @param {string} deviceName - the local device label.
 * @returns {{ version: number, identity: object, peers: object[] }} the state.
 */
function newState(deviceName) {
  return {
    version: FORMAT_VERSION,
    identity: {
      deviceName,
      publicKey: randomBytes(32).toString('base64url'),
    },
    peers: [],
  };
}

/**
 * Write the store atomically.
 *
 * @param {string} path - store path.
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
