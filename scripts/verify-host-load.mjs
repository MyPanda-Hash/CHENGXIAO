/**
 * Load this plugin the way a DSH host does, and report each stage separately.
 *
 * Two details make this different from a plain import check:
 *
 * - It uses a **real Cordis context**, so `ctx.plugin(...)` is exercised for
 *   real. Hand-written fakes are exactly what let two contract bugs through to
 *   the field: a `plugin` property that does not exist on the MCP client module,
 *   and a mount result that is a fiber rather than a callable disposer.
 * - It reports every stage on its own line, so a failure names its cause instead
 *   of surfacing as "cannot read properties of undefined".
 *
 * Usage:
 *   node scripts/verify-host-load.mjs                  # from this checkout
 *   node scripts/verify-host-load.mjs --profile web    # from an installed profile
 *   node scripts/verify-host-load.mjs --listen         # also bind a loopback port
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const listen = argv.includes('--listen');
const profileIndex = argv.indexOf('--profile');
const profile = profileIndex === -1 ? undefined : argv[profileIndex + 1];

const installedRoot =
  profile === undefined
    ? new URL('..', import.meta.url)
    : pathToFileURL(join(homedir(), '.dsh', 'profiles', profile, 'node_modules', 'dsh-peer-mcp') + '/');

console.log(`source     : ${profile === undefined ? 'this checkout' : `profile "${profile}"`}`);
console.log(`entry      : ${new URL('lib/plugin.js', installedRoot).href}`);
console.log(`listen     : ${listen ? 'yes (binds a loopback port)' : 'no'}`);
console.log('');

const fail = (stage, error) => {
  console.log(`    FAILED at ${stage}: ${error.name}: ${error.message}`);
  console.log(String(error.stack).split('\n').slice(1, 6).join('\n'));
  process.exit(1);
};

console.log('--- 1) import the entry point');
let plugin;
try {
  plugin = await import(new URL('lib/plugin.js', installedRoot).href);
} catch (error) {
  fail('import', error);
}
console.log(`    name = ${plugin.name} | inject = ${JSON.stringify(plugin.inject)}`);
console.log(`    exports: ${Object.keys(plugin).join(', ')}`);

console.log('--- 2) validate a realistic config through the plugin schema');
const rawConfig = {
  listen,
  host: listen ? '127.0.0.1' : '0.0.0.0',
  port: listen ? 0 : 7331,
  allowedDirs: [join(homedir(), 'MY PAPER')],
  taskTimeoutMs: 600000,
};
const validated = plugin.Config['~standard'].validate(rawConfig);
if (validated.issues) {
  console.log('    schema issues:', JSON.stringify(validated.issues));
  process.exit(1);
}
console.log('    issues: none');

console.log('--- 3) apply() on a real Cordis context, recording what it registers');
const { Context } = await import('@deepseek-ai/cordis');
const root = new Context();
const registered = [];
const provided = [];
const webRoutes = [];
const webServer = {
  register(spec) {
    webRoutes.push(spec);
    return () => {
      spec.disposed = true;
    };
  },
};

// The settings page needs a Web UI carrier. `apply` reads it with `ctx.get`, so
// leaving it out here would silently skip the settings path — the one part of
// this plugin that otherwise needs a restart to be checked at all.
root.provide('webServer', webServer);

const ctx = {
  ...root,
  tools: { register: (tool) => registered.push(tool) },
  effect: (setup) => root.effect(setup),
  provide: (key, value) => provided.push([key, value]),
  logger: () => ({ info: () => {}, error: () => {} }),
  plugin: root.plugin.bind(root),
  get: root.get.bind(root),
};

try {
  await plugin.apply(ctx, validated.value);
} catch (error) {
  fail('apply', error);
}
console.log('    apply() returned cleanly');
console.log(`    provided: ${provided.map(([key]) => key).join(', ') || '(none)'}`);
console.log(`    settings routes: ${webRoutes.map((route) => route.path).join(', ') || '(none)'}`);

console.log('--- 4) tools');
for (const tool of registered) {
  const parameters = Object.keys(tool.parameters?.properties ?? {}).length;
  console.log(`    ${tool.name}: parameters=${parameters} render=${typeof tool.output?.render}`);
}

console.log('--- 5) the service the plugin published');
const service = provided.find(([key]) => key === 'peerService')?.[1];
if (service === undefined) {
  console.log('    FAILED: no peerService was provided');
  process.exit(1);
}
const status = service.status();
console.log(`    listening = ${status.listening}`);
console.log(`    address   = ${status.address ?? '(none)'}`);
console.log(`    peers     = ${status.peers.length} | trustedBy = ${status.trustedBy.length}`);

console.log('--- 6) tear down (must not throw on real fibers)');
try {
  await service.stop();
} catch (error) {
  fail('service.stop', error);
}
console.log('    stopped cleanly');
console.log('');
console.log('OK: the plugin loads, applies, registers and tears down.');
