import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayServer } from '../src/relay/server.js';

test('a relay registers devices, forwards messages, and delivers them to the target', async () => {
  const relay = await createRelayServer({ log: () => {} });
  try {
    const origin = relay.url;
    const register = async (deviceId) => {
      const res = await fetch(`${origin}/relay/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId }),
      });
      assert.equal(res.status, 200);
    };
    await register('device-a');
    await register('device-b');

    const send = await fetch(`${origin}/relay/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'device-b', from: 'device-a', kind: 'pair', id: 'm-1', body: { n: 1 } }),
    });
    assert.equal(send.status, 200);

    const poll = await fetch(`${origin}/relay/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-b', timeoutMs: 500 }),
    });
    assert.equal(poll.status, 200);
    const message = await poll.json();
    assert.equal(message.to, 'device-b');
    assert.equal(message.from, 'device-a');
    assert.equal(message.kind, 'pair');
    assert.equal(message.id, 'm-1');
  } finally {
    await relay.close();
  }
});

test('sending to an unregistered device is refused with a stable code', async () => {
  const relay = await createRelayServer({ log: () => {} });
  try {
    const send = await fetch(`${relay.url}/relay/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'nobody', from: 'a', kind: 'msg', id: '1', body: {} }),
    });
    assert.equal(send.status, 404);
    assert.equal((await send.json()).code, 'device-unknown');
  } finally {
    await relay.close();
  }
});

test('a poll with no message waits until the timeout and answers empty', async () => {
  const relay = await createRelayServer({ log: () => {} });
  try {
    const started = Date.now();
    const poll = await fetch(`${relay.url}/relay/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'lonely', timeoutMs: 200 }),
    });
    const elapsed = Date.now() - started;
    assert.equal(poll.status, 200);
    assert.deepEqual(await poll.json(), {});
    assert.ok(elapsed >= 150, 'a long poll must actually wait');
  } finally {
    await relay.close();
  }
});

test('an unknown route is a 404, because the relay is a pure forwarder', async () => {
  const relay = await createRelayServer({ log: () => {} });
  try {
    const res = await fetch(`${relay.url}/relay/not-a-route`, { method: 'POST' });
    assert.equal(res.status, 404);
  } finally {
    await relay.close();
  }
});
