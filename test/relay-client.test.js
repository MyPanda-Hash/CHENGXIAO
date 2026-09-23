import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayServer } from '../src/relay/server.js';
import { createRelayClient } from '../src/relay/client.js';

test('two clients exchange a request and a response through the relay', async () => {
  const relay = await createRelayServer({ log: () => {} });
  const a = createRelayClient({ url: relay.url, deviceId: 'device-a' });
  const b = createRelayClient({ url: relay.url, deviceId: 'device-b' });
  try {
    await a.register();
    await b.register();

    b.onMessage(async (envelope) => {
      if (envelope.kind !== 'request') return;
      await b.send({ to: envelope.from, from: 'device-b', kind: 'response', id: envelope.id, body: { answer: 'pong' } });
    });

    const answer = await a.request({ to: 'device-b', kind: 'request', body: { ping: 1 } });
    assert.deepEqual(answer, { answer: 'pong' });
  } finally {
    await a.stop();
    await b.stop();
    await relay.close();
  }
});

test('a request to a registered device that never answers times out with a stable code', async () => {
  const relay = await createRelayServer({ log: () => {} });
  const a = createRelayClient({ url: relay.url, deviceId: 'device-a' });
  try {
    await a.register();
    // The peer is registered but nobody polls its mailbox, so the request can
    // only end in the caller-side timeout — not in a send-time refusal.
    const res = await fetch(`${relay.url}/relay/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'silent-device' }),
    });
    assert.equal(res.status, 200);

    await assert.rejects(
      () => a.request({ to: 'silent-device', kind: 'request', body: {}, timeoutMs: 150 }),
      (error) => error.code === 'relay-request-timeout',
    );
  } finally {
    await a.stop();
    await relay.close();
  }
});

test('the client reports registration and network failures with codes, not throws', async () => {
  const a = createRelayClient({ url: 'http://127.0.0.1:1', deviceId: 'device-a' });
  await assert.rejects(() => a.register(), (error) => typeof error.code === 'string');
  await a.stop();
});
