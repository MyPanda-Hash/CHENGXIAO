#!/usr/bin/env node
/**
 * worker.mjs — turn THIS machine into a drivable worker, DSH Desktop closed.
 *
 * Shares ~/.dsh with the plugin (same trust and pairing stores), so
 * credentials issued while DSH was running keep working and vice versa; the
 * only conflict is the port — stop DSH (or pick another) before listening on
 * 7331. Tasks run through `dsh --profile headless`, which is a CLI and needs
 * no Desktop.
 *
 * Usage:
 *   node worker.mjs                       listen on 0.0.0.0:7331, default workspace
 *   node worker.mjs --port 7333           another port (e.g. while DSH is up)
 *   node worker.mjs --dirs "D:\repos"     what a paired peer may touch
 *   node worker.mjs --relay               no inbound port at all (official relay)
 *   node worker.mjs --ticket              print one pairing link and exit
 *   node worker.mjs --status              peers, trust and listener state
 */
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { createPeerService } from './src/service.js';
import { createHeadlessExecutor } from './src/headless.js';
import { resolveTaskCommand } from './src/task-command.js';
import { defaultWorkspace } from './src/config.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  const v = i !== -1 ? argv[i + 1] : undefined;
  if (i !== -1 && (v === undefined || v.startsWith('--'))) return true; // boolean flag
  if (i !== -1) argv.splice(i, 2);
  else if (v === undefined) return fallback;
  return v;
};
const has = (name) => argv.includes(`--${name}`);

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const deviceName = flag('device-name', hostname());
const mode = has('ticket') ? 'ticket' : has('status') ? 'status' : 'run';

// The real task runner: the dsh CLI, headless profile, no Desktop involved.
const resolved = resolveTaskCommand(['dsh', '--profile', 'headless']);
if (!resolved.ok) {
  console.error(`worker: task command not runnable (${resolved.code}): ${resolved.detail}`);
  process.exit(1);
}
const executor = createHeadlessExecutor({
  command: resolved.command,
  env: resolved.env,
  timeoutMs: 10 * 60 * 1000,
});

const buildService = (options) =>
  createPeerService({
    home,
    deviceName,
    executor,
    log: (line) => console.log(`[worker] ${line}`),
    ...options,
  });

if (mode === 'ticket') {
  const relay = flag('relay', false);
  const preset = flag('preset', 'workspace-write');
  const service = await buildService(
    relay === true
      ? { listen: false, allowedDirs: [defaultWorkspace(home)], relay: { url: relay, enabled: true } }
      : { listen: true, host: flag('host', '0.0.0.0'), port: Number(flag('port', 7331)), allowedDirs: [defaultWorkspace(home)] },
  );
  try {
    const ticket = await service.createTicket({ policy: { preset } });
    console.log(`\n配对链接（15 分钟内有效，一次性）：\n  ${ticket.link}\n\n短码：${ticket.code}`);
  } finally {
    await service.stop();
  }
  process.exit(0);
}

if (mode === 'status') {
  const service = await buildService({ listen: false });
  try {
    const status = service.status();
    console.log(`设备名    : ${String(status.deviceName)}`);
    console.log(`连接方式  : ${String(status.connection)}`);
    console.log(`可驱动本机的：${status.trustedBy.map((p) => p.name).join(', ') || '无'}`);
    console.log(`本机可驱动：${status.peers.map((p) => `${p.name}@${String(p.address)}`).join(', ') || '无'}`);
  } finally {
    await service.stop();
  }
  process.exit(0);
}

// ── run mode ──────────────────────────────────────────────────────────────
const relay = flag('relay', false);
const dirsRaw = flag('dirs', undefined);
const allowedDirs =
  dirsRaw !== undefined && dirsRaw !== true
    ? dirsRaw.split(/;/u).map((d) => d.trim()).filter((d) => d !== '')
    : [defaultWorkspace(home)];

const options =
  relay === true
    ? { listen: false, allowedDirs, relay: { url: relay, enabled: true } }
    : { listen: true, host: flag('host', '0.0.0.0'), port: Number(flag('port', 7331)), allowedDirs };

console.log(`worker 启动中（home=${home}）…`);
const service = await buildService(options);

const status = service.status();
console.log(`就绪。设备名 ${String(status.deviceName)}，连接 ${String(status.connection)}，` +
  `工作区 ${allowedDirs.join('; ')}`);
if (status.connection === 'lan') console.log(`监听 ${String(status.address)} —— 对端粘贴 dshp:// 链接或用已有配对凭据`);
if (status.connection === 'relay') console.log(`中继 ${String(status.relay?.url)} —— 用 --ticket 发码`);
console.log('已配对过的对端凭据直接可用（信任库与 DSH 插件共享）。Ctrl+C 停止。');

if (has('with-ticket')) {
  const ticket = await service.createTicket();
  console.log(`\n配对链接（15 分钟内有效，一次性）：\n  ${ticket.link}\n  短码：${ticket.code}\n`);
}

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.log('\nworker 停止中…');
  await service.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 60_000);
