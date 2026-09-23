import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvelope, validateEnvelope, createMailbox } from '../src/relay/protocol.js';

test('an envelope carries routing fields and a kind', () => {
  const envelope = createEnvelope({ to: 'device-b', from: 'device-a', kind: 'pair', id: 'm-1', body: { code: 'C' } });
  assert.equal(envelope.to, 'device-b');
  assert.equal(envelope.from, 'device-a');
  assert.equal(envelope.kind, 'pair');
  assert.equal(envelope.id, 'm-1');
  assert.deepEqual(envelope.body, { code: 'C' });
});

test('a malformed envelope is rejected with a stable code', () => {
  assert.equal(validateEnvelope(null), 'envelope-malformed');
  assert.equal(validateEnvelope({}), 'envelope-malformed');
  assert.equal(validateEnvelope({ to: 'b', from: 'a' }), 'envelope-malformed');
  assert.equal(validateEnvelope({ to: 'b', from: 'a', kind: 'x', id: '1', body: {} }), undefined);
});

test('a mailbox delivers messages in order, once each', () => {
  const mailbox = createMailbox();
  mailbox.push(createEnvelope({ to: 'b', from: 'a', kind: 'msg', id: '1', body: { n: 1 } }));
  mailbox.push(createEnvelope({ to: 'b', from: 'a', kind: 'msg', id: '2', body: { n: 2 } }));

  assert.equal(mailbox.peekCount('b'), 2);
  const first = mailbox.takeNext('b');
  assert.equal(first.id, '1');
  assert.equal(mailbox.takeNext('b').id, '2');
  assert.equal(mailbox.takeNext('b'), undefined, 'an empty mailbox yields nothing');
});

test('acknowledging removes a message; an unknown ack is harmless', () => {
  const mailbox = createMailbox();
  const envelope = createEnvelope({ to: 'b', from: 'a', kind: 'msg', id: '9', body: {} });
  mailbox.push(envelope);
  const taken = mailbox.takeNext('b');
  assert.equal(taken.id, '9');
  mailbox.ack('b', '9');
  assert.equal(mailbox.peekCount('b'), 0);
  mailbox.ack('b', 'does-not-exist');
  assert.equal(mailbox.peekCount('b'), 0);
});

test('clear drops everything for one device', () => {
  const mailbox = createMailbox();
  mailbox.push(createEnvelope({ to: 'b', from: 'a', kind: 'msg', id: '1', body: {} }));
  mailbox.push(createEnvelope({ to: 'b', from: 'a', kind: 'msg', id: '2', body: {} }));
  mailbox.clear('b');
  assert.equal(mailbox.peekCount('b'), 0);
});
