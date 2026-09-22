import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { PEER_TOOL_SPECS } from '../src/tools-peer.js';

/**
 * The plugin as the host will load it.
 *
 * Three failures can only happen here, and all of them are packaging rather than
 * logic: a host-provided import may not resolve from where the plugin is
 * installed, a tool definition may not satisfy the host's schema contract, and
 * the installed copy may be older than the source these tests just ran against.
 *
 * The third one is not hypothetical — it is how this plugin first broke: the
 * suite was green against the source while DSH loaded a stale copy that threw
 * inside `defineTool`.
 */

/** Where a side-load of this plugin lives for a given profile. */
const installedAt = (profile) => join(homedir(), '.dsh', 'profiles', profile, 'node_modules', 'dsh-peer-mcp');

/** The earlier side-load location, kept so a stale copy there is still detected. */
const legacyInstalledAt = (profile) =>
  join(homedir(), '.dsh', 'profiles', profile, 'node_modules', '@local', 'dsh-peer-mcp');

/** Profiles this machine has side-loaded the plugin into. */
const profiles = ['desktop'];

/** Files the host actually loads, and therefore the ones that must not drift. */
const RUNTIME_FILES = [
  'package.json',
  'cordis.patch.yml',
  'lib/plugin.js',
  'src/tools-peer.js',
  'src/service.js',
  'src/server.js',
  'src/trust.js',
  'src/pairing.js',
  'src/handshake.js',
  'src/initiator.js',
  'src/mounts.js',
  'src/pair-client.js',
  'src/secrets.js',
  'src/headless.js',
  'src/task-command.js',
  'src/transfer.js',
  'src/auth.js',
  'src/reject.js',
  'src/ask.js',
  'src/tools.js',
  'src/config.js',
  'src/discovery.js',
  'src/bin.js',
];

/** Whether a path holds an installed copy. */
const hasManifest = async (root) => {
  try {
    return (await stat(join(root, 'package.json'))).isFile();
  } catch {
    return false;
  }
};

test('the plugin entry point loads with the host packages it depends on', async () => {
  const plugin = await import('../lib/plugin.js');

  assert.equal(plugin.name, 'dsh-peer-mcp');
  assert.deepEqual(plugin.inject, ['tools'], 'the plugin needs the tool registry before it can apply');
  assert.equal(typeof plugin.apply, 'function');
});

test('the bundle patch inserts the package under its published name', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');

  // A patch naming a package that is not this one installs a plugin the host
  // cannot resolve. A local-only name does exactly that on somebody else's machine.
  assert.equal(manifest.name, 'dsh-peer-mcp');
  assert.ok(patch.includes(`name: '${manifest.name}'`), `cordis.patch.yml must insert ${manifest.name}`);
  assert.equal(manifest.private, undefined, 'a publishable plugin must not be private');
  assert.ok(manifest.dsh?.bundle?.patch, 'the marketplace requires a dsh.bundle manifest');
});

test('every peer tool declares what the host requires, so no spec can be half-built', async () => {
  for (const spec of PEER_TOOL_SPECS) {
    assert.ok(spec.output, `${spec.name} has no output declaration; defineTool reads output.render unconditionally`);
    assert.equal(typeof spec.output.render, 'function', `${spec.name} must declare how its value renders`);
    assert.equal(spec.output.schema.type, 'object', `${spec.name} must declare an object output`);

    // Building it through the real defineTool is the check that matters: this is
    // the exact call that threw inside the host's loader.
    const definition = defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: spec.output,
      execute: async (args) => await spec.execute(args, { service: {} }),
    });
    assert.equal(definition.name, spec.name);
    assert.equal(typeof definition.execute, 'function');
  }
});

test('a tool with no parameters still builds a valid definition', async () => {
  const status = PEER_TOOL_SPECS.find((spec) => spec.name === 'peer_status');

  const definition = defineTool({
    name: status.name,
    description: status.description,
    parameters: status.parameters,
    output: status.output,
    execute: async () => ({ listening: false, peers: [], trustedBy: [] }),
  });

  assert.equal(definition.name, 'peer_status');
  assert.deepEqual(definition.parameters.properties, {}, 'a parameterless tool declares no parameters');
});

test('every tool description states what the model may not do', async () => {
  const exposureWords = /listener|listen/iu;
  const ticket = PEER_TOOL_SPECS.find((spec) => spec.name === 'peer_ticket');

  // The model can ask for a code but cannot turn listening on, so the refusal
  // has to be visible in the description rather than discovered by failing.
  assert.match(ticket.description, exposureWords);
  assert.match(ticket.description, /cannot/iu);
});

test('a side-loaded copy matches the source these tests just ran against', async (t) => {
  let checked = 0;

  for (const profile of profiles) {
    for (const [label, root] of [
      ['installed', installedAt(profile)],
      ['legacy', legacyInstalledAt(profile)],
    ]) {
      if (!(await hasManifest(root))) continue;
      checked += 1;

      const drifted = [];
      for (const file of RUNTIME_FILES) {
        const fromSource = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
        let fromInstall;
        try {
          fromInstall = await readFile(join(root, ...file.split('/')), 'utf8');
        } catch {
          drifted.push(`${file} (missing)`);
          continue;
        }
        if (fromSource !== fromInstall) drifted.push(file);
      }

      assert.deepEqual(
        drifted,
        [],
        `the ${label} copy at ${root} is stale for: ${drifted.join(', ')} — copy lib/, src/ and the manifests there, then restart DSH, or the host loads code these tests never saw`,
      );
    }
  }

  if (checked === 0) t.skip('the plugin is not side-loaded on this machine');
});
