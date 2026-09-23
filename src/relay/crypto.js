import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes } from 'node:crypto';

/**
 * Device-level end-to-end encryption for relay traffic.
 *
 * Each machine generates one X25519 key pair; the public half is exchanged
 * during pairing. Both sides derive the same session key via ECDH, then all
 * relay message bodies are sealed with AES-256-GCM. The relay never holds a
 * key and never sees plaintext.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const SESSION_BYTES = 32;
const HKDF_SALT = 'dsh-peer-mcp relay v1';

/**
 * Fixed DER prefixes for X25519 keys (RFC 8410). The exported form of a key is
 * the raw 32 bytes; these prefixes rebuild the full SPKI/PKCS8 structures the
 * crypto module requires, so raw buffers survive base64url round-trips.
 */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** Rebuild a public KeyObject from a raw 32-byte X25519 public key. */
function publicKeyFromRaw(raw) {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), type: 'spki', format: 'der' });
}

/** Rebuild a private KeyObject from a raw 32-byte X25519 private scalar. */
function privateKeyFromRaw(raw) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), type: 'pkcs8', format: 'der' });
}

/** Generate an X25519 key pair as raw buffers. */
export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    // The KeyObjects from generateKeyPairSync export DER directly; the raw key
    // material is the last 32 bytes (fixed prefixes above rebuild the rest).
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32),
  };
}

/** Derive a shared 32-byte session key from one side's private key and the peer's public key. */
export function deriveSessionKey({ privateKey, peerPublicKey }) {
  const shared = diffieHellman({
    privateKey: privateKeyFromRaw(privateKey),
    publicKey: publicKeyFromRaw(peerPublicKey),
  });
  return createHash('sha256').update(HKDF_SALT).update(shared).digest().subarray(0, SESSION_BYTES);
}

/** Encode a raw buffer as base64url. */
export function encodeKey(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

/** Decode a base64url string back to a raw buffer. */
export function parseKey(text) {
  return Buffer.from(text, 'base64url');
}

/** Seal one UTF-8 plaintext as `iv:tag:ciphertext`, all base64url. */
export function seal({ key, plaintext }) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
}

/** Open a sealed value; returns undefined when it cannot be authenticated. */
export function open({ key, sealed }) {
  if (typeof sealed !== 'string') return undefined;
  const parts = sealed.split(':');
  if (parts.length !== 3) return undefined;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parts[0], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
