import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { openTrustStore } from './trust.js';
import { openPairingStore } from './pairing.js';
import { openInitiatorStore } from './initiator.js';
import { pairWith, parsePairLink, PAIR_TIMEOUT_MS } from './pair-client.js';
import { createVerifier } from './auth.js';
import { createPeerMounts } from './mounts.js';
import { createPairThrottle, handlePair } from './handshake.js';
import { startAdapter } from './server.js';
import { createRelayClient } from './relay/client.js';
import { createRelayProxy } from './relay/proxy.js';
import { generateKeyPair, deriveSessionKey, seal, open, encodeKey, parseKey } from './relay/crypto.js';
import { defaultWorkspace } from './config.js';

export const DEFAULT_CAPABILITIES = Object.freeze({
  readWorkspace: true,
  writeWorkspace: true,
  runTask: true,
  transferFiles: true,
  runSystemCommand: false,
  accessOutsideWorkspace: false,
  modifyDshConfig: false,
});

export function normalizeCapabilities(input = {}) {
  return Object.freeze({
    ...DEFAULT_CAPABILITIES,
    readWorkspace: input.readWorkspace === false ? false : true,
    writeWorkspace: input.writeWorkspace === false ? false : true,
    runTask: input.runTask === false ? false : true,
    transferFiles: input.transferFiles === false ? false : true,
    runSystemCommand: false,
    accessOutsideWorkspace: false,
    modifyDshConfig: false,
  });
}

/**
 * One machine's peer service, in both roles at once.
 *
 * A machine may hand out work *and* drive someone else's, so this module owns
 * both directions and keeps them independent:
 *
 * - **Inbound** is opt-in. The listener is the only surface a stranger can
 *   reach, so it stays off until the operator turns it on, and a machine with
 *   no listener still refuses to issue a pairing code rather than hand out an
 *   address nobody can reach.
 * - **Outbound** needs no listener at all, which is what lets a laptop drive a
 *   server without opening anything on itself.
 */

/** Stable error with a `code`. */
class ServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

/**
 * Interface names that belong to a hypervisor or container layer rather than to
 * the network a peer is actually on.
 */
const VIRTUAL_INTERFACE = /wsl|vmware|virtualbox|hyper-v|vethernet|docker|loopback|tailscale|zerotier/iu;

/** Addresses in these ranges belong to a real local network. */
const PRIVATE_IPV4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u;

/**
 * Addresses this machine can be reached at from the local network.
 *
 * Loopback is excluded: handing a peer `127.0.0.1` would name the peer's own
 * machine, and a pairing code that points at the wrong machine is worse than no
 * code at all. IPv4 only, because that is what the rest of the Adapter speaks.
 *
 * @param {{ networkInterfacesImpl?: typeof networkInterfaces }} [options] - injectable interface listing.
 * @returns {string[]} candidate IPv4 addresses, in interface order.
 */
export function lanAddresses({ networkInterfacesImpl = networkInterfaces } = {}) {
  const found = [];
  for (const entries of Object.values(networkInterfacesImpl() ?? {})) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal === true) continue;
      if (!found.includes(entry.address)) found.push(entry.address);
    }
  }
  return found;
}

/**
 * Pick the address to put in a pairing link.
 *
 * The choice is what makes a code usable: a listener bound to loopback must
 * advertise loopback, and a listener on every interface must prefer the address
 * a peer is most likely to reach. Virtual adapters (WSL, VMware, Hyper-V) are
 * common on developer machines and are usually unreachable from another
 * machine, so a real private-network address wins over them — while a machine
 * that has nothing else still gets its best available address rather than a
 * refusal.
 *
 * @param {{ bindHost?: string, addresses?: string[], networkInterfacesImpl?: typeof networkInterfaces }} [options] - bind host and address sources.
 * @returns {string} the address to advertise.
 */
export function chooseAdvertisedAddress({ bindHost = '0.0.0.0', addresses, networkInterfacesImpl } = {}) {
  if (bindHost === '127.0.0.1' || bindHost === 'localhost') return '127.0.0.1';

  const candidates = addresses ?? lanAddresses({ ...(networkInterfacesImpl && { networkInterfacesImpl }) });
  if (candidates.length === 0) return '127.0.0.1';

  const names = networkInterfacesImpl === undefined ? networkInterfaces() : networkInterfacesImpl();
  const rank = (address) => {
    const owner = Object.entries(names ?? {}).find(([, entries]) =>
      (entries ?? []).some((entry) => entry.address === address),
    )?.[0];
    const virtual = owner !== undefined && VIRTUAL_INTERFACE.test(owner);
    if (virtual) return 2;
    return PRIVATE_IPV4.test(address) ? 0 : 1;
  };

  return [...candidates].sort((left, right) => rank(left) - rank(right))[0];
}

/**
 * Create the peer service for one harness home.
 *
 * @param {{
 *   home: string,
 *   deviceName: string,
 *   executor: { ask: (input: object) => Promise<object> },
 *   listen?: boolean,
 *   host?: string,
 *   port?: number,
 *   allowedDirs?: string[],
 *   maxBytes?: number,
 *   mcp?: object,
 *   mountContext?: object,
 *   toolCallTimeoutMs?: number,
 *   addresses?: string[],
 *   log?: (line: string) => void,
 * }} options - service wiring.
 * @returns {Promise<{
 *   status: () => object,
 *   createTicket: (input?: object) => Promise<object>,
 *   pair: (input: { link: string }) => Promise<object>,
 *   credentialFor: (name: string) => string,
 *   mountPeers: () => Promise<object>,
 *   revoke: (id: string) => Promise<object>,
 *   forget: (id: string) => Promise<void>,
 *   stop: () => Promise<void>,
 * }>} the service.
 */
export async function createPeerService({
  home,
  deviceName,
  executor,
  listen = false,
  host = '0.0.0.0',
  port = 0,
  allowedDirs,
  maxBytes,
  mcp,
  mountContext,
  toolCallTimeoutMs,
  addresses,
  relay,
  log = () => {},
}) {
  const trust = await openTrustStore({ home });
  const pairing = await openPairingStore({ home });
  const initiator = await openInitiatorStore({ home, deviceName });
  let workspacePath = allowedDirs?.[0] ?? defaultWorkspace(home);
  let workspaceSource = allowedDirs?.[0] === undefined ? 'default' : 'configured';
  let capabilities = normalizeCapabilities();

  let adapter;
  let advertised;
  let pending;

  // One throttle for both ingress paths (direct HTTP and relay), so failure
  // counts accumulate across them instead of resetting per path.
  const throttle = createPairThrottle();

  // The relay connection: an outbound client that makes this machine reachable
  // without opening any inbound port. Registration happens during service
  // creation so a relay that cannot be reached fails loudly, not silently.
  let relayClient;
  let relayHostPort;
  let relayDeviceId;
  if (relay?.enabled === true) {
    relayDeviceId = relay.deviceId ?? trust.identity.installId;
    relayHostPort = new URL(relay.url).host;
    relayClient = createRelayClient({ url: relay.url, deviceId: relayDeviceId });
    try {
      await relayClient.register();
    } catch (cause) {
      await relayClient.stop().catch(() => {});
      throw new ServiceError(
        cause.code ?? 'relay-unreachable',
        `cannot register with the relay at ${relay.url}: ${cause.message}`,
      );
    }
    relayClient.onMessage((envelope) => void handleRelayEnvelope(envelope));
    log(`relay registered: ${relay.url} as ${relayDeviceId}`);
  }

  /**
   * Answer one inbound relay envelope. Only pair-requests exist in this
   * phase; the worker side of the handshake runs the same handlePair logic
   * the direct HTTP path uses, then seals the answer so the relay never sees
   * the credential inside it.
   *
   * @param {object} envelope - the relay envelope.
   * @returns {Promise<void>}
   */
  async function handleRelayEnvelope(envelope) {
    if (envelope.kind === 'http-request') {
      await handleRelayHttpRequest(envelope);
      return;
    }
    if (envelope.kind !== 'pair-request') return;
    const respond = async (responseBody) => {
      try {
        await relayClient.send({ to: envelope.from, from: relayDeviceId, kind: 'response', id: envelope.id, body: responseBody });
      } catch (cause) {
        log(`relay pair response failed: ${cause?.message ?? String(cause)}`);
      }
    };

    const body = envelope.body ?? {};
    if (typeof body?.e2ePublicKey !== 'string' || body.e2ePublicKey === '') {
      await respond({ status: 400, error: 'e2e-key-missing' });
      return;
    }

    let peerPublic;
    try {
      peerPublic = parseKey(body.e2ePublicKey);
    } catch {
      await respond({ status: 400, error: 'e2e-key-missing' });
      return;
    }

    // An ephemeral key pair per request: the handshake key seals this one
    // answer, the channel key seals every later relay message with this peer.
    const ephemeral = generateKeyPair();
    const handshakeKey = deriveSessionKey({ privateKey: ephemeral.privateKey, peerPublicKey: peerPublic });
    const channelKey = deriveSessionKey({ privateKey: ephemeral.privateKey, peerPublicKey: peerPublic, domain: 'channel' });

    const answer = await handlePair({
      body: { code: body.code, name: body.name, publicKey: body.publicKey },
      address: `${relayHostPort}/${relayDeviceId}`,
      source: envelope.from,
      trust,
      pairing,
      throttle,
      peerFields: { channelKey: channelKey.toString('base64url'), relayDeviceId: envelope.from },
    });

    await respond({
      status: answer.status,
      e2ePublicKey: encodeKey(ephemeral.publicKey),
      sealed: seal({ key: handshakeKey, plaintext: JSON.stringify(answer.body) }),
    });
  }

  /**
   * Replay one sealed HTTP request against this machine's own loopback
   * adapter, and seal the answer back.
   *
   * The channel key comes from the paired peer the request claims to be, so an
   * unpaired or revoked device gets nothing opened — and the relay forwards
   * ciphertext only, credentials included. Replaying against the real adapter
   * means the relay path exercises the same auth, policy and tool dispatch as
   * the direct path, with nothing reimplemented here.
   *
   * @param {object} envelope - the http-request envelope.
   * @returns {Promise<void>}
   */
  async function handleRelayHttpRequest(envelope) {
    const respond = async (responseBody) => {
      try {
        await relayClient.send({ to: envelope.from, from: relayDeviceId, kind: 'response', id: envelope.id, body: responseBody });
      } catch (cause) {
        log(`relay http response failed: ${cause?.message ?? String(cause)}`);
      }
    };

    const peer = trust
      .listPeers()
      .find((entry) => entry.relayDeviceId === envelope.from && entry.revokedAt === undefined);
    if (peer?.channelKey === undefined) {
      await respond({ error: 'peer-unknown-relay' });
      return;
    }

    const body = envelope.body ?? {};
    if (typeof body.sealed !== 'string') {
      await respond({ error: 'request-unopenable' });
      return;
    }
    const channelKey = parseKey(peer.channelKey);
    const opened = open({ key: channelKey, sealed: body.sealed });
    if (opened === undefined) {
      await respond({ error: 'request-unopenable' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(opened);
    } catch {
      await respond({ error: 'request-unopenable' });
      return;
    }

    try {
      const replay = await fetch(`${replayOrigin()}${String(body.path ?? '/')}`, {
        method: String(body.method ?? 'GET'),
        headers: payload.headers ?? {},
        ...(payload.bodyBase64 !== undefined &&
          payload.bodyBase64 !== '' && { body: Buffer.from(payload.bodyBase64, 'base64') }),
      });
      // A fetch Headers instance has no own enumerable properties; spreading
      // it yields {}, which would strip the content-type the MCP client checks.
      const responseHeaders = Object.fromEntries(replay.headers);
      delete responseHeaders['transfer-encoding'];
      delete responseHeaders['content-length'];
      const responseBuffer = Buffer.from(await replay.arrayBuffer());

      await respond({
        status: replay.status,
        sealed: seal({
          key: channelKey,
          plaintext: JSON.stringify({
            status: replay.status,
            headers: responseHeaders,
            bodyBase64: responseBuffer.toString('base64'),
          }),
        }),
      });
    } catch (cause) {
      log(`relay replay failed: ${cause?.message ?? String(cause)}`);
      await respond({ error: 'replay-failed' });
    }
  }

  /**
   * Claim one dshr:// pairing link through the relay it names.
   *
   * The handshake is one request/response exchange over the relay. The pairing
   * answer — which carries the long-lived credential — is sealed with a key
   * derived from an ephemeral X25519 exchange, so the relay forwarding it never
   * holds a usable secret. A durable channel key derived from the same exchange
   * is stored on both sides for sealing later relay traffic.
   *
   * @param {{ relayAddress: string, deviceId: string, code: string, origin: string }} parsed - the link parts.
   * @returns {Promise<{ ok: true, peer: object, worker: object } | { ok: false, code: string, detail: string }>} the outcome.
   */
  async function relayPair(parsed) {
    // Prefer this service's own relay connection; an initiator without one
    // registers an ephemeral client against the relay the link names.
    let client = relayClient;
    let ephemeralClient;
    if (client === undefined) {
      ephemeralClient = createRelayClient({
        url: parsed.origin,
        deviceId: `eph-${randomBytes(9).toString('base64url')}`,
      });
      client = ephemeralClient;
    }

    const keyPair = generateKeyPair();
    let response;
    try {
      try {
        if (ephemeralClient !== undefined) await ephemeralClient.register();
        response = await client.request({
          to: parsed.deviceId,
          kind: 'pair-request',
          body: {
            code: parsed.code,
            name: initiator.identity.deviceName,
            publicKey: initiator.identity.publicKey,
            e2ePublicKey: encodeKey(keyPair.publicKey),
          },
          timeoutMs: PAIR_TIMEOUT_MS,
        });
      } catch (cause) {
        return {
          ok: false,
          code: cause.code === 'relay-request-timeout' ? 'pairing-timeout' : (cause.code ?? 'worker-unreachable'),
          detail: `the relay pairing with ${parsed.relayAddress}/${parsed.deviceId} failed: ${cause.message}`,
        };
      }
    } finally {
      if (ephemeralClient !== undefined) await ephemeralClient.stop().catch(() => {});
    }

    if (response.error !== undefined) {
      return {
        ok: false,
        code: String(response.error),
        detail: 'the worker refused the relay pairing before any key was exchanged',
      };
    }
    if (typeof response.e2ePublicKey !== 'string' || typeof response.sealed !== 'string') {
      return { ok: false, code: 'pair-response-malformed', detail: 'the relay pairing answer was not sealed correctly' };
    }

    const workerPublic = parseKey(response.e2ePublicKey);
    const handshakeKey = deriveSessionKey({ privateKey: keyPair.privateKey, peerPublicKey: workerPublic });
    const opened = open({ key: handshakeKey, sealed: response.sealed });
    if (opened === undefined) {
      return {
        ok: false,
        code: 'pair-response-unopenable',
        detail: 'the sealed pairing answer could not be authenticated',
      };
    }

    let payload;
    try {
      payload = JSON.parse(opened);
    } catch {
      return { ok: false, code: 'pair-response-malformed', detail: 'the sealed pairing answer was not valid JSON' };
    }

    if (response.status !== 201 || payload?.ok !== true) {
      return {
        ok: false,
        code: typeof payload?.code === 'string' ? payload.code : `worker-http-${String(response.status)}`,
        detail: typeof payload?.detail === 'string' ? payload.detail : 'the worker refused this pairing',
      };
    }

    const channelKey = deriveSessionKey({
      privateKey: keyPair.privateKey,
      peerPublicKey: workerPublic,
      domain: 'channel',
    });
    const peer = await initiator.addPeer({
      credential: payload.credential,
      address: `${parsed.relayAddress}/${parsed.deviceId}`,
      name: initiator.identity.deviceName,
      ...(payload.worker?.installId !== undefined && { workerInstallId: payload.worker.installId }),
      relay: { url: parsed.origin, deviceId: parsed.deviceId, channelKey: channelKey.toString('base64url') },
    });

    return { ok: true, peer, worker: payload.worker ?? {} };
  }

  if (listen) {
    adapter = await startAdapter({
      verifier: createVerifier({ trust }),
      executor,
      stagingDir: `${home}/dsh-peer/incoming`,
      allowedDirs: allowedDirs ?? [process.cwd()],
      defaultCwd: process.cwd(),
      ...(maxBytes !== undefined && { maxBytes }),
      host,
      port,
      pairEndpoint: async ({ req, res }) => {
        try {
          const body = await readJsonBody(req);
          // The caller's own address keys the throttle; `address` stays this
          // worker's address, which is what the peer is told to dial back.
          const source = req.socket?.remoteAddress;
          const answer = await handlePair({
            body,
            address: `${advertiseHost()}:${String(adapter.port)}`,
            ...(source !== undefined && { source }),
            trust,
            pairing,
            throttle,
          });
          res.writeHead(answer.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(answer.body));
        } catch (cause) {
          log(`pairing request failed: ${cause?.message ?? String(cause)}`);
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, code: 'claim-malformed' }));
        }
      },
      log,
    });

    const candidates = addresses ?? lanAddresses();
    advertised = chooseAdvertisedAddress({
      bindHost: host,
      ...(addresses !== undefined && { addresses: candidates }),
    });
    if (host !== '127.0.0.1' && host !== 'localhost' && candidates.length === 0) {
      throw new ServiceError(
        'no-lan-address',
        'this machine has no local-network IPv4 address; a peer could not reach it',
      );
    }
  }

  /** The host a peer should dial to reach this listener. */
  function advertiseHost() {
    if (adapter === undefined) throw new ServiceError('listener-off', 'the service is not listening');
    return advertised ?? '127.0.0.1';
  }

  // The relay replay target: a loopback-only adapter that sealed relay
  // requests are replayed against. When the direct listener exists it already
  // serves loopback; otherwise a dedicated one is started, which exposes
  // nothing to the network (127.0.0.1 only).
  let replayAdapter;
  if (relayClient !== undefined && adapter === undefined) {
    replayAdapter = await startAdapter({
      verifier: createVerifier({ trust }),
      executor,
      stagingDir: `${home}/dsh-peer/incoming`,
      allowedDirs: allowedDirs ?? [process.cwd()],
      defaultCwd: process.cwd(),
      ...(maxBytes !== undefined && { maxBytes }),
      host: '127.0.0.1',
      port: 0,
      log,
    });
  }

  /** The loopback base URL relay requests are replayed against. */
  function replayOrigin() {
    const serving = adapter ?? replayAdapter;
    if (serving === undefined) {
      throw new ServiceError('replay-unavailable', 'no adapter is running to replay relay requests against');
    }
    return `http://127.0.0.1:${String(serving.port)}`;
  }

  /** Open relay endpoints by peer name, so repeated mounts share one proxy. */
  const relayEndpoints = new Map();

  /**
   * A loopback HTTP endpoint that drives one relay-paired worker.
   *
   * The host's MCP client only speaks HTTP to a URL, so the relay hop hides
   * behind a loopback proxy: requests are sealed with the pairing-time channel
   * key and carried across the relay, where the worker replays them against
   * its own adapter. One endpoint per peer; closing it releases the proxy.
   *
   * @param {string} name - the paired worker's name.
   * @returns {Promise<{ url: string, authorization: string, close: () => Promise<void> }>} the endpoint.
   */
  async function openRelayEndpoint(name) {
    const existing = relayEndpoints.get(name);
    if (existing !== undefined) return existing;

    const peer = initiator.identify(name);
    if (peer === undefined) throw new ServiceError('worker-unknown', `no paired worker named ${name}`);
    if (peer.relay === undefined || peer.channelKey === undefined) {
      throw new ServiceError('peer-not-relay', `${name} was not paired through a relay`);
    }
    if (relayClient === undefined) {
      throw new ServiceError('relay-off', 'this machine has no relay connection open');
    }

    const endpoint = {
      url: '',
      authorization: `Bearer ${peer.credential}`,
      proxy: undefined,
      async close() {
        if (relayEndpoints.get(name) !== endpoint) return;
        relayEndpoints.delete(name);
        await endpoint.proxy?.close().catch(() => {});
      },
    };
    relayEndpoints.set(name, endpoint);

    const proxy = await createRelayProxy({
      relayClient,
      to: peer.relay.deviceId,
      channelKey: parseKey(peer.channelKey),
      ...(toolCallTimeoutMs !== undefined && { timeoutMs: toolCallTimeoutMs }),
      log,
    });
    endpoint.proxy = proxy;
    endpoint.url = proxy.url;
    return endpoint;
  }

  const mounts =
    mcp === undefined || mountContext === undefined
      ? undefined
      : createPeerMounts({
          ctx: mountContext,
          store: initiator,
          mcp,
          toolCallTimeoutMs,
          ...(relayClient !== undefined && { relayEndpointFor: (name) => openRelayEndpoint(name) }),
        });

  return {
    status() {
      const trustedBy = trust.listPeers();
      const bound = adapter === undefined ? undefined : `${advertiseHost()}:${String(adapter.port)}`;
      return {
        listening: adapter !== undefined,
        // How peers reach this machine: the direct listener wins when both are
        // on, because a LAN hop beats a relay hop; the relay is the fallback
        // that needs no inbound port at all.
        connection: adapter !== undefined ? 'lan' : relayClient !== undefined ? 'relay' : 'off',
        ...(relay !== undefined && {
          relay: { enabled: relay.enabled === true, online: relayClient !== undefined, url: relay.url },
        }),
        ...(adapter !== undefined && { url: `http://${advertiseHost()}:${String(adapter.port)}/mcp` }),
        ...(bound !== undefined && { address: bound }),
        installId: trust.identity.installId,
        deviceName: initiator.identity.deviceName,
        workspace: { path: workspacePath, source: workspaceSource },
        capabilities,
        ...(pending !== undefined && { pending }),
        // Named from this machine's point of view: `peers` are the machines this
        // one may drive, `trustedBy` are the machines allowed to drive this one.
        peers: initiator.listPeers().map((peer) => ({
          id: peer.id,
          name: peer.name,
          address: peer.address,
          pairedAt: peer.pairedAt,
          ...(peer.workerInstallId !== undefined && { workerInstallId: peer.workerInstallId }),
          ...(peer.relay !== undefined && { relay: peer.relay }),
        })),
        trustedBy: trustedBy.map((peer) => ({
          id: peer.id,
          name: peer.name,
          policy: peer.policy,
          pairedAt: peer.pairedAt,
          ...(peer.revokedAt !== undefined && { revokedAt: peer.revokedAt }),
        })),
      };
    },

    configureWorkspace({ path, capabilities: requested } = {}) {
      if (typeof path !== 'string' || path.trim() === '') {
        throw new ServiceError('workspace-path-missing', 'a shared workspace path is required');
      }
      workspacePath = path.trim();
      workspaceSource = 'configured';
      capabilities = normalizeCapabilities(requested);
      return { workspace: { path: workspacePath, source: workspaceSource }, capabilities };
    },

    async createTicket({ policy, ttlMs } = {}) {
      if (adapter === undefined && relayClient === undefined) {
        throw new ServiceError(
          'listener-off',
          'turn the inbound listener or the relay on before issuing a pairing code, or nobody can reach this machine',
        );
      }
      // A direct listener is the better address when it exists; the relay link
      // is what makes a machine behind NAT pairable at all.
      const viaRelay = adapter === undefined;
      const ticket = await pairing.create({
        address: viaRelay ? `${relayHostPort}/${relayDeviceId}` : `${advertiseHost()}:${String(adapter.port)}`,
        scheme: viaRelay ? 'dshr' : 'dshp',
        ...(policy !== undefined && { policy }),
        ...(ttlMs !== undefined && { ttlMs }),
      });
      // The code is returned to the caller once; `pending` keeps only what the
      // status surface may show, so a status read can never leak a live code.
      pending = { id: ticket.id, address: ticket.address, expiresAt: ticket.expiresAt };
      return { ...ticket, code: ticket.code };
    },

    async pair({ link }) {
      const parsed = parsePairLink(link);
      const outcome =
        parsed.scheme === 'dshr'
          ? await relayPair(parsed)
          : await pairWith({
              link: parsed,
              deviceName: initiator.identity.deviceName,
              identity: initiator.identity,
              store: initiator,
            });

      // The handshake and the mount are separate outcomes. Reporting a mount
      // failure as "pairing failed" would be untrue — the other machine already
      // trusts this one, and a retry needs the mount, not a fresh code.
      if (outcome.ok !== true) {
        // The return value reaches only whoever called the tool. Once the
        // operator has moved on and is reading the log to find out what went
        // wrong, an unlogged failure is indistinguishable from no attempt.
        const where = parsed.scheme === 'dshr' ? `${parsed.relayAddress}/${parsed.deviceId}` : parsed.address;
        log(`pairing with ${where} failed: ${outcome.code}`);
        return outcome;
      }
      if (mounts === undefined) {
        return { ...outcome, mounted: false, mountError: { code: 'mounting-unavailable' } };
      }

      try {
        // Re-pairing replaces the credential, so the old client must go first.
        const existing = initiator
          .listPeers()
          .find((peer) => peer.name === initiator.identity.deviceName);
        if (existing !== undefined) await mounts.unmount(existing.id);

        const result = await mounts.mountAll();
        const failed = result.failed.find((entry) => entry.name === initiator.identity.deviceName);
        if (failed !== undefined) return { ...outcome, mounted: false, mountError: failed };
        return { ...outcome, mounted: true };
      } catch (cause) {
        return {
          ...outcome,
          mounted: false,
          mountError: {
            code: typeof cause?.code === 'string' ? cause.code : 'mount-failed',
            detail: String(cause?.message ?? cause),
          },
        };
      }
    },

    credentialFor(name) {
      const peer = initiator.identify(name);
      if (peer === undefined) throw new ServiceError('worker-unknown', `no paired worker named ${name}`);
      return peer.credential;
    },

    openRelayEndpoint,

    async mountPeers() {
      if (mounts === undefined) {
        return { mounted: [], alreadyMounted: [], failed: [], code: 'mounting-unavailable' };
      }
      return await mounts.mountAll();
    },

    async revoke(id) {
      return await trust.revokePeer(id);
    },

    async forget(id) {
      if (mounts !== undefined) await mounts.unmount(id);
      await initiator.removePeer(id);
    },

    async stop() {
      if (adapter !== undefined) await adapter.close();
      if (replayAdapter !== undefined) await replayAdapter.close();
      for (const endpoint of relayEndpoints.values()) await endpoint.proxy?.close().catch(() => {});
      relayEndpoints.clear();
      if (relayClient !== undefined) await relayClient.stop();
    },
  };
}

/**
 * Read and parse a JSON request body within a bounded size.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<unknown>} the parsed body.
 */
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim() === '' ? undefined : JSON.parse(text);
}
