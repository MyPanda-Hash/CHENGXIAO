import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createAuth, MIN_KEY_CHARS } from './auth.js';

/**
 * Environment configuration for one Adapter process.
 *
 * Defaults here are deliberately timid: loopback only, files limited to the
 * directory the Adapter was started in, and no key means no service. Widening
 * any of that is an explicit act.
 */

/** Default port, chosen to be memorable and unlikely to collide with the Desktop UI. */
export const DEFAULT_PORT = 7331;

/** Default task template: the DSH on PATH, one Headless task per call. */
export const DEFAULT_COMMAND = ['dsh', '--profile', 'headless'];

/**
 * The official public relay: enabling the relay without naming one routes
 * through here, so a fresh install needs no infrastructure of its own. It is
 * a plain forwarder of end-to-end-encrypted envelopes - it holds no keys and
 * persists nothing (see README for the self-hosted alternative).
 */
export const OFFICIAL_RELAY_URL = 'http://8.134.255.221:7332';

/** Return the isolated collaboration workspace below a user's home directory. */
export function defaultWorkspace(home, platform = process.platform) {
  const pathJoin = platform === 'win32' || /^[A-Za-z]:[\\\\]/u.test(home) ? joinWindows : join;
  return pathJoin(home, 'DSH Workspace');
}

function joinWindows(home, child) {
  return home.replace(/[\\\\/]+$/u, '') + '\\' + child;
}

/** Error with a stable `code` for configuration mistakes. */
class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

/**
 * Read one Adapter configuration from an environment.
 *
 * @param {Record<string, string | undefined>} env - environment variables.
 * @param {string} cwd - directory the Adapter was started in, used as the default allowlist.
 * @param {{ windowsCommand?: string[], windowsEnv?: Record<string, string> }} [platformDefaults] - launch details the caller discovered for this platform.
 * @returns {{
 *   host: string, port: number, key: string, allowedDirs: string[], defaultCwd: string,
 *   stagingDir: string, command: string[], commandEnv: Record<string, string>,
 *   timeoutMs: number, maxBytes?: number,
 * }} the resolved configuration.
 * @throws {ConfigError} on a configuration that would be unsafe or unusable.
 */
export function readConfig(env, cwd, platformDefaults = {}) {
  // Constructing the verifier here keeps the "no key, no service" rule in one place.
  createAuth({ key: env.DSH_PEER_KEY, insecure: env.DSH_PEER_INSECURE === '1' });

  const port = parsePort(env.DSH_PEER_PORT);
  const dshHome = env.DSH_HOME ?? join(homedir(), '.dsh');
  const allowedDirs = parseAllowedDirs(env.DSH_PEER_ALLOWED_DIRS, cwd);
  const overridden = env.DSH_PEER_COMMAND !== undefined && env.DSH_PEER_COMMAND.trim() !== '';

  return {
    host: env.DSH_PEER_HOST ?? '127.0.0.1',
    port,
    key: env.DSH_PEER_KEY ?? '',
    allowedDirs,
    defaultCwd: cwd,
    stagingDir: join(dshHome, 'dsh-peer', 'incoming'),
    command: parseCommand(env.DSH_PEER_COMMAND, platformDefaults.windowsCommand),
    // Only the discovered platform default carries launch environment; an
    // operator-supplied command is taken exactly as written.
    commandEnv: overridden ? {} : (platformDefaults.windowsEnv ?? {}),
    timeoutMs: parsePositiveInt(env.DSH_PEER_TIMEOUT_MS, 10 * 60 * 1000, 'timeout-invalid'),
    // The relay: absent unless configured, so the safe default is no relay.
    ...(parseRelayUrl(env.DSH_PEER_RELAY_URL) !== undefined && { relayUrl: parseRelayUrl(env.DSH_PEER_RELAY_URL) }),
    ...(env.DSH_PEER_RELAY_DEVICE_ID !== undefined &&
      env.DSH_PEER_RELAY_DEVICE_ID.trim() !== '' && { relayDeviceId: env.DSH_PEER_RELAY_DEVICE_ID.trim() }),
    ...(env.DSH_PEER_MAX_BYTES !== undefined && {
      maxBytes: parsePositiveInt(env.DSH_PEER_MAX_BYTES, 0, 'max-bytes-invalid'),
    }),
  };
}

/**
 * Parse the relay URL, normalising to an origin.
 *
 * @param {string | undefined} raw - the configured relay origin.
 * @returns {string | undefined} the normalised origin, or undefined when unset or unusable.
 */
function parseRelayUrl(raw) {
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return undefined;
  }
}

/**
 * Parse the listen port.
 *
 * @param {string | undefined} raw - configured value.
 * @returns {number} the port.
 * @throws {ConfigError} when the value is not a usable port number.
 */
function parsePort(raw) {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  if (!/^\d+$/u.test(raw)) {
    throw new ConfigError('port-invalid', `dsh-peer-mcp: DSH_PEER_PORT must be a number, got ${JSON.stringify(raw)}`);
  }
  const port = Number(raw);
  if (port > 65535) {
    throw new ConfigError('port-invalid', `dsh-peer-mcp: DSH_PEER_PORT must be at most 65535, got ${raw}`);
  }
  return port;
}

/**
 * Parse a positive integer setting.
 *
 * @param {string | undefined} raw - configured value.
 * @param {number} fallback - value to use when unset.
 * @param {string} code - error code to report.
 * @returns {number} the parsed value.
 * @throws {ConfigError} when the value is present but not a positive integer.
 */
function parsePositiveInt(raw, fallback, code) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/u.test(raw) || Number(raw) === 0) {
    throw new ConfigError(code, `dsh-peer-mcp: expected a positive integer, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

/**
 * Parse the allowlist, defaulting to the startup directory.
 *
 * @param {string | undefined} raw - semicolon-separated directories.
 * @param {string} cwd - fallback directory.
 * @returns {string[]} allowed directories, trimmed and without empties.
 */
function parseAllowedDirs(raw, cwd) {
  if (raw === undefined || raw.trim() === '') return [cwd];
  return raw
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Parse the task command template.
 *
 * Splits on whitespace but honours double quotes, because a real command names
 * an executable under `Program Files` and splitting that on spaces would break it.
 *
 * @param {string | undefined} raw - command template from the environment.
 * @param {string[] | undefined} platformDefault - launch command the caller discovered for this platform.
 * @returns {string[]} executable followed by its arguments.
 * @throws {ConfigError} when the template is present but empty.
 */
function parseCommand(raw, platformDefault) {
  if (raw === undefined || raw.trim() === '') return [...(platformDefault ?? DEFAULT_COMMAND)];
  const parts = splitCommandLine(raw);
  if (parts.length === 0) {
    throw new ConfigError('command-invalid', 'dsh-peer-mcp: DSH_PEER_COMMAND must name an executable');
  }
  return parts;
}

/**
 * Split a command line into tokens, treating double quotes as grouping.
 *
 * @param {string} text - the command line.
 * @returns {string[]} tokens, without the quote characters.
 */
function splitCommandLine(text) {
  const tokens = [];
  let current = '';
  let quoted = false;
  let started = false;

  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/u.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** Re-exported so the CLI can report the rule without importing the auth module twice. */
export { MIN_KEY_CHARS };
