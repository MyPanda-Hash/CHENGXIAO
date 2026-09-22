import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../lib/plugin.js';

/**
 * Plugin configuration, validated at load time.
 *
 * The host hands a plugin its patch config verbatim when the plugin declares no
 * schema, which means a typo reaches `apply` and is discovered at runtime. For
 * this plugin that is not good enough: `listen: "false"` — a string — is truthy,
 * and a machine would open a network listener because a YAML value was quoted.
 * The schema exists so that mistake stops the load instead.
 */

const validate = (input) => Config['~standard'].validate(input);

/** The issue messages a failed validation produced. */
const issuesOf = (input) => validate(input).issues?.map((issue) => issue.message) ?? [];

test('a minimal config is accepted, with the safe default applied', async () => {
  const result = validate({});

  assert.equal(result.issues, undefined);
  assert.equal(result.value.listen, false, 'a machine must never listen unless it is told to');
  assert.equal(result.value.port, 7331);
  assert.equal(result.value.taskTimeoutMs, 600000);
});

test('a string is refused where a boolean belongs', async () => {
  const issues = issuesOf({ listen: 'false' });

  assert.equal(issues.length, 1);
  assert.match(issues[0], /listen/iu);
});

test('a configuration that would listen without an allowlist is refused', async () => {
  const issues = issuesOf({ listen: true });

  assert.equal(issues.length, 1);
  assert.match(issues[0], /allowedDirs/iu, 'listening with no allowlist would expose the whole machine');
});

test('an allowlist entry must be an absolute path', async () => {
  const issues = issuesOf({ listen: true, allowedDirs: ['relative/path'] });

  // Two real problems at once: the entry is not absolute, so nothing usable was
  // actually allowed either. Both are reported rather than the first alone.
  assert.equal(issues.length, 2, issues.join(' | '));
  assert.ok(
    issues.some((issue) => /absolute/iu.test(issue)),
    `expected an absoluteness complaint, got: ${issues.join(' | ')}`,
  );
});

test('a wildcard host is accepted, and an unknown one is refused', async () => {
  assert.equal(validate({ listen: true, allowedDirs: ['C:\\work'], host: '0.0.0.0' }).issues, undefined);

  const issues = issuesOf({ host: 'example.com' });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /host/iu);
});

test('a port outside the usable range is refused', async () => {
  assert.equal(issuesOf({ port: 70000 }).length, 1);
  assert.equal(issuesOf({ port: -1 }).length, 1);
  assert.equal(issuesOf({ port: 'abc' }).length, 1);
  assert.equal(validate({ port: 0 }).issues, undefined, 'port 0 means "let the system choose"');
});

test('a command template must name an executable', async () => {
  assert.equal(validate({ command: ['dsh', '--profile', 'headless'] }).issues, undefined);

  const issues = issuesOf({ command: [] });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /command/iu);
});

test('every problem is reported at once, not one per restart', async () => {
  const issues = issuesOf({ listen: 'yes', port: 99999, allowedDirs: 'C:\\work', host: 'nope' });

  assert.equal(issues.length, 4, `expected four issues, got: ${issues.join(' | ')}`);
});

test('the schema is a standard-schema validator, which is what the host requires', async () => {
  assert.equal(Config['~standard'].version, 1);
  assert.equal(typeof Config['~standard'].validate, 'function');
  assert.equal(
    'then' in validate({}),
    false,
    'the host rejects asynchronous config validation outright',
  );
});
