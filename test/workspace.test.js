import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';

test('default workspace lives under the user home and is not the whole home', async () => {
  const { defaultWorkspace } = await import('../src/config.js');
  const workspace = defaultWorkspace('C:\\Users\\alice');
  assert.equal(workspace, 'C:\\Users\\alice\\DSH Workspace');
  assert.notEqual(workspace, 'C:\\Users\\alice');
});

test('status exposes least-privilege collaboration capabilities', async () => {
  const { createPeerService } = await import('../src/service.js');
  const service = await createPeerService({
    home: `${homedir()}/.dsh-test`,
    deviceName: 'test-device',
    executor: { ask: async () => ({ answer: 'ok' }) },
    allowedDirs: ['C:\\Users\\alice\\DSH Workspace'],
  });
  const status = service.status();
  assert.deepEqual(status.capabilities, {
    readWorkspace: true,
    writeWorkspace: true,
    runTask: true,
    transferFiles: true,
    runSystemCommand: false,
    accessOutsideWorkspace: false,
    modifyDshConfig: false,
  });
  await service.stop();
});
