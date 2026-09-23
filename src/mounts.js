/**
 * Mounting paired workers as tools.
 *
 * Mounting is what makes pairing useful: the MCP client joins the running
 * plugin, and the peer's tools (`mcp__<name>__ask`, …) become visible to the
 * model. The bookkeeping matters more than the call:
 *
 * - **One client per peer.** A second mount would publish duplicate tool names.
 * - **Re-pairing replaces, never stacks.** The old client must be disposed, or a
 *   stale credential stays connected to the worker after it was rotated.
 * - **An unreadable credential is never mounted.** Better a reported failure
 *   than a client that silently cannot authenticate.
 *
 * Both field bugs in this seam came from guessing the Cordis contract, so it is
 * spelled out here: mounting is `ctx.plugin(moduleNamespace, config)`, and what
 * that resolves to is a **fiber**, whose disposal is `fiber.dispose()` — not a
 * function to call. `test/mount-contract.test.js` checks both against real
 * Cordis.
 */

/** Path the peer serves its MCP endpoint on. */
const MCP_PATH = '/mcp';

/**
 * Turn whatever a mount returned into something callable once.
 *
 * Cordis resolves `ctx.plugin` to a fiber; a hand-rolled mount may return a bare
 * disposer. Accepting both keeps the service honest about the real shape without
 * making every caller care.
 *
 * @param {unknown} mounted - the value the mount produced.
 * @returns {() => void} a callable disposer.
 */
function disposerOf(mounted) {
  if (typeof mounted === 'function') return mounted;
  if (typeof mounted?.dispose === 'function') return () => mounted.dispose();
  throw new TypeError('dsh-peer-mcp: a mounted peer returned no way to dispose it');
}

/**
 * Compose a mount disposer with a relay endpoint release, so unmounting a
 * relay peer takes its loopback proxy down with it.
 *
 * @param {() => void} dispose - the mount's own disposer.
 * @param {() => Promise<void>} release - the relay endpoint release.
 * @returns {() => void} the composed disposer.
 */
function composeDisposers(dispose, release) {
  return () => {
    dispose();
    void release().catch(() => {});
  };
}

/**
 * Create the peer mount manager for one plugin instance.
 *
 * Clients are keyed by peer **name**, not by record id: re-pairing replaces the
 * stored record — and therefore its id — while the name is what stays stable
 * and what the tool names are derived from. Keying by id would leave the
 * superseded client connected forever, holding a credential that was rotated.
 *
 * A peer paired through a relay is mounted the same way — same MCP client,
 * same credential header — except its URL is a loopback proxy that carries
 * the traffic across the relay. `relayEndpointFor` is what opens that proxy;
 * without it relay peers cannot mount, because dialing their recorded
 * address directly would miss the relay hop entirely.
 *
 * @param {{
 *   ctx: { plugin: (module: object, config: object) => Promise<unknown>, effect: (setup: () => (() => void) | void) => void },
 *   store: { listPeers: () => object[], identify: (name: string) => object | undefined },
 *   mcp: object,
 *   relayEndpointFor?: (name: string) => Promise<{ url: string, authorization: string, close: () => Promise<void> }>,
 *   toolCallTimeoutMs?: number,
 * }} deps - the plugin context, the initiator store, the MCP client module, and an optional relay endpoint factory.
 * @returns {{
 *   mountAll: () => Promise<{ mounted: string[], alreadyMounted: string[], failed: object[] }>,
 *   unmount: (nameOrId: string) => Promise<void>,
 * }} the manager.
 */
export function createPeerMounts({ ctx, store, mcp, relayEndpointFor, toolCallTimeoutMs }) {
  /** Peer name → its disposer. Presence here is what "mounted" means. */
  const live = new Map();

  const disposeAll = () => {
    const disposers = [...live.values()];
    live.clear();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // A failing disposer must not block the others during unload.
      }
    }
  };

  // Registered once, so unloading the plugin takes the peers with it.
  ctx.effect(() => disposeAll);

  return {
    async mountAll() {
      const mounted = [];
      const alreadyMounted = [];
      const failed = [];

      for (const peer of store.listPeers()) {
        if (live.has(peer.name)) {
          alreadyMounted.push(peer.name);
          continue;
        }

        let withCredential;
        try {
          withCredential = store.identify(peer.name);
        } catch (cause) {
          failed.push({ name: peer.name, code: cause?.code ?? 'credential-unreadable' });
          continue;
        }
        if (withCredential === undefined) {
          failed.push({ name: peer.name, code: 'peer-unknown' });
          continue;
        }

        // A relay peer mounts against a loopback proxy that hides the relay
        // hop; a direct peer mounts against its recorded address.
        let url = `http://${peer.address}${MCP_PATH}`;
        let headers = { authorization: `Bearer ${withCredential.credential}` };
        let releaseRelay;
        if (withCredential.relay !== undefined) {
          if (relayEndpointFor === undefined) {
            failed.push({ name: peer.name, code: 'relay-mount-unavailable' });
            continue;
          }
          try {
            const endpoint = await relayEndpointFor(peer.name);
            url = endpoint.url;
            headers = { authorization: endpoint.authorization };
            releaseRelay = endpoint.close;
          } catch (cause) {
            failed.push({ name: peer.name, code: typeof cause?.code === 'string' ? cause.code : 'relay-mount-failed' });
            continue;
          }
        }

        // The module namespace is the first argument; there is no `plugin`
        // property on the MCP client module to call.
        const mountedPeer = await ctx.plugin(mcp, {
          transport: 'streamable-http',
          serverName: peer.name,
          url,
          headers,
          // An ask may legitimately run for as long as the worker's task
          // timeout allows, while the client library's own default cap is one
          // minute. Without this, a task that outlives the cap is reported as
          // a timeout to the caller while still running — and may succeed,
          // which the caller never learns.
          ...(toolCallTimeoutMs !== undefined && { toolCallTimeoutMs }),
        });

        const dispose = disposerOf(mountedPeer);
        live.set(peer.name, releaseRelay !== undefined ? composeDisposers(dispose, releaseRelay) : dispose);
        mounted.push(peer.name);
      }

      return { mounted, alreadyMounted, failed };
    },

    async unmount(nameOrId) {
      const direct = live.get(nameOrId);
      if (direct !== undefined) {
        live.delete(nameOrId);
        direct();
        return;
      }

      // A caller holding only a record id still needs to unmount, so resolve the
      // name through the store rather than assuming the id is the key.
      const named = store.listPeers().find((peer) => peer.id === nameOrId);
      if (named === undefined) return;
      const dispose = live.get(named.name);
      if (dispose === undefined) return;
      live.delete(named.name);
      dispose();
    },
  };
}
