#!/usr/bin/env node
/**
 * Pair with one machine and smoke-test the whole channel.
 *
 *   node scripts/pair-smoke-test.mjs dshp://host:7331/CODE [--cwd <remote-dir>]
 *
 * Pairs (the code is one-time and short-lived - run this promptly), lists the
 * remote tool surface, pushes a small file (chunked when the remote supports
 * it, whole-file otherwise), and runs one tiny ask when a valid --cwd is
 * supplied or can be probed.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeerService } from '../src/service.js';
import { createJsonRpcCaller, sendChunked } from '../src/transfer-client.js';

const argv = process.argv.slice(2);
const link = argv.find((a) => a.startsWith('dsh'));
const cwdArg = argv.includes('--cwd') ? argv[argv.indexOf('--cwd') + 1] : undefined;
if (link === undefined) {
  console.error('usage: node scripts/pair-smoke-test.mjs dshp://host:port/CODE [--cwd remote-dir]');
  process.exit(1);
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const home = await mkdtemp(join(tmpdir(), 'pair-smoke-'));
const local = await mkdtemp(join(tmpdir(), 'pair-smoke-local-'));

const desk = await createPeerService({
  home,
  deviceName: 'PANDA-desk',
  executor: { ask: async () => ({ answer: '', stderr: '', exitCode: 0, timedOut: false }) },
  listen: false,
  log: () => {},
});

try {
  // ── 1) pair ────────────────────────────────────────────────────────────
  const outcome = await desk.pair({ link });
  if (outcome.ok !== true) {
    console.log(`配对失败: ${JSON.stringify(outcome)}`);
    process.exit(1);
  }
  console.log(`配对成功: ${outcome.peer.name} @ ${outcome.peer.address} mounted=${outcome.mounted === true}`);

  // ── 2) remote tool surface ─────────────────────────────────────────────
  const endpoint = await desk.transferEndpointFor('PANDA-desk');
  const call = createJsonRpcCaller(endpoint);
  const probe = await fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: endpoint.authorization },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const tools = (await probe.json())?.result?.tools?.map((t) => t.name).sort() ?? [];
  console.log(`远端工具面（${String(tools.length)} 个）: ${tools.join(', ')}`);

  // ── 3) push a file (chunked when possible, legacy otherwise) ───────────
  const marker = `pair-smoke-${randomUUID().slice(0, 8)}`;
  const payload = Buffer.from(`hello from PANDA @ ${new Date().toISOString()}\nmarker: ${marker}\n`, 'utf8');
  const localFile = join(local, `${marker}.txt`);
  await writeFile(localFile, payload);

  if (tools.includes('send_begin')) {
    const sent = await sendChunked({ callTool: call, localPath: localFile });
    console.log(`分片推送 OK: ${sent.name} (${String(sent.bytes)}B) -> ${sent.path}`);
  } else if (tools.includes('send_file')) {
    const sent = await call('send_file', {
      name: `${marker}.txt`,
      content: payload.toString('base64'),
      sha256: sha256(payload),
    });
    console.log(`整文件推送 OK（旧通道）: ${JSON.stringify(sent)}`);
  } else {
    console.log('远端无文件接收工具，跳过推送');
  }

  // ── 4) one tiny ask, if a cwd is available ─────────────────────────────
  const candidates = [cwdArg, ...(tools.length > 0 ? [] : [])].filter((c) => c !== undefined);
  for (const cwd of candidates) {
    try {
      const answer = await call('ask', { prompt: `只做一件事：输出一行文本，格式为 PONG | <当前用户名> | <操作系统> ，不要其他内容。`, ...(cwd !== undefined && { cwd }) });
      console.log(`ask 成功（cwd=${String(cwd)}）: ${JSON.stringify(answer).slice(0, 300)}`);
      break;
    } catch (cause) {
      console.log(`ask 失败（cwd=${String(cwd)}）: ${String(cause?.code ?? cause?.message)}`);
    }
  }
  if (candidates.length === 0) {
    console.log('未提供 --cwd，跳过 ask（对方白名单目录未知）');
  }
} finally {
  await desk.stop().catch(() => {});
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(local, { recursive: true, force: true }).catch(() => {});
}
