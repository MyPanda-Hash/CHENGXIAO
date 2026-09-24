#!/usr/bin/env node
/**
 * The machine-B half of a real two-machine measurement.
 *
 * Run this on the worker machine; it registers with the relay, prepares the
 * transfer corpus, prints (and optionally writes) the pairing link plus the
 * paths the initiator needs, and stays up until stopped. Pair it from the
 * other machine with:
 *
 *   node scripts/measure-full-chain.mjs --relay http://<vps>:7332 --pair-info worker-info.json
 *
 * Usage:
 *   node scripts/measure-worker.mjs --relay http://<vps>:7332 [--device-id id] [--mib 12] [--link-out worker-info.json]
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostname, platform } from 'node:os';
import { createPeerService } from '../src/service.js';
import { createHeadlessExecutor } from '../src/headless.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const relayUrl = flag('relay', 'http://127.0.0.1:7332');
const deviceId = flag('device-id', `measure-worker-${hostname()}`);
const mib = Number(flag('mib', '12'));
const linkOut = flag('link-out', undefined);

/** Deterministic content of an exact size - the initiator regenerates and verifies against it. */
const contentOf = (size, seed = 20260924) => {
  const buffer = Buffer.alloc(size);
  let state = seed;
  for (let index = 0; index < size; index += 1) {
    state = (state * 48271) % 2147483647;
    buffer[index] = state & 0xff;
  }
  return buffer;
};

const home = await mkdtemp(join(tmpdir(), 'measure-remote-worker-'));
const workspace = await mkdtemp(join(tmpdir(), 'measure-remote-ws-'));

// The corpus: one chunked-transfer dataset and one whole-file sample, plus
// the workspace itself as the task cwd.
const datasetPath = join(workspace, 'dataset.bin');
await writeFile(datasetPath, contentOf(mib * 1024 * 1024));
const smallPath = join(workspace, 'small.bin');
await writeFile(smallPath, contentOf(4 * 1024 * 1024, 77));

// A real child process answering after 8s - the same order as an agent turn.
const executor = createHeadlessExecutor({
  command: [process.execPath, '-e', 'setTimeout(() => process.stdout.write("measured: ok"), 8000)'],
});

const service = await createPeerService({
  home,
  deviceName: 'worker',
  executor,
  listen: false,
  relay: { url: relayUrl, deviceId, enabled: true },
  allowedDirs: [workspace],
  log: () => {},
});

const ticket = await service.createTicket();
const info = {
  link: ticket.link,
  relayUrl,
  datasetPath,
  smallPath,
  cwd: workspace,
  environment: `${platform()} @ ${hostname()}, node ${process.version}`,
};

console.log('');
console.log('worker 就绪，保持运行（Ctrl+C 退出）。把下面这份信息交给发起端机器：');
console.log('');
console.log(JSON.stringify(info, null, 2));
console.log('');
if (linkOut !== undefined) {
  await writeFile(linkOut, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  console.log(`已写入 ${linkOut}`);
}

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await service.stop().catch(() => {});
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 60_000);
