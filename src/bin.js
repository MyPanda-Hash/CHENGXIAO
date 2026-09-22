#!/usr/bin/env node
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { createAuth } from './auth.js';
import { DEFAULT_COMMAND, readConfig } from './config.js';
import { discoverWindowsCommand } from './discovery.js';
import { createHeadlessExecutor } from './headless.js';
import { startAdapter } from './server.js';

/**
 * Start one standalone Adapter from the environment.
 *
 * Startup checks happen before the listener opens: a peer should never be told a
 * task is running on a machine whose task runner cannot start.
 */

const EXECUTABLE_SUFFIXES = ['', '.exe', '.cmd'];

/**
 * Resolve an executable the way a shell would, without invoking one.
 *
 * @param {string} command - executable name or path.
 * @returns {string | undefined} the resolved path when found.
 */
function resolveExecutable(command) {
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .filter((dir) => dir !== '')
        .flatMap((dir) => EXECUTABLE_SUFFIXES.map((suffix) => join(dir, `${command}${suffix}`)));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
}

/**
 * Whether a path is a Windows shell shim, which Node refuses to spawn directly.
 *
 * @param {string} path - resolved executable path.
 * @returns {boolean} true when the path must be replaced before it can run.
 */
const isShim = (path) => process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(path);

/**
 * Resolve a command template to something that can actually be spawned.
 *
 * The naive answer — take what the operator configured and run it — fails on
 * Windows, where `dsh` is a `.cmd` shim. So a shim is resolved to the real
 * executable it wraps, and a shim that cannot be resolved stops startup rather
 * than opening a listener that can never run a task.
 *
 * @param {string[]} command - the configured command template.
 * @returns {{ command: string[], env: Record<string, string> }} the runnable template.
 */
function resolveTaskCommand(command) {
  const executable = resolveExecutable(command[0]);
  if (executable === undefined) {
    process.stderr.write(
      `dsh-peer-mcp: cannot find "${command[0]}" on PATH; set DSH_PEER_COMMAND to an absolute path that exists.\n`,
    );
    process.exit(1);
  }

  if (!isShim(executable)) {
    return { command: [executable, ...command.slice(1)], env: {} };
  }

  const discovered = discoverWindowsCommand(executable);
  if (discovered === undefined) {
    process.stderr.write(
      `dsh-peer-mcp: DSH_PEER_COMMAND names a Windows shim (${executable}) that cannot be started without a shell, ` +
        'and its real executable could not be located. Set DSH_PEER_COMMAND to the real executable, e.g.\n' +
        '  "C:\\Path\\to\\DSH Desktop.exe" --expose-internals "C:\\Path\\to\\resources\\app\\lib\\desktop-cli.js" --profile headless\n' +
        'and provide ELECTRON_RUN_AS_NODE=1 in the task environment.\n',
    );
    process.exit(1);
  }

  process.stderr.write(
    `dsh-peer-mcp: resolved the configured shim to the real executable:\n  ${discovered.command.join(' ')}\n`,
  );
  return discovered;
}

// The `dsh` on this machine's PATH is what a default configuration means; when
// it is a shim, discovering the real command up front makes the default usable.
const shimOnPath = process.platform === 'win32' ? resolveExecutable(DEFAULT_COMMAND[0]) : undefined;
const discovered = shimOnPath === undefined ? undefined : discoverWindowsCommand(shimOnPath);
const platformDefaults =
  discovered === undefined
    ? {}
    : { windowsCommand: discovered.command, windowsEnv: discovered.env };

const rawConfig = readConfig(process.env, process.cwd(), platformDefaults);
const auth = createAuth({
  key: rawConfig.key,
  insecure: process.env.DSH_PEER_INSECURE === '1',
});

// Whatever the source — an explicit DSH_PEER_COMMAND or the discovered default —
// the template has to come out spawnable before the listener opens.
const resolved = resolveTaskCommand(rawConfig.command);
const config = {
  ...rawConfig,
  command: resolved.command,
  commandEnv: { ...rawConfig.commandEnv, ...resolved.env },
};

const executor = createHeadlessExecutor({
  command: config.command,
  timeoutMs: config.timeoutMs,
  env: config.commandEnv,
});

const adapter = await startAdapter({
  auth,
  executor,
  stagingDir: config.stagingDir,
  allowedDirs: config.allowedDirs,
  defaultCwd: config.defaultCwd,
  host: config.host,
  port: config.port,
  ...(config.maxBytes !== undefined && { maxBytes: config.maxBytes }),
  log: (line) => process.stderr.write(`dsh-peer-mcp: ${line}\n`),
});

process.stderr.write(
  [
    `dsh-peer-mcp: listening on ${adapter.url}`,
    `dsh-peer-mcp: allowed directories: ${config.allowedDirs.join(', ')}`,
    `dsh-peer-mcp: staging: ${config.stagingDir}`,
    `dsh-peer-mcp: task command: ${config.command.join(' ')} <prompt>`,
    Object.keys(config.commandEnv).length > 0
      ? `dsh-peer-mcp: task environment: ${Object.keys(config.commandEnv).join(', ')}`
      : '',
    auth.insecure ? 'dsh-peer-mcp: WARNING insecure mode is on — anyone who can reach this port can run tasks here' : '',
  ]
    .filter((line) => line !== '')
    .join('\n') + '\n',
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    adapter.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
