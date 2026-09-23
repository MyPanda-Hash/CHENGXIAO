import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';

/**
 * The browser half, loaded the way the Web UI loads it.
 *
 * `client.js` is plain CommonJS with no build step, and until this file existed
 * nothing had ever executed it — a syntax error or a wrong export shape would
 * have shown up as a settings page that simply never appears, with no error a
 * user could act on.
 *
 * React is stubbed rather than loaded for real: this checks the plugin's own
 * wiring (exports, slot registration, element tree), not React's behaviour.
 */

/** A minimal React stand-in that records the element tree. */
const makeReactStub = () => {
  const calls = [];
  return {
    calls,
    createElement(type, props, ...children) {
      calls.push({ type: typeof type === 'string' ? type : (type?.name ?? 'component'), props: props ?? {} });
      return { type, props: props ?? {}, children };
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
  };
};

/** Load client.js with `require` intercepted, returning the module and the stub. */
const loadClient = () => {
  const react = makeReactStub();
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'react') return react;
    return original.call(this, request, parent, isMain);
  };

  const require = createRequire(import.meta.url);
  const path = require.resolve('../client.cjs');
  delete require.cache[path];
  try {
    return { client: require('../client.cjs'), react };
  } finally {
    Module._load = original;
  }
};

test('the client module loads and exports the shape the Web UI expects', () => {
  const { client } = loadClient();

  assert.equal(typeof client.apply, 'function', 'the UI calls apply(ctx)');
  assert.ok(Array.isArray(client.inject), 'inject must be an array');
  assert.ok(client.inject.includes('slots'), 'a settings section needs the slot registry');
});

test('applying registers exactly one settings section under this plugin id', () => {
  const { client } = loadClient();
  const injections = [];
  const registered = [];

  const ctx = {
    slots: {
      inject(name, factory) {
        injections.push({ name, factory });
        return () => {};
      },
      register(spec, render) {
        registered.push({ spec, render });
        return () => {};
      },
    },
    locale: { bind: () => (key) => key, register: () => {} },
  };

  client.apply(ctx);

  assert.equal(injections.length, 1);
  assert.equal(injections[0].name, 'settings.section', 'the page must land in the settings surface');

  // The factory is what actually registers, and it runs when the host needs it.
  injections[0].factory();
  assert.equal(registered.length, 1);
  assert.equal(registered[0].spec.id, 'dsh-peer-mcp', 'a stable id keeps the section addressable');
  assert.equal(typeof registered[0].spec.label, 'function');
  assert.equal(typeof registered[0].render, 'function');
});

test('the section label is a name an operator recognises', () => {
  const { client } = loadClient();
  const injected = [];
  const ctx = {
    slots: {
      inject: (name, factory) => injected.push(factory),
      register: (spec) => {
        ctx.registered = spec;
        return () => {};
      },
    },
    locale: { bind: () => (key) => key, register: () => {} },
  };

  client.apply(ctx);
  injected[0]();

  const label = ctx.registered.label();
  assert.equal(typeof label, 'string');
  assert.ok(label.length > 0 && label.length <= 12, `a nav label must be short, got ${JSON.stringify(label)}`);
});

test('rendering before data arrives shows a loading state rather than crashing', () => {
  const { client, react } = loadClient();
  const injected = [];
  let render;
  const ctx = {
    slots: {
      inject: (name, factory) => injected.push(factory),
      register: (_spec, fn) => {
        render = fn;
        return () => {};
      },
    },
    locale: { bind: () => (key) => key, register: () => {} },
  };

  client.apply(ctx);
  injected[0]();

  // status starts as null, so the first render must not touch it.
  const before = react.calls.length;
  assert.doesNotThrow(() => render({}));
  assert.ok(react.calls.length > before, 'the component must render something');
});
