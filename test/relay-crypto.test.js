import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPair,
  deriveSessionKey,
  seal,
  open,
  parseKey,
  encodeKey,
} from '../src/relay/crypto.js';

test('a key pair yields matching session keys on both sides', () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const fromA = deriveSessionKey({ privateKey: a.privateKey, peerPublicKey: b.publicKey });
  const fromB = deriveSessionKey({ privateKey: b.privateKey, peerPublicKey: a.publicKey });
  assert.equal(fromA.toString('hex'), fromB.toString('hex'), 'ECDH must agree on both sides');
});

test('seal then open round-trips plaintext', () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const key = deriveSessionKey({ privateKey: a.privateKey, peerPublicKey: b.publicKey });
  const sealed = seal({ key, plaintext: JSON.stringify({ task: 'list files' }) });
  assert.equal(open({ key, sealed }), JSON.stringify({ task: 'list files' }));
});

test('a tampered ciphertext refuses to open', () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const key = deriveSessionKey({ privateKey: a.privateKey, peerPublicKey: b.publicKey });
  const sealed = seal({ key, plaintext: 'secret' });
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('00') ? 'ff' : '00');
  assert.equal(open({ key, sealed: tampered }), undefined);
});

test('the wrong session key refuses to open', () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const c = generateKeyPair();
  const right = deriveSessionKey({ privateKey: a.privateKey, peerPublicKey: b.publicKey });
  const wrong = deriveSessionKey({ privateKey: a.privateKey, peerPublicKey: c.publicKey });
  const sealed = seal({ key: right, plaintext: 'secret' });
  assert.equal(open({ key: wrong, sealed }), undefined);
});

test('public keys survive base64url encoding round-trip', () => {
  const a = generateKeyPair();
  const encoded = encodeKey(a.publicKey);
  assert.deepEqual(parseKey(encoded), a.publicKey);
});
