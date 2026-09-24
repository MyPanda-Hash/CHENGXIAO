#!/usr/bin/env node
/**
 * peer.mjs — operate a paired machine from the command line, DSH closed.
 *
 * The pairing credential lives in ~/.dsh (created once via the DSH settings
 * page); this CLI only reads it and dials the peer directly, so nothing on
 * this machine needs to be running. The *peer* machine needs its DSH up
 * (listener or relay, as paired).
 *
 * Usage:
 *   node scripts/peer.mjs status
 *   node scripts/peer.mjs ask "列出当前目录" [--cwd <peer 内的目录>]
 *   node scripts/peer.mjs ls [目录]
 *   node scripts/peer.mjs read <远端文件>
 *   node scripts/peer.mjs pull <远端文件> <本地路径>
 *   node scripts/peer.mjs push <本地文件>
 *
 * --cwd is remembered after the first success (stored in ~/.dsh/peer-cli.json),
 * so day-to-day use needs no flags at all.
 */
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createPeerService } from '../src/service.js';
import { createJsonRpcCaller } from '../src/transfer-client.js';

const HOME = join(homedir(), '.dsh');
const CONFIG = join(HOME, 'peer-cli.json');
const USAGE = `用法: node scripts/peer.mjs <命令> [参数] [--cwd 目录] [--peer 对端名]
命令:
  status                 已配对的对端、地址、远端工具面
  ask "<任务>"           在对端跑一个任务并返回结果
  ls [目录]              列出对端目录
  read <远端文件>         直接读文件内容（≤5MiB；更大用 pull）
  pull <远端文件> <本地>   分片拉取（断点续传、sha256 校验）
  push <本地文件>         分片推送到对端 staging
示例:
  node scripts/peer.mjs ls C:\\yinjia\\peer-workspace
  node scripts/peer.mjs read C:\\yinjia\\peer-workspace\\roundtrip.txt`;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  const v = i !== -1 ? argv[i + 1] : undefined;
  if (i !== -1) argv.splice(i, v !== undefined && !v.startsWith('--') ? 2 : 1);
  return v;
};
const [command, ...rest] = argv;
if (command === undefined || command === 'help') {
  console.log(USAGE);
  process.exit(0);
}

/** Load the remembered default cwd. */
const loadConfig = async () =>
  await readFile(CONFIG, 'utf8')
    .then((t) => JSON.parse(t))
    .catch(() => ({}));

const saveConfig = async (next) => {
  await writeFile(CONFIG, `${JSON.stringify(next, null, 2)}\n`, 'utf8').catch(() => {});
};

const service = await createPeerService({
  home: HOME,
  deviceName: hostname(),
  executor: { ask: async () => ({ answer: '', stderr: '', exitCode: 0, timedOut: false }) },
  listen: false,
  log: () => {},
});

try {
  const peers = service.status().peers;
  const wanted = flag('peer');
  const peer = wanted !== undefined ? peers.find((p) => p.name === wanted) : peers[0];
  if (peer === undefined) {
    console.log('没有已配对的对端。先在一台机器的 DSH 设置页完成配对，再回来用这个 CLI。');
    process.exit(1);
  }

  const endpoint = await service.transferEndpointFor(peer.name);
  const call = createJsonRpcCaller(endpoint);

  /** Friendly hints for the stable refusal codes. */
  const explain = (code) => {
    if (code === 'cwd-not-allowed') return '（该目录在对端白名单之外；用 --cwd 指定对端 allowedDirs 里的目录）';
    if (code === 'path-not-allowed') return '（路径在对端白名单之外，文件通道只读白名单内文件；白名单外用 ask）';
    if (code === 'file-too-large') return '（超过整文件 5MiB 上限，改用 pull 分片拉取）';
    return '';
  };

  const runAsk = async (prompt, cwd) => {
    try {
      const answer = await call('ask', { prompt, ...(cwd !== undefined && { cwd }) });
      if (cwd !== undefined && answer.ok === true) {
        const cfg = await loadConfig();
        if (cfg.cwd !== cwd) await saveConfig({ ...cfg, cwd });
      }
      return answer;
    } catch (cause) {
      console.log(`远端拒绝: ${String(cause?.code ?? cause?.message)} ${explain(cause?.code)}`);
      process.exit(1);
    }
  };

  if (command === 'status') {
    console.log(`对端: ${peer.name} @ ${peer.address}（配对于 ${String(peer.pairedAt)}）`);
    const probe = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: endpoint.authorization },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const tools = (await probe.json())?.result?.tools?.map((t) => t.name).sort() ?? [];
    console.log(`远端工具面（${String(tools.length)} 个）: ${tools.join(', ')}`);
    console.log(`记忆的工作目录: ${String((await loadConfig()).cwd ?? '未设置（首次 ask/ls 带 --cwd 即记住）')}`);
  } else if (command === 'ask') {
    const prompt = rest.join(' ').trim();
    if (prompt === '') { console.log('用法: peer.mjs ask "<任务>"'); process.exit(1); }
    const cwd = flag('cwd') ?? (await loadConfig()).cwd;
    const answer = await runAsk(prompt, cwd);
    console.log(answer.ok === true ? answer.answer : `任务失败: ${String(answer.code)} ${String(answer.detail ?? '')}`);
  } else if (command === 'ls') {
    const cfg = await loadConfig();
    const dir = rest[0] ?? cfg.cwd;
    if (dir === undefined) { console.log('不知道列哪里：先 peer.mjs ls <目录>，或 ask 带 --cwd 建立默认目录。'); process.exit(1); }
    const answer = await runAsk(
      `只做一件事：列出 ${dir} 的全部条目，每行一个，格式：<名称> | <目录/文件> | <大小字节，目录写->。不要输出其他内容。`,
      dir,
    );
    console.log(answer.ok === true ? answer.answer : `失败: ${String(answer.code)}`);
  } else if (command === 'read') {
    const path = rest[0];
    if (path === undefined) { console.log('用法: peer.mjs read <远端文件>'); process.exit(1); }
    try {
      const file = await call('fetch_file', { path });
      process.stdout.write(Buffer.from(file.content, 'base64').toString('utf8'));
    } catch (cause) {
      console.log(`读取失败: ${String(cause?.code ?? cause?.message)} ${explain(cause?.code)}`);
      process.exit(1);
    }
  } else if (command === 'pull') {
    const [remote, local] = rest;
    if (remote === undefined || local === undefined) { console.log('用法: peer.mjs pull <远端文件> <本地路径>'); process.exit(1); }
    try {
      const landed = await service.fetchPeerFile(peer.name, remote, local);
      console.log(`已拉取: ${local}（${String(landed.bytes)}B, sha256=${landed.sha256.slice(0, 16)}…）`);
    } catch (cause) {
      console.log(`拉取失败: ${String(cause?.code ?? cause?.message)} ${explain(cause?.code)}`);
      process.exit(1);
    }
  } else if (command === 'push') {
    const local = rest[0];
    if (local === undefined) { console.log('用法: peer.mjs push <本地文件>'); process.exit(1); }
    try {
      const sent = await service.sendPeerFile(peer.name, local);
      console.log(`已推送: ${sent.name}（${String(sent.bytes)}B）落在对端 ${sent.path}`);
    } catch (cause) {
      console.log(`推送失败: ${String(cause?.code ?? cause?.message)}`);
      process.exit(1);
    }
  } else {
    console.log(`未知命令: ${command}\n\n${USAGE}`);
    process.exit(1);
  }
} finally {
  await service.stop().catch(() => {});
}
