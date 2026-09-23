/**
 * Build a clean release tree for this plugin.
 *
 * The checkout carries development-only material — tests, captured fixtures, the
 * junction directory that wires dependencies in for local runs. None of it should
 * reach a user's profile, and a stray `node_modules` is the worst of it: it
 * shadows the host's own resolution, so an installed copy would silently use a
 * different set of packages than the host intended.
 *
 * Usage: node scripts/prepare-release.mjs [outputDirectory]
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const output = process.argv[2] ?? join(projectRoot, 'dist', 'release');

/** Everything an installed plugin needs, and nothing else. */
const SHIPPED = ['lib', 'src', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE', 'package.json'];

/** Directories that must never be copied, whatever else happens. */
const FORBIDDEN = ['node_modules', 'test', 'scripts', '.git'];

/**
 * Copy one entry from the checkout into the release tree.
 *
 * @param {string} name - entry name at the repository root.
 * @param {string} destination - release directory.
 * @returns {Promise<void>} resolves when the entry is in place.
 */
async function copyShipped(name, destination) {
  const from = join(projectRoot, name);
  const to = join(destination, name);
  await cp(from, to, {
    recursive: true,
    filter: (source) => !FORBIDDEN.includes(relative(projectRoot, source).split(/[\\/]/u)[0]),
  });
}

const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const name of SHIPPED) {
  await copyShipped(name, output);
}

// A release that names the wrong package would install a plugin the host cannot
// load, so the manifest and the bundle patch have to agree before anything ships.
const patch = await readFile(join(output, 'cordis.patch.yml'), 'utf8');
if (!patch.includes(`name: '${manifest.name}'`)) {
  throw new Error(
    `cordis.patch.yml does not insert ${manifest.name}; fix the patch before releasing`,
  );
}

const entries = await (async () => {
  const { readdir } = await import('node:fs/promises');
  return await readdir(output);
})();

await writeFile(
  join(output, '..', 'release-manifest.json'),
  `${JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      entries: entries.sort(),
      verified: {
        patchNamesPackage: true,
        shipsNoNodeModules: !entries.includes('node_modules'),
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`release tree : ${output}`);
console.log(`package      : ${manifest.name}@${manifest.version}`);
console.log(`entries      : ${entries.sort().join(', ')}`);
for (const forbidden of FORBIDDEN) {
  if (entries.includes(forbidden)) throw new Error(`release tree must not contain ${forbidden}`);
}
console.log(`verified     : patch names the package, no ${FORBIDDEN.join(' / ')}`);
console.log(`(root was ${dirname(output)})`);
