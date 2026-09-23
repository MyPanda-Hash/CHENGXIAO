import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { Config } from '../lib/plugin.js';
import { createPeerService } from '../src/service.js';

const KEY = '0123456789abcdef0123456789abcdef';

const homes = [];
const newHome = async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-peer-relay-config-'));
  homes.push(home);
  return home;
};
test.after(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

test('relay environment variables resolve into config', () => {
  const config = readConfig(
    {
      DSH_PEER_KEY: KEY,
      DSH_PEER_RELAY_URL: 'https://relay.example.com',
      DSH_PEER_RELAY_DEVICE_ID: 'my-device',
    },
    'C:\\work',
  );
  assert.equal(config.relayUrl, 'https://relay.example.com');
  assert.equal(config.relayDeviceId, 'my-device');
});

test('no relay variables means no relay config, which is the safe default', () => {
  const config = readConfig({ DSH_PEER_KEY: KEY }, 'C:\\work');
  assert.equal(config.relayUrl, undefined);
  assert.equal(config.relayDeviceId, undefined);
});

test('the plugin schema accepts relay settings and rejects a malformed URL', () => {
  const ok = Config['~standard'].validate({ relayUrl: 'https://relay.example.com', relayEnabled: true });
  assert.equal(ok.issues, undefined);
  assert.equal(ok.value.relayEnabled, true);
  assert.equal(ok.value.relayUrl, 'https://relay.example.com');
  assert.equal(ok.value.relayDeviceId, undefined, 'an unset device id falls back to the install id');

  const bad = Config['~standard'].validate({ relayUrl: 'not a url', relayEnabled: true });
  assert.ok(bad.issues.length > 0, 'a malformed relay URL must fail at load time');
});

test('the schema refuses relay enabled without a URL', () => {
  const bad = Config['~standard'].validate({ relayEnabled: true });
  assert.ok(bad.issues.length > 0, 'relay enabled with no relay to reach is a configuration error');
});

test('a relay-enabled service with no relay reachable fails loudly at startup', async () => {
  await assert.rejects(
    async () =>
      await createPeerService({
        home: await newHome(),
        deviceName: 'desk',
        executor: { ask: async () => ({ answer: '' }) },
        relay: { url: 'http://127.0.0.1:1', deviceId: 'desk-id', enabled: true },
        log: () => {},
      }),
    (error) => error.code === 'relay-unreachable' || error.code === 'relay-register-failed',
  );
});
