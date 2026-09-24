#!/usr/bin/env node
/**
 * Measure the full collaboration chain through a relay.
 *
 * Two fully isolated service instances (separate homes, identities and trust
 * stores) pair and drive each other through a relay - by default the Docker
 * container the repo ships, standing in for a VPS. Every number below is a
 * real wall-clock measurement of the deployed code path: dshr pairing with
 * the X25519 handshake, the async task protocol against a real spawned
 * process, and chunked file transfer over the sealed relay replay.
 *
 * Usage:
 *   node scripts/measure-full-chain.mjs [--relay http://127.0.0.1:7332] [--mib 12]
 *
 * The task executor is a real `node -e` child that sleeps 8s before answering
 * - the same order as a real agent turn - so the sync/async split shows up
 * honestly: ask blocks the caller for the whole turn, submit_task returns
 * immediately.
 */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { hostname, platform, release } from 'node:os';
import { createPeerService } from '../src/service.js';
import { createHeadlessExecutor } from '../src/headless.js';
import { createJsonRpcCaller } from '../src/transfer-client.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const relayUrl = flag('relay', 'http://127.0.0.1:7332');
const mib = Number(flag('mib', '12'));

const rows = [];
const note = (label, ms, remark) => rows.push({ label, ms, remark });
const timed = async (label, fn, remark) => {
  const start = performance.now();
  const value = await fn();
  note(label, performance.now() - start, remark);
  return value;
};
const ms = (value) => `${Math.round(value)} ms`;

/** Deterministic content of an exact size. */
const contentOf = (size, seed = 20260924) => {
  const buffer = Buffer.alloc(size);
  let state = seed;
  for (let index = 0; index < size; index += 1) {
    state = (state * 48271) % 2147483647;
    buffer[index] = state & 0xff;
  }
  return buffer;
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const scratch = [];
const newDir = async (prefix) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

// An 8-second child process: one real spawn per task, answering like an
// agent turn does - long enough that sync vs async is unambiguous.
const executor = createHeadlessExecutor({
  command: [process.execPath, '-e', 'setTimeout(() => process.stdout.write("measured: ok"), 8000)'],
});

const workerHome = await newDir('measure-worker-');
const deskHome = await newDir('measure-desk-');
const workerWs = await newDir('measure-ws-');
const deskWs = await newDir('measure-local-');

let worker;
let desk;
try {
  // ── bring both machines up ─────────────────────────────────────────────
  worker = await timed('双端 service 启动 + 中继注册（worker 侧计）', () =>
    createPeerService({
      home: workerHome,
      deviceName: 'worker',
      executor,
      listen: false,
      relay: { url: relayUrl, deviceId: 'measure-worker', enabled: true },
      allowedDirs: [workerWs],
      log: () => {},
    }),
  );
  desk = await timed('双端 service 启动 + 中继注册（initiator 侧计）', () =>
    createPeerService({
      home: deskHome,
      deviceName: 'desk',
      executor,
      listen: false,
      relay: { url: relayUrl, deviceId: 'measure-desk', enabled: true },
      allowedDirs: [deskWs],
      log: () => {},
    }),
    '各含一次出站注册',
  );

  // ── pair through the relay ─────────────────────────────────────────────
  const ticket = await timed('生成 dshr 配对码', () => worker.createTicket());
  const outcome = await timed('经中继配对（含 X25519 握手与密封应答）', () => desk.pair({ link: ticket.link }));
  if (outcome.ok !== true) throw new Error(`pairing failed: ${JSON.stringify(outcome)}`);

  const endpoint = await desk.transferEndpointFor('desk');
  const call = createJsonRpcCaller(endpoint);

  // ── the task channel against a real 8s child ───────────────────────────
  await timed('ask（同步兼容入口，占满 8s 任务 + 全链路往返）', () =>
    call('ask', { prompt: 'measure me', cwd: workerWs }),
  );

  const submitted = await timed('submit_task（异步提交，立即返回）', () =>
    call('submit_task', { prompt: 'measure async', cwd: workerWs, idempotencyKey: 'measure-1' }),
  );
  const submitStart = performance.now();
  await (async () => {
    for (;;) {
      const status = await call('task_status', { taskId: submitted.taskId });
      if (['completed', 'failed', 'cancelled'].includes(status.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await call('task_result', { taskId: submitted.taskId });
  })();
  note('submit_task → 轮询至结果就绪', performance.now() - submitStart, '含 8s 任务本体，调用方全程不阻塞');

  const cancellable = await call('submit_task', { prompt: 'to be cancelled', cwd: workerWs });
  await timed('cancel_task（击杀运行中子进程）', () => call('cancel_task', { taskId: cancellable.taskId }));
  for (let i = 0; i < 50; i += 1) {
    const status = await call('task_status', { taskId: cancellable.taskId });
    if (status.status === 'cancelled') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // ── the file channel ────────────────────────────────────────────────────
  const big = contentOf(mib * 1024 * 1024);
  const bigSource = join(workerWs, 'dataset.bin');
  await writeFile(bigSource, big);

  const localCopy = join(deskWs, 'pulled.bin');
  const progress = [];
  const pulled = await timed(`fetchPeerFile（${String(mib)} MiB 分片拉取）`, () =>
    desk.fetchPeerFile('desk', bigSource, localCopy, { onProgress: (update) => progress.push(update.received) }),
  );
  const identical = sha256(await readFile(localCopy)) === sha256(big);

  const outgoing = join(deskWs, 'outgoing.bin');
  await writeFile(outgoing, big);
  const sent = await timed(`sendPeerFile（${String(mib)} MiB 分片推送）`, () =>
    desk.sendPeerFile('desk', outgoing),
  );

  const small = contentOf(4 * 1024 * 1024, 77);
  const smallSource = join(workerWs, 'small.bin');
  await writeFile(smallSource, small);
  await timed('fetch_file（4 MiB 整文件，旧通道对照）', () => call('fetch_file', { path: smallSource }));

  // ── report ─────────────────────────────────────────────────────────────
  const seconds = rows[3] ? rows[3].ms / 1000 : 0; // ask row
  const pullRow = rows.find((row) => row.label.startsWith('fetchPeerFile'));
  const pushRow = rows.find((row) => row.label.startsWith('sendPeerFile'));
  console.log('');
  console.log(`| 环节 | 耗时 | 备注 |`);
  console.log(`|---|---|---|`);
  for (const row of rows) {
    console.log(`| ${row.label} | ${ms(row.ms)} | ${row.remark ?? ''} |`);
  }
  if (pullRow) console.log(`| ↳ 拉取吞吐 | ${(mib / (pullRow.ms / 1000)).toFixed(1)} MiB/s | ${String(progress.length)} 块 |`);
  if (pushRow) console.log(`| ↳ 推送吞吐 | ${(mib / (pushRow.ms / 1000)).toFixed(1)} MiB/s | |`);
  console.log('');
  console.log(
    `环境：${platform()} ${release()} @ ${hostname()}，node ${process.version}；` +
      `双隔离 service 实例；中继 = ${relayUrl}（Docker 容器 dsh-peer-relay）；` +
      `执行器 = 真实子进程（8s 应答）；字节一致性校验 ${identical && sha256(await readFile(sent.path)) === sha256(big) ? '通过' : '失败'}。`,
  );
} finally {
  await desk?.stop().catch(() => {});
  await worker?.stop().catch(() => {});
  for (const dir of scratch) await rm(dir, { recursive: true, force: true }).catch(() => {});
}
