import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The browser half, loaded the way the Web UI loads it.
 *
 * The Web UI does not import this file. It serves it to the page as a classic
 * script whose only job is to call `window.__ModuleLoader__.load({ id, factory })`
 * and hand back a CommonJS-shaped module. Getting that wrong produces no error a
 * user can act on — the bundle loads, registers nothing, and the whole plugin
 * tree fails to import. That is exactly what happened when this file was first
 * written as a plain CommonJS export, and why this suite now runs the real file
 * against a real `window.__ModuleLoader__` instead of trusting a shape.
 *
 * React is stubbed: this checks the plugin's own wiring, not React's behaviour.
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

/**
 * Execute client.js with a stub module loader, returning what it registered.
 *
 * @returns {Promise<{ registrations: object[], react: object }>} the recorded registrations and the React stub.
 */
async function loadClientModule() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const react = makeReactStub();
  const registrations = [];

  const windowStub = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration);
      },
    },
  };

  // The file is written against browser globals; give it exactly those.
  const run = new Function('window', 'module', 'exports', 'require', `${source}\n//# sourceURL=client.js`);
  run(windowStub, { exports: {} }, {}, (name) => {
    if (name === 'react') return react;
    throw new Error(`the client must not require ${name}`);
  });

  return { registrations, react };
}

/** Materialize the registered module, refusing anything but react. */
const moduleOf = (registrations, react) =>
  registrations[0].factory((name) => {
    if (name === 'react') return react ?? makeReactStub();
    throw new Error(`the page cannot resolve ${name}`);
  });

test('the file registers itself through __ModuleLoader__ exactly once', async () => {
  const { registrations } = await loadClientModule();

  assert.equal(registrations.length, 1, 'executing the file must register one module, not zero and not two');
  assert.equal(typeof registrations[0].factory, 'function', 'the loader calls factory(require)');
});

test('the module id matches the plugin, because the loader compares them', async () => {
  const { registrations } = await loadClientModule();

  assert.equal(
    registrations[0].id,
    'dsh-peer-mcp',
    'a mismatched id is what the loader reports as "loaded without registering"',
  );
});

test('the factory returns a module exporting apply and inject', async () => {
  const { registrations, react } = await loadClientModule();
  const exported = moduleOf(registrations, react);

  assert.equal(typeof exported.apply, 'function', 'the UI calls apply(ctx)');
  assert.ok(Array.isArray(exported.inject), 'inject must be an array');
  assert.ok(exported.inject.includes('slots'), 'a settings section needs the slot registry');
});

test('applying registers one settings section under this plugin id', async () => {
  const { registrations, react } = await loadClientModule();
  const exported = moduleOf(registrations, react);

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

  exported.apply(ctx);

  assert.equal(injections.length, 1);
  assert.equal(injections[0].name, 'settings.section', 'the page must land in the settings surface');

  // The factory is what registers, and it runs when the host needs it.
  injections[0].factory();
  assert.equal(registered.length, 1);
  assert.equal(registered[0].spec.id, 'dsh-peer-mcp', 'a stable id keeps the section addressable');
  assert.equal(typeof registered[0].render, 'function');
});

test('the section label is short enough for a nav entry', async () => {
  const { registrations, react } = await loadClientModule();
  const exported = moduleOf(registrations, react);

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

  exported.apply(ctx);
  injected[0]();

  const label = ctx.registered.label();
  assert.equal(typeof label, 'string');
  assert.ok(label.length > 0 && label.length <= 12, `a nav label must be short, got ${JSON.stringify(label)}`);
});

test('rendering before any status arrives shows a loading state rather than crashing', async () => {
  const { registrations, react } = await loadClientModule();
  const exported = moduleOf(registrations, react);

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

  exported.apply(ctx);
  injected[0]();

  // Status starts as null, so the first render must not touch it.
  const before = react.calls.length;
  assert.doesNotThrow(() => render({}));
  assert.ok(react.calls.length > before, 'the component must render something');
});

test('the client requires nothing the page module table cannot provide', async () => {
  const { registrations } = await loadClientModule();
  const asked = [];

  registrations[0].factory((name) => {
    asked.push(name);
    if (name === 'react') return makeReactStub();
    throw new Error(`the page cannot resolve ${name}`);
  });

  // Only `react`: anything else would be a dependency the page has no way to
  // satisfy at runtime.
  assert.deepEqual([...new Set(asked)], ['react'], `the client required: ${asked.join(', ')}`);
});
