import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Runs one peer task as a real DSH process on this machine.
 *
 * The configured command is a template — typically
 * `dsh --profile headless` — and the prompt is appended as a single argument.
 * Nothing here goes through a shell, so a prompt containing `&`, `|`, or
 * quotes is data, never syntax.
 */

/** Default ceiling for one peer task; a Headless run is a whole agent turn, not a shell command. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Grace period between the kill signal and giving up on the child, so a stuck process cannot pin the Adapter. */
const KILL_GRACE_MS = 5_000;

/**
 * Whether this executable is a Windows shell shim that cannot be spawned safely.
 *
 * @param {string} executable - resolved executable path or name.
 * @returns {boolean} true when the command must be reconfigured.
 */
function isShellShimUnsupported(executable) {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(executable);
}

/**
 * Turn a `dsh` shim path into the real command that replaces it.
 *
 * A rejection that says only "cannot run dsh.cmd" sends the operator looking for
 * a missing install, when the launcher was in fact found and only needs to be
 * named differently. This spells out the replacement, derived from the shim's
 * own location so it is correct for this machine.
 *
 * @param {string} shim - the offending `.cmd` path.
 * @returns {string} a ready-to-use command template.
 */
function describeRealExecutable(shim) {
  // <install>\host-commands\desktop\generations\<hash>\bin\dsh.cmd
  const binDir = dirname(shim);
  const installRoot = resolve(binDir, '..', '..', '..', '..', '..');
  const exe = join(installRoot, 'DSH Desktop.exe');
  const cli = join(installRoot, 'resources', 'app', 'lib', 'desktop-cli.js');
  if (existsSync(exe) && existsSync(cli)) {
    return `"${exe}" --expose-internals "${cli}" --profile headless`;
  }
  return `"${shim}" --profile headless  (this machine's layout was not recognised; point it at the real executable)`;
}

/**
 * Build an executor over a Headless-style command template.
 *
 * The prompt is always handed over as one argument to a real executable. On
 * Windows that rules out `dsh.cmd`: Node refuses to spawn a `.cmd` without a
 * shell, and going through `cmd.exe` would make the prompt shell syntax. Name
 * the real executable instead (see the README's Windows command).
 *
 * @param {{ command: string[], timeoutMs?: number, env?: Record<string, string> }} options - command template, limits, and extra child environment.
 * @returns {{ ask: (request: { prompt: string, cwd: string }) => Promise<{ answer: string, stderr: string, exitCode: number | null, timedOut: boolean }> }} the executor.
 */
export function createHeadlessExecutor({ command, timeoutMs = DEFAULT_TIMEOUT_MS, env = {} }) {
  if (!Array.isArray(command) || command.length === 0) {
    throw new TypeError('dsh-peer-mcp: command must be a non-empty argument array');
  }
  const [executable, ...templateArgs] = command;

  return {
    async ask({ prompt, cwd }) {
      return await new Promise((resolve) => {
        if (isShellShimUnsupported(executable)) {
          resolve({
            answer: '',
            stderr:
              `dsh-peer-mcp: refusing ${executable}: a Windows .cmd/.bat cannot be started without a shell, ` +
              'and a shell would turn the task text into commands. The launcher was found — this is a command ' +
              'configuration problem, not a missing install. Replace it with the real executable, keeping the ' +
              'arguments already in use:\n' +
              `  ${describeRealExecutable(executable)}\n` +
              'and set ELECTRON_RUN_AS_NODE=1 in the task environment.',
            exitCode: null,
            timedOut: false,
          });
          return;
        }

        let child;
        try {
          child = spawn(executable, [...templateArgs, prompt], {
            cwd,
            shell: false,
            windowsHide: true,
            env: { ...process.env, ...env },
          });
        } catch (cause) {
          resolve({
            answer: '',
            stderr: `dsh-peer-mcp: cannot start ${executable}: ${cause.message}`,
            exitCode: null,
            timedOut: false,
          });
          return;
        }

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
          setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
        }, timeoutMs);
        timer.unref();

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });

        const settle = (exitCode) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            answer: stdout.replace(/\s+$/u, ''),
            stderr: stderr.trim(),
            exitCode,
            timedOut,
          });
        };

        child.on('error', (cause) => {
          // A spawn failure means the task never ran, so say which layer failed
          // and what to change. "ENOENT" alone leaves the operator guessing
          // between a missing PATH entry and a missing install.
          stderr +=
            cause?.code === 'ENOENT'
              ? `dsh-peer-mcp: no such executable: ${executable}. The task never started. ` +
                'Set DSH_PEER_COMMAND (or the plugin config `command`) to an absolute path that exists on this machine.'
              : `dsh-peer-mcp: ${cause?.code ?? cause?.name}: ${cause?.message}`;
          settle(null);
        });
        child.on('close', (code) => settle(timedOut ? null : code));
      });
    },
  };
}
