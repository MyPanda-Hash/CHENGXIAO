/**
 * Claiming a pairing code over the network.
 *
 * This is the initiating half of the handshake: it reads the link the operator
 * pasted, asks the worker to accept this device, and stores what comes back.
 *
 * Every failure is an answer, never an exception: a wrong code and an
 * unreachable machine are both things the operator must be told about, and
 * neither of them should look like a crash or leave a half-saved peer behind.
 */

/** Schemes a pairing link may use: direct (`dshp:`) or via a relay (`dshr:`). */
const LINK_SCHEME = 'dshp:';
const RELAY_LINK_SCHEME = 'dshr:';

/** How long to wait for a worker to answer before calling it unreachable. */
export const PAIR_TIMEOUT_MS = 20_000;

/** Stable error with a `code`. */
class PairLinkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PairLinkError';
    this.code = code;
  }
}

/**
 * Parse the link an operator pasted.
 *
 * @param {string} link - the `dshp://host:port/CODE` or `dshr://relay-host/DEVICE/CODE` link.
 * @returns {{ scheme: string, address: string, code: string, origin: string } | { scheme: string, relayAddress: string, deviceId: string, code: string, origin: string }} the parts.
 * @throws {PairLinkError} when the link cannot be used.
 */
export function parsePairLink(link) {
  if (typeof link !== 'string' || link.trim() === '') {
    throw new PairLinkError('link-malformed', 'a pairing link is required');
  }

  let url;
  try {
    url = new URL(link.trim());
  } catch {
    throw new PairLinkError('link-malformed', `${link} is not a URL`);
  }

  if (url.protocol === RELAY_LINK_SCHEME) {
    const segments = url.pathname.replace(/^\/+/u, '').split('/').filter((part) => part !== '');
    const deviceId = segments[0] ?? '';
    const code = segments.slice(1).join('/');
    if (url.host === '') {
      throw new PairLinkError('link-address-missing', 'the relay pairing link names no relay');
    }
    if (deviceId === '') {
      throw new PairLinkError('link-device-missing', 'the relay pairing link carries no device id');
    }
    if (code === '') {
      throw new PairLinkError('link-code-missing', 'the pairing link carries no code');
    }
    return { scheme: 'dshr', relayAddress: url.host, deviceId, code, origin: `http://${url.host}` };
  }

  if (url.protocol !== LINK_SCHEME) {
    throw new PairLinkError('link-scheme', `a pairing link starts with ${LINK_SCHEME}// or ${RELAY_LINK_SCHEME}// , got ${url.protocol}//`);
  }

  const address = url.host;
  if (address === '') {
    throw new PairLinkError('link-address-missing', 'the pairing link names no machine');
  }

  const code = url.pathname.replace(/^\/+/u, '');
  if (code === '') {
    throw new PairLinkError('link-code-missing', 'the pairing link carries no code');
  }

  return { scheme: 'dshp', address, code, origin: `http://${address}` };
}

/**
 * Ask a worker to accept this device.
 *
 * @param {{
 *   link: { address: string, code: string, origin: string },
 *   deviceName: string,
 *   identity: { publicKey: string },
 *   store: { addPeer: (input: object) => Promise<object> },
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} input - one pairing attempt.
 * @returns {Promise<{ ok: true, peer: object, worker: object } | { ok: false, code: string, detail: string }>} the outcome.
 */
export async function pairWith({
  link,
  deviceName,
  identity,
  store,
  timeoutMs = PAIR_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(`${link.origin}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: link.code,
        name: deviceName,
        publicKey: identity.publicKey,
      }),
      signal: controller.signal,
    });
  } catch (cause) {
    const aborted = cause?.name === 'AbortError';
    // A bare "fetch failed" tells the operator nothing, and the causes behind it
    // are ordinary ones they can check in a minute: the other machine is not
    // listening, something on the path is blocking the port, or the address is
    // stale. Name them, in the order worth checking.
    //
    // The port comes from the link and never from a default: the listening port
    // is configurable, so advice quoting the wrong number would send the
    // operator to inspect a port that was never in play. Read off the address
    // rather than reparsed, because this is a failure path that must not throw.
    const named = /:(\d+)$/u.exec(link.address);
    const port = named === null ? '' : named[1];
    const where = port === '' ? '监听端口' : `${port} 端口`;
    const probe =
      port === '' ? '查一下实际监听端口' : `Get-NetTCPConnection -LocalPort ${port} -State Listen`;

    return {
      ok: false,
      code: aborted ? 'pairing-timeout' : 'worker-unreachable',
      detail: aborted
        ? [
            `向 ${link.address} 发出的连接一直没有回应，${String(timeoutMs)}ms 后放弃。`,
            '注意：一直没回应并不代表地址是对的。Windows 上「没有人在监听」和「防火墙把包丢了」看起来完全一样——不是被拒绝，而是一片沉默。',
            `所以两边都要查：那台机器上 DSH 是否在跑、插件是否已加载、${where}是否真的在监听（${probe}）；以及入站 ${where}是否被防火墙拦了。`,
            '这些都没问题，才轮到「那台机器正忙」这一项，隔一会儿重试即可。',
            `底层报错：${String(cause?.message ?? cause)}`,
          ].join('\n   ')
        : [
            `连不上 ${link.address}。按这个顺序查：`,
            '1) 对方是否开着监听——插件默认 listen: false，必须在它的 profile 覆盖层里显式设为 true，改完要重启 DSH；',
            `2) 对方的 ${where}是否真的在监听（在那台机器上跑 ${probe}）；`,
            `3) 防火墙是否放行了入站 ${where}（首次监听会有授权框，被忽略就会静默丢弃）；`,
            '4) 地址是否过期——配对码里的地址是发码时探测的，对方换了网络（换了 Wi-Fi、网线拔插）就会失效，重新发一个码。',
            `底层报错：${String(cause?.message ?? cause)}`,
          ].join('\n   '),
    };
  } finally {
    clearTimeout(timer);
  }

  const payload = await readJson(response);

  if (response.ok !== true || payload?.ok !== true) {
    return {
      ok: false,
      code: typeof payload?.code === 'string' ? payload.code : `worker-http-${String(response.status)}`,
      detail: typeof payload?.detail === 'string' ? payload.detail : 'the worker refused this pairing',
    };
  }

  const peer = await store.addPeer({
    credential: payload.credential,
    address: link.address,
    name: deviceName,
    ...(payload.worker?.installId !== undefined && { workerInstallId: payload.worker.installId }),
  });

  return { ok: true, peer, worker: payload.worker ?? {} };
}

/**
 * Read a JSON body, tolerating a worker that answered with something else.
 *
 * @param {Response} response - the HTTP response.
 * @returns {Promise<any>} the parsed body, or undefined when it is not JSON.
 */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
