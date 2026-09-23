import { hostname, homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createPeerService } from '../src/service.js';
import { PEER_TOOL_SPECS } from '../src/tools-peer.js';

/**
 * The Cordis face of the plugin.
 *
 * This file is deliberately thin: all behaviour lives in `src/`, where it is
 * testable without a Cordis context. What happens here is wiring — read the
 * configuration, build the service, register the four agent-facing tools, and
 * publish the service so the settings surface can drive pairing.
 *
 * Note what is *not* here: no tool can start the inbound listener. Exposure is a
 * configuration decision, and the model may only report it.
 */

/** Stable Cordis plugin name. */
export const name = 'dsh-peer-mcp';

/** Services required before this plugin can apply. */
export const inject = ['tools'];

/** Host commands this plugin needs before it can run peer tasks. */
const REQUIRED_DSH_COMMAND = ['dsh', '--profile', 'headless'];

/** Addresses the listener may bind. A public interface name would be a surprise, not a feature. */
const ALLOWED_HOSTS = ['127.0.0.1', '0.0.0.0', 'localhost'];

/** Default harness home, matching what DSH itself uses. */
const defaultHome = () => process.env.DSH_HOME ?? join(homedir(), '.dsh');

/**
 * Configuration schema, as a Standard Schema validator.
 *
 * The host passes a plugin's patch config through verbatim when the plugin
 * declares no schema, so a typo would only surface at runtime — and here one
 * specific typo is dangerous: `listen: "false"` is a string, strings are truthy,
 * and the machine would open a network listener because a YAML value was quoted.
 * Declaring the schema turns that into a load-time failure.
 *
 * An allowlist is required whenever listening is on: a listener with nothing to
 * confine it would hand a peer the whole machine.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-peer-mcp',
    validate(input) {
      const raw = typeof input === 'object' && input !== null ? input : {};
      const issues = [];
      const value = {};

      const boolean = (field, fallback) => {
        if (raw[field] === undefined) {
          value[field] = fallback;
          return;
        }
        if (typeof raw[field] !== 'boolean') {
          issues.push({ message: `${field} must be true or false, got ${JSON.stringify(raw[field])}` });
          return;
        }
        value[field] = raw[field];
      };

      const positiveInteger = (field, fallback) => {
        if (raw[field] === undefined) {
          value[field] = fallback;
          return;
        }
        const candidate = raw[field];
        if (!Number.isInteger(candidate) || candidate < 0) {
          issues.push({ message: `${field} must be a non-negative integer, got ${JSON.stringify(candidate)}` });
          return;
        }
        value[field] = candidate;
      };

      if (raw.home === undefined) value.home = defaultHome();
      else if (typeof raw.home !== 'string' || raw.home === '') issues.push({ message: 'home must be a path' });
      else value.home = raw.home;

      if (raw.deviceName === undefined) value.deviceName = hostname();
      else if (typeof raw.deviceName !== 'string' || raw.deviceName.trim() === '') {
        issues.push({ message: 'deviceName must be a non-empty name' });
      } else value.deviceName = raw.deviceName.trim();

      boolean('listen', false);

      if (raw.host === undefined) value.host = '0.0.0.0';
      else if (!ALLOWED_HOSTS.includes(raw.host)) {
        issues.push({ message: `host must be one of ${ALLOWED_HOSTS.join(', ')}, got ${JSON.stringify(raw.host)}` });
      } else value.host = raw.host;

      positiveInteger('port', 7331);
      if (value.port !== undefined && value.port > 65535) {
        issues.push({ message: `port must be at most 65535, got ${String(value.port)}` });
      }

      positiveInteger('taskTimeoutMs', 600000);

      if (raw.maxBytes !== undefined) {
        const candidate = raw.maxBytes;
        if (!Number.isInteger(candidate) || candidate <= 0) {
          issues.push({ message: `maxBytes must be a positive integer, got ${JSON.stringify(candidate)}` });
        } else value.maxBytes = candidate;
      }

      if (raw.allowedDirs === undefined) {
        value.allowedDirs = [];
      } else if (!Array.isArray(raw.allowedDirs)) {
        issues.push({ message: 'allowedDirs must be a list of absolute paths' });
      } else if (raw.allowedDirs.some((dir) => typeof dir !== 'string' || !isAbsolute(dir))) {
        issues.push({ message: 'every allowedDirs entry must be an absolute path' });
      } else value.allowedDirs = [...raw.allowedDirs];

      if (value.listen === true && (value.allowedDirs ?? []).length === 0) {
        issues.push({
          message: 'allowedDirs must name at least one absolute directory when listen is true',
        });
      }

      if (raw.command !== undefined) {
        if (!Array.isArray(raw.command) || raw.command.length === 0 || raw.command.some((part) => typeof part !== 'string')) {
          issues.push({ message: 'command must be a non-empty list of strings' });
        } else value.command = [...raw.command];
      }

      if (raw.addresses !== undefined) {
        if (!Array.isArray(raw.addresses) || raw.addresses.some((entry) => typeof entry !== 'string')) {
          issues.push({ message: 'addresses must be a list of strings' });
        } else value.addresses = [...raw.addresses];
      }

      if (issues.length > 0) return { issues };
      return { value };
    },
  },
};

/**
 * Apply the plugin.
 *
 * @param {object} ctx - the Cordis context (with `tools` injected).
 * @param {object} config - resolved configuration.
 * @returns {Promise<void>} resolves once the service is up and tools are registered.
 */
export async function apply(ctx, config) {
  const log = (line) => ctx.logger('dsh-peer-mcp').info(line);
  const { createHeadlessExecutor } = await import('../src/headless.js');
  const { resolveTaskCommand } = await import('../src/task-command.js');

  // The default command is `dsh --profile headless`, and on Windows `dsh` is a
  // `.cmd` shim that Node refuses to spawn. Resolving it here — rather than at
  // task time — is what makes the plugin work out of the box on Windows. When it
  // cannot be resolved the plugin still loads, and only `ask` reports why, so a
  // file-transfer peer stays usable.
  const resolved = resolveTaskCommand(config.command ?? REQUIRED_DSH_COMMAND);
  if (resolved.ok) {
    log(`task command: ${resolved.command.join(' ')}`);
  } else {
    log(`task command is not runnable (${resolved.code}): ${resolved.detail}`);
  }

  const executor = resolved.ok
    ? createHeadlessExecutor({
        command: resolved.command,
        ...(config.taskTimeoutMs !== undefined && { timeoutMs: config.taskTimeoutMs }),
        env: resolved.env,
      })
    : {
        async ask() {
          return { answer: '', stderr: `dsh-peer-mcp: ${resolved.detail}`, exitCode: null, timedOut: false };
        },
      };

  const service = await createPeerService({
    home: config.home,
    deviceName: config.deviceName,
    executor,
    listen: config.listen,
    host: config.host,
    port: config.port,
    allowedDirs: config.allowedDirs,
    ...(config.maxBytes !== undefined && { maxBytes: config.maxBytes }),
    // The MCP client and this context are what turn a paired worker into tools.
    mcp: McpClient,
    mountContext: ctx,
    ...(config.addresses !== undefined && { addresses: config.addresses }),
    log,
  });

  ctx.effect(() => () => {
    void service.stop();
  });

  for (const spec of PEER_TOOL_SPECS) {
    ctx.tools.register(
      defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        // `defineTool` reads `output.render` unconditionally, so a spec without
        // an output declaration throws inside the host's loader rather than
        // failing softly. That is exactly how this plugin first broke: one
        // spec gained its output block and the other three did not.
        output: spec.output,
        execute: async (args) => await spec.execute(args, { service }),
      }),
    );
  }

  // Published for the settings surface, which needs the same service to issue
  // codes, mount peers and revoke them without going through the model.
  ctx.provide('peerService', service);

  // The settings page's data routes. Registered on the Web UI carrier, so they
  // live on the page's own origin and the browser can call them same-origin.
  //
  // `ctx.get` rather than `ctx.webServer`: the carrier is read without becoming
  // a hard dependency, so this plugin still loads in a profile that has no Web
  // UI. Requiring it would take the whole plugin down there — including the
  // peer tools, which have nothing to do with the page.
  const webServer = ctx.get('webServer');
  if (webServer !== undefined) {
    const { registerSettingsRoutes } = await import('../src/settings-routes.js');
    const routes = registerSettingsRoutes({ ctx: { webServer }, service, log });
    ctx.effect(() => () => routes.dispose());
  } else {
    log('settings page unavailable: this profile has no Web UI carrier');
  }

  log(`peer service ready (listening=${String(service.status().listening)})`);
}
