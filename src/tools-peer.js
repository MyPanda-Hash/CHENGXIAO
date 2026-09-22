/**
 * The agent-facing peer tools.
 *
 * These are the only peer operations the model may perform, and the set is
 * deliberately missing one thing: nothing here can open a network listener or
 * widen a peer's permission. A model that could expose the machine would undo
 * every other control in this plugin, so exposure stays a configuration
 * decision the operator makes, and the tools only *report* what it is.
 *
 * Each tool answers with a plain object instead of throwing. A refusal is
 * information the model has to relay to the operator, and a thrown error would
 * end the turn instead of starting that conversation.
 */

/** Presets an operator may grant. Anything else is refused rather than passed on. */
export const ALLOWED_PRESETS = ['workspace-write', 'danger-full-access'];

/**
 * Render a declared value the way every built-in tool does.
 *
 * The host validates `execute`'s return against the declared schema and then
 * calls this to turn that value into model-visible content. Rendering the value
 * as JSON keeps a refusal's code legible instead of flattening it into prose.
 *
 * @param {unknown} _args - the validated arguments (unused).
 * @param {unknown} value - the value returned by execute.
 * @returns {{ type: 'text', text: string }[]} the content parts.
 */
const renderValue = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];

/**
 * Declare an output over a value schema.
 *
 * Schemas are `additionalProperties: true` on purpose: the fields a model needs
 * differ between success and refusal, and a schema tight enough to pin every
 * branch would be a second place for the contract to drift out of date.
 *
 * @param {object} properties - declared top-level properties.
 * @returns {{ schema: object, render: typeof renderValue }} the output declaration.
 */
const outputOf = (properties) => ({
  schema: { type: 'object', additionalProperties: true, properties },
  render: renderValue,
});

const text = (description) => ({ type: 'string', description });
const boolean = (description) => ({ type: 'boolean', description });
// The host's schema compiler requires every object — array items included — to
// state dditionalProperties explicitly rather than relying on the default.
const arrayOfObjects = (description) => ({
  type: 'array',
  items: { type: 'object', additionalProperties: true },
  description,
});

/**
 * Answer one operation without throwing.
 *
 * @param {() => Promise<object>} operation - the work to do.
 * @param {string} fallbackCode - code to report when the failure carries none.
 * @returns {Promise<object>} the answer, or a failure description.
 */
async function answering(operation, fallbackCode) {
  try {
    return await operation();
  } catch (cause) {
    return {
      ok: false,
      code: typeof cause?.code === 'string' ? cause.code : fallbackCode,
      detail: String(cause?.message ?? cause),
    };
  }
}

/** Report what this machine is doing, in both directions, without secrets. */
const peerStatus = {
  name: 'peer_status',
  description:
    'Report this machine\'s peer state: whether the inbound listener is on, the address peers dial, a pending pairing code\'s expiry, the machines this one may drive, and the machines allowed to drive this one. Never returns pairing codes or credentials.',
  parameters: {},
  output: outputOf({
    listening: boolean('Whether the inbound listener is on.'),
    address: text('The address peers dial, when listening.'),
    pendingUntil: text('When a live pairing code expires, if one is outstanding.'),
    pendingAddress: text('The address a live pairing code carries.'),
    peers: arrayOfObjects('Machines this one may drive.'),
    trustedBy: arrayOfObjects('Machines allowed to drive this one.'),
  }),
  execute: async (_args, { service }) =>
    await answering(async () => {
      const status = service.status();
      return {
        listening: status.listening,
        ...(status.address !== undefined && { address: status.address }),
        ...(status.pending !== undefined && {
          pendingUntil: status.pending.expiresAt,
          pendingAddress: status.pending.address,
        }),
        peers: status.peers.map((peer) => ({ name: peer.name, address: peer.address })),
        trustedBy: status.trustedBy.map((peer) => ({
          id: peer.id,
          name: peer.name,
          preset: peer.policy?.preset ?? 'unknown',
          ...(peer.revokedAt !== undefined && { revokedAt: peer.revokedAt }),
        })),
      };
    }, 'status-failed'),
};

/** Issue a one-time pairing code for the operator to read out. */
const peerTicket = {
  name: 'peer_ticket',
  description:
    'Issue a one-time pairing code for another machine to claim. The operator must turn the inbound listener on first; this tool cannot do that. The code is short-lived and single-use, and must be handed to the operator rather than stored.',
  parameters: {
    preset: {
      type: 'string',
      enum: [...ALLOWED_PRESETS],
      description:
        'Permission level granted to the machine that claims this code. workspace-write is the safe default; danger-full-access lets the peer do anything this machine\'s DSH can do.',
    },
  },
  output: outputOf({
    ok: boolean('Whether a code was issued.'),
    code: text('The pairing code to read out to the operator, or a refusal code.'),
    link: text('The full dshp:// link to hand over.'),
    expiresAt: text('When the code stops working.'),
    preset: text('The permission level the claiming machine will receive.'),
    detail: text('Why the request was refused, when it was.'),
  }),
  execute: async (args, { service }) =>
    await answering(async () => {
      const preset = args?.preset;
      if (preset !== undefined && !ALLOWED_PRESETS.includes(preset)) {
        return {
          ok: false,
          code: 'preset-not-allowed',
          detail: `preset must be one of ${ALLOWED_PRESETS.join(', ')}`,
        };
      }

      const status = service.status();
      if (status.listening !== true) {
        return {
          ok: false,
          code: 'listener-off',
          detail:
            'the inbound listener is off, so no peer could reach this machine. Ask the operator to enable listening in the plugin settings, then try again.',
        };
      }

      const ticket = await service.createTicket({
        ...(preset !== undefined && { policy: { preset } }),
      });
      return {
        ok: true,
        code: ticket.code,
        link: ticket.link,
        expiresAt: ticket.expiresAt,
        preset: preset ?? 'workspace-write',
      };
    }, 'ticket-failed'),
};

/** Claim a code from another machine. */
const peerPair = {
  name: 'peer_pair',
  description:
    'Claim a pairing link (dshp://host:port/CODE) that an operator gave you from another machine. On success the other machine becomes callable as a peer, and its tools appear after the mount.',
  parameters: {
    link: {
      type: 'string',
      required: true,
      description: 'The pairing link exactly as the other machine displayed it.',
    },
  },
  output: outputOf({
    ok: boolean('Whether the other machine accepted this device.'),
    peer: text('The name this machine paired with.'),
    address: text('Where that machine was reached.'),
    mounted: boolean('Whether the peer is now callable. Pairing can succeed while mounting fails.'),
    mountError: {
      type: 'object',
      additionalProperties: true,
      description: 'Why the peer is not callable yet, when pairing succeeded but mounting did not.',
    },
    code: text('Why pairing failed, when it did.'),
    detail: text('What the operator or model should do next.'),
  }),
  execute: async (args, { service }) =>
    await answering(async () => {
      const outcome = await service.pair({ link: String(args?.link ?? '') });
      if (outcome.ok !== true) return outcome;
      return {
        ok: true,
        peer: outcome.peer.name,
        address: outcome.peer.address,
        mounted: outcome.mounted === true,
        ...(outcome.mountError !== undefined && {
          mountError: outcome.mountError,
          detail:
            'the other machine already trusts this one, so the pairing code is spent. Fix the mount problem and the peer becomes callable; re-pairing is only needed if the credential itself is wrong.',
        }),
      };
    }, 'pair-failed'),
};

/** Stop trusting a machine that was paired in. */
const peerRevoke = {
  name: 'peer_revoke',
  description:
    'Revoke a machine that is allowed to drive this one, identified by the id from peer_status. Its credential stops working immediately; the record stays visible so the revocation can be audited.',
  parameters: {
    id: {
      type: 'string',
      required: true,
      description: 'The peer id reported by peer_status under trustedBy.',
    },
  },
  output: outputOf({
    ok: boolean('Whether a peer was revoked.'),
    id: text('The revoked peer record id.'),
    name: text('The revoked machine name.'),
    revokedAt: text('When the revocation took effect.'),
    code: text('Why revocation failed, when it did.'),
  }),
  execute: async (args, { service }) =>
    await answering(async () => {
      const peer = await service.revoke(String(args?.id ?? ''));
      return { ok: true, id: peer.id, name: peer.name, revokedAt: peer.revokedAt };
    }, 'revoke-failed'),
};

/** Every peer tool the plugin exposes, in registration order. */
export const PEER_TOOL_SPECS = [peerStatus, peerTicket, peerPair, peerRevoke];
