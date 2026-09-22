import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { discoverWindowsCommand } from './discovery.js';

/**
 * Turning a configured command template into something that can actually run.
 *
 * This seam is shared by both entry points — the plugin inside DSH and the
 * standalone Adapter — because both need the same answer, and the first version
 * of this code only gave it to one of them. The plugin therefore shipped with a
 * default command that could never work on Windows, while the standalone entry
 * point resolved it correctly.
 *
 * The problem being solved: `dsh` on Windows is a `.cmd` shim, and Node refuses
 * to spawn a `.cmd` without a shell (CVE-2024-27980) — while a shell would turn
 * the task text into commands. The shim's own text names the real executable, so
 * a shim is resolved rather than rejected.
 */

/** Extensions a bare command name is tried with, in order. */
const EXECUTABLE_SUFFIXES = ['', '.exe', '.cmd'];

/**
 * Resolve an executable the way a shell would, without invoking one.
 *
 * @param {string} command - executable name or path.
 * @param {{ platform?: string, pathValue?: string }} [options] - injectable platform and PATH for tests.
 * @returns {string | undefined} the resolved path when found.
 */
export function resolveExecutable(command, { platform = process.platform, pathValue } = {}) {
  const suffixes = platform === 'win32' ? EXECUTABLE_SUFFIXES : [''];
  const path = pathValue ?? process.env.PATH ?? '';

  const candidates = isAbsolute(command)
    ? [command]
    : path
        .split(delimiter)
        .filter((dir) => dir !== '')
        .flatMap((dir) => suffixes.map((suffix) => join(dir, `${command}${suffix}`)));

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
 * Whether a path is a Windows shell shim, which cannot be spawned directly.
 *
 * @param {string} path - a resolved executable path.
 * @returns {boolean} true when the path must be replaced before it can run.
 */
export const isShellShim = (path) => /\.(?:cmd|bat)$/iu.test(path);

/**
 * Resolve a task command template to something spawnable.
 *
 * @param {string[]} command - the configured template, executable first.
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [options] - injectable platform and environment.
 * @returns {{ ok: true, command: string[], env: Record<string, string> } | { ok: false, code: string, detail: string }} the runnable template, or why it cannot be made runnable.
 */
export function resolveTaskCommand(command, { platform = process.platform, env = process.env } = {}) {
  const executable = resolveExecutable(command[0], {
    platform,
    ...(env.PATH !== undefined && { pathValue: env.PATH }),
  });

  if (executable === undefined) {
    return {
      ok: false,
      code: 'command-not-found',
      detail:
        `no such executable: ${command[0]}. Set the task command to an absolute path that exists on this machine ` +
        '(DSH_PEER_COMMAND for the standalone Adapter, or the plugin config `command`).',
    };
  }

  if (platform !== 'win32' || !isShellShim(executable)) {
    return { ok: true, command: [executable, ...command.slice(1)], env: {} };
  }

  const discovered = discoverWindowsCommand(executable);
  if (discovered === undefined) {
    return {
      ok: false,
      code: 'shim-unresolvable',
      detail:
        `the task command names a Windows shim (${executable}) that cannot be started without a shell, ` +
        'and the real executable it wraps could not be located. Point the task command at the real executable, e.g. ' +
        '"C:\\Path\\to\\DSH Desktop.exe" --expose-internals "C:\\Path\\to\\resources\\app\\lib\\desktop-cli.js" --profile headless ' +
        'and set ELECTRON_RUN_AS_NODE=1.',
    };
  }

  return {
    ok: true,
    command: discovered.command,
    env: { ...discovered.env, ...(env.DSH_HOME !== undefined && { DSH_HOME: env.DSH_HOME }) },
  };
}
