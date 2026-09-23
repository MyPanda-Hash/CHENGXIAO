import { networkInterfaces } from 'node:os';
import { openTrustStore } from './trust.js';
import { openPairingStore } from './pairing.js';
import { openInitiatorStore } from './initiator.js';
import { pairWith, parsePairLink } from './pair-client.js';
import { createVerifier } from './auth.js';
import { createPeerMounts } from './mounts.js';
import { createPairThrottle, handlePair } from './handshake.js';
import { startAdapter } from './server.js';

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
  log = () => {},
}) {
  const trust = await openTrustStore({ home });
  const pairing = await openPairingStore({ home });
  const initiator = await openInitiatorStore({ home, deviceName });

  let adapter;
  let advertised;
  let pending;

  if (listen) {
    // Built once per service so failure counts survive across requests — a
    // throttle constructed per request would count every attempt as the first.
    const throttle = createPairThrottle();
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

  const mounts =
    mcp === undefined || mountContext === undefined
      ? undefined
      : createPeerMounts({ ctx: mountContext, store: initiator, mcp, toolCallTimeoutMs });

  return {
    status() {
      const trustedBy = trust.listPeers();
      const bound = adapter === undefined ? undefined : `${advertiseHost()}:${String(adapter.port)}`;
      return {
        listening: adapter !== undefined,
        ...(adapter !== undefined && { url: `http://${advertiseHost()}:${String(adapter.port)}/mcp` }),
        ...(bound !== undefined && { address: bound }),
        installId: trust.identity.installId,
        deviceName: initiator.identity.deviceName,
        ...(pending !== undefined && { pending }),
        // Named from this machine's point of view: `peers` are the machines this
        // one may drive, `trustedBy` are the machines allowed to drive this one.
        peers: initiator.listPeers().map((peer) => ({
          id: peer.id,
          name: peer.name,
          address: peer.address,
          pairedAt: peer.pairedAt,
          ...(peer.workerInstallId !== undefined && { workerInstallId: peer.workerInstallId }),
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

    async createTicket({ policy, ttlMs } = {}) {
      if (adapter === undefined) {
        throw new ServiceError(
          'listener-off',
          'turn the inbound listener on before issuing a pairing code, or nobody can reach this machine',
        );
      }
      const ticket = await pairing.create({
        address: `${advertiseHost()}:${String(adapter.port)}`,
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
      const outcome = await pairWith({
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
        log(`pairing with ${parsed.address} failed: ${outcome.code}`);
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
