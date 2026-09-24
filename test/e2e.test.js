import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * The whole Adapter as a peer sees it: the real entry point in its own process,
 * the real HTTP listener, the real MCP client, and a real child process for the
 * task. Only the task runner is a stand-in, so this test costs nothing and
 * still covers every layer a peer depends on.
 */

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const KEY = randomBytes(32).toString('base64url');
const workspace = await mkdtemp(join(tmpdir(), 'dsh-peer-e2e-'));
const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-peer-home-'));
test.after(() => rm(workspace, { recursive: true, force: true }));
test.after(() => rm(harnessHome, { recursive: true, force: true }));

/** A stand-in task runner that echoes the prompt it received. */
const RUNNER = join(workspace, 'runner.mjs');
await writeFile(
  RUNNER,
  `process.stdout.write(JSON.stringify({ seen: process.argv.slice(2), cwd: process.cwd() }));\n`,
  'utf8',
);

/** Launch the real entry point and wait for its listening line. */
async function startRealAdapter() {
  const child = spawn(process.execPath, [join(projectRoot, 'src', 'bin.js')], {
    cwd: workspace,
    env: {
      ...process.env,
      DSH_PEER_KEY: KEY,
      DSH_PEER_PORT: '0',
      DSH_PEER_ALLOWED_DIRS: workspace,
      DSH_PEER_COMMAND: `${process.execPath} ${RUNNER}`,
      DSH_HOME: harnessHome,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const banner = await new Promise((resolve, reject) => {
    let collected = '';
    const timer = setTimeout(() => reject(new Error(`adapter never listened: ${collected}`)), 20_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      collected += chunk;
      const match = /listening on (http:\/\/\S+)/u.exec(collected);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`adapter exited early with ${String(code)}: ${collected}`));
    });
  });

  return { child, url: `${banner.replace(/\/$/u, '')}/mcp` };
}

test('a peer drives the real Adapter end to end', async () => {
  const { child, url } = await startRealAdapter();
  const client = new Client({ name: 'peer', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${KEY}` } },
  });

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        'ask',
        'cancel_task',
        'close_read',
        'fetch_file',
        'open_read',
        'read_chunk',
        'send_begin',
        'send_cancel',
        'send_chunk',
        'send_file',
        'send_finish',
        'submit_task',
        'task_events',
        'task_result',
        'task_status',
      ],
    );

    const asked = await client.callTool({
      name: 'ask',
      arguments: { prompt: 'what is in this workspace', cwd: workspace },
    });
    const raw = asked.content.map((part) => part.text).join('\n');
    const answer = JSON.parse(raw);
    assert.equal(answer.ok, true, `raw answer was: ${raw}`);
    assert.equal(answer.exitCode, 0);
    // The answer is the runner's stdout verbatim: the Adapter forwards text, it
    // does not interpret it, because the real runner is a DSH agent, not a script.
    const seen = JSON.parse(answer.answer);
    assert.deepEqual(seen.seen, ['what is in this workspace']);
    assert.equal(answer.exitCode, 0);

    // A file produced by the task can be fetched and staged, which is the whole
    // point of the channel: the peer reads what this machine made.
    await writeFile(join(workspace, 'artifact.txt'), 'produced here\n', 'utf8');
    const fetched = await client.callTool({
      name: 'fetch_file',
      arguments: { path: join(workspace, 'artifact.txt') },
    });
    const payload = JSON.parse(fetched.content.map((part) => part.text).join('\n'));
    assert.equal(Buffer.from(payload.content, 'base64').toString('utf8'), 'produced here\n');

    const staged = await client.callTool({ name: 'send_file', arguments: payload });
    const receipt = JSON.parse(staged.content.map((part) => part.text).join('\n'));
    assert.ok(
      receipt.path.startsWith(join(harnessHome, 'dsh-peer', 'incoming')),
      `staged files must land in the harness home, got ${receipt.path}`,
    );
    assert.equal(await readFile(receipt.path, 'utf8'), 'produced here\n');
  } finally {
    await client.close().catch(() => {});
    child.kill('SIGKILL');
  }
});

test('the real Adapter refuses a peer that has the wrong key', async () => {
  const { child, url } = await startRealAdapter();
  const client = new Client({ name: 'intruder', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${randomBytes(32).toString('base64url')}` } },
  });

  try {
    await assert.rejects(async () => {
      await client.connect(transport);
    });
  } finally {
    await client.close().catch(() => {});
    child.kill('SIGKILL');
  }
});

test('the entry point refuses to start without a shared key', async () => {
  const child = spawn(process.execPath, [join(projectRoot, 'src', 'bin.js')], {
    cwd: workspace,
    env: { ...process.env, DSH_PEER_KEY: '', DSH_PEER_PORT: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on('close', resolve));

  assert.notEqual(code, 0);
  assert.match(stderr, /shared key/u);
});
