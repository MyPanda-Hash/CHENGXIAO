import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Pairing codes: the one moment a stranger can become a peer.
 *
 * A code is short, single-use and short-lived. Its whole job is to authorise one
 * handshake; the durable credential that handshake produces lives in the trust
 * store. So a leaked code is worth one pairing inside its window, not permanent
 * access — and a spent code is remembered as spent rather than forgotten, so a
 * replay is refused as a replay instead of looking like a typo.
 */

/** On-disk format version. */
const FORMAT_VERSION = 1;

/** How long a fresh code stays usable. */
export const DEFAULT_CODE_TTL_MS = 15 * 60 * 1000;

/** Characters a code may use: no I, L, O, 0 or 1, because people retype these. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const CODE_GROUPS = 2;
const CODE_GROUP_LENGTH = 5;

/** How many spent codes to remember for replay detection. */
const SPENT_MEMORY = 32;

/** Stable error with a `code`. */
class PairingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
  }
}

/**
 * Open the pairing store for one harness home.
 *
 * @param {{ home: string, now?: () => Date }} options - harness home and an injectable clock.
 * @returns {Promise<{
 *   create: (input: { address: string, ttlMs?: number }) => object,
 *   listPending: () => object[],
 *   consume: (code: string, claim: { name: string, publicKey: string }) => Promise<object>,
 * }>} the store.
 */
export async function openPairingStore({ home, now = () => new Date() }) {
  const directory = join(home, 'dsh-peer');
  const path = join(directory, 'pairing.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const state = await readState(path);
  await sweep(state, now());

  if (state.pending.length === 0 && state.spent.length === 0) await persist(path, state);

  return {
    async create({ address, ttlMs = DEFAULT_CODE_TTL_MS, policy }) {
      const createdAt = now();
      const code = mintCode();
      // Only derived values are persisted: the code itself and the link that
      // carries it exist solely in this return value. The policy is the
      // operator's grant, so it travels with the ticket until the ticket is spent.
      const record = {
        id: randomUUID(),
        codeHash: hash(code),
        address,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
        ...(policy !== undefined && { policy: { ...policy } }),
      };

      // Only one code is live at a time: issuing a new one retires the old one,
      // so a code left on screen cannot be used after the owner reissues.
      state.pending = [record];
      await persist(path, state);

      return { ...record, code, link: `dshp://${address}/${code}` };
    },

    listPending() {
      sweep(state, now());
      return state.pending.map(({ codeHash: _ignored, ...safe }) => ({
        ...safe,
        link: `dshp://${safe.address}/`,
      }));
    },

    async consume(code, claim) {
      const at = now();
      const digest = hash(code);

      if (state.spent.some((entry) => entry.codeHash === digest)) {
        throw new PairingError('code-not-pending', 'this pairing code has already been used');
      }

      sweep(state, at);
      const index = state.pending.findIndex((ticket) => ticket.codeHash === digest);
      if (index === -1) {
        throw new PairingError('code-not-found', 'no pairing code matches what was presented');
      }

      const [ticket] = state.pending.splice(index, 1);
      state.spent.push({ codeHash: digest, spentAt: at.toISOString(), name: claim.name });
      state.spent = state.spent.slice(-SPENT_MEMORY);
      await persist(path, state);

      return {
        ok: true,
        address: ticket.address,
        ticketId: ticket.id,
        ...(ticket.policy !== undefined && { policy: { ...ticket.policy } }),
      };
    },
  };
}

/**
 * Normalise a typed code: case and separators are forgiven, nothing else is.
 *
 * @param {string} code - what the operator typed or pasted.
 * @returns {string} the canonical code form.
 */
export function normaliseCode(code) {
  const compact = String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, '');
  return compact;
}

/**
 * Mint a code a person can read aloud and retype.
 *
 * @returns {string} the formatted code.
 */
function mintCode() {
  const groups = Array.from({ length: CODE_GROUPS }, () =>
    Array.from({ length: CODE_GROUP_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''),
  );
  return groups.join('-');
}

/**
 * SHA-256 of the normalised code, as lowercase hex.
 *
 * @param {string} code - a code in any typing.
 * @returns {string} lowercase hex digest.
 */
function hash(code) {
  return createHash('sha256').update(normaliseCode(code), 'utf8').digest('hex');
}

/**
 * Drop expired tickets so they cannot be replayed later.
 *
 * @param {{ pending: object[] }} state - the store state.
 * @param {Date} at - the current time.
 * @returns {void}
 */
function sweep(state, at) {
  state.pending = state.pending.filter((ticket) => new Date(ticket.expiresAt).getTime() > at.getTime());
}

/**
 * Read the store, treating a missing file as an empty one.
 *
 * @param {string} path - pairing file path.
 * @returns {Promise<{ version: number, pending: object[], spent: object[] }>} the state.
 * @throws {PairingError} when the file exists but cannot be trusted.
 */
async function readState(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      return { version: FORMAT_VERSION, pending: [], spent: [] };
    }
    throw new PairingError('pairing-unreadable', `cannot read ${path}: ${cause?.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Pairing state is disposable, unlike the trust store: a corrupt file only
    // costs the operator a new code, so recovering is safer than refusing to serve.
    return { version: FORMAT_VERSION, pending: [], spent: [] };
  }

  if (parsed?.version !== FORMAT_VERSION || !Array.isArray(parsed.pending) || !Array.isArray(parsed.spent)) {
    return { version: FORMAT_VERSION, pending: [], spent: [] };
  }
  return parsed;
}

/**
 * Write the store atomically.
 *
 * @param {string} path - pairing file path.
 * @param {object} state - the state to write.
 * @returns {Promise<void>} resolves once the rename landed.
 */
async function persist(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, path);
}
