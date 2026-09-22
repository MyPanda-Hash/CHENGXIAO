import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * At-rest protection for a secret this machine must be able to read again.
 *
 * The worker side can store only a hash, because it never needs to replay a
 * credential. The initiating side must present its credential on every request,
 * so it has to keep the real thing — and that means keeping something on disk
 * that a leaked file would hand over. The answer is a separate key file: a
 * backup, a shared folder or a copied data file then carries ciphertext, not a
 * working credential.
 *
 * This is defence in depth, not a boundary. An attacker with read access to the
 * whole directory has both halves, and this module does not pretend otherwise.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * Mint a fresh key.
 *
 * @returns {Buffer} 32 random bytes.
 */
export function mintKey() {
  return randomBytes(KEY_BYTES);
}

/**
 * Encrypt one secret for storage.
 *
 * @param {Buffer} key - the 32-byte key.
 * @param {string} plaintext - the secret to protect.
 * @returns {string} `iv:tag:ciphertext`, all hex.
 */
export function seal(key, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString('hex')].join(':');
}

/**
 * Decrypt one stored secret.
 *
 * @param {Buffer} key - the 32-byte key.
 * @param {string} sealed - the stored form produced by {@link seal}.
 * @returns {string | undefined} the plaintext, or undefined when it cannot be opened.
 */
export function open(key, sealed) {
  if (typeof sealed !== 'string') return undefined;
  const [ivHex, tagHex, dataHex] = sealed.split(':');
  if (ivHex === undefined || tagHex === undefined || dataHex === undefined) return undefined;

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    // A tampered tag or a wrong key must read as "unopenable", never as garbage.
    return undefined;
  }
}
