import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Finding the real DSH executable behind the `dsh` command.
 *
 * On Windows `dsh` on PATH is a `.cmd` shim. Node refuses to spawn a `.cmd`
 * without a shell (CVE-2024-27980), and going through `cmd.exe` makes the task
 * text into shell syntax — so a task containing `&` would run two commands.
 * The fix is to launch the executable the shim itself launches.
 *
 * The shim names that executable, but its CLI path may be stale: this machine's
 * shim points at `resources\app.asar\...` while the installation ships an
 * unpacked `resources\app` directory. Both layouts are therefore tried, and a
 * shim resolving to neither is refused rather than guessed.
 *
 * Walking up from the shim's own directory cannot work: DSH Desktop puts the
 * shim under `%APPDATA%` while the installation can live on another drive.
 */

/** CLI script inside an unpacked installation. */
const UNPACKED_CLI = ['resources', 'app', 'lib', 'desktop-cli.js'];

/** CLI script inside a packed installation. */
const PACKED_CLI = ['resources', 'app.asar', 'lib', 'desktop-cli.js'];

/** Matches the `"<path>\DSH Desktop.exe"` token a DSH Desktop shim names. */
const SHIM_EXE = /"([^"]*DSH Desktop\.exe)"/iu;

/**
 * Resolve the real launch command behind a `dsh` entry point.
 *
 * @param {string} resolvedShim - absolute path of the `dsh` entry point found on PATH.
 * @returns {{ command: string[], env: Record<string, string> } | undefined} launch details, or undefined when this is not a usable DSH Desktop install.
 */
export function discoverWindowsCommand(resolvedShim) {
  if (typeof resolvedShim !== 'string' || resolvedShim === '') return undefined;

  let text;
  try {
    text = readFileSync(resolvedShim, 'utf8');
  } catch {
    return undefined;
  }

  const named = SHIM_EXE.exec(text);
  const executable = named?.[1];
  if (executable === undefined || !existsSync(executable)) return undefined;

  const installRoot = dirname(executable);
  for (const segments of [UNPACKED_CLI, PACKED_CLI]) {
    const cli = join(installRoot, ...segments);
    if (!existsSync(cli)) continue;

    return {
      command: [executable, '--expose-internals', cli, '--profile', 'headless'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DSH_HOME: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
      },
    };
  }

  return undefined;
}
