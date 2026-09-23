/**
 * Relay message envelopes and per-device mailboxes.
 *
 * The relay is a dumb forwarder: it never inspects `body`, only the routing
 * fields (`to`, `from`, `kind`, `id`) needed to deliver it. Everything else in
 * the envelope is opaque to the relay by construction.
 */

/** Stable error with a `code`. */
class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

/** Build one envelope. */
export function createEnvelope({ to, from, kind, id, body }) {
  if (typeof to !== 'string' || to === '') throw new ProtocolError('envelope-malformed', 'envelope needs a to');
  if (typeof from !== 'string' || from === '') throw new ProtocolError('envelope-malformed', 'envelope needs a from');
  if (typeof kind !== 'string' || kind === '') throw new ProtocolError('envelope-malformed', 'envelope needs a kind');
  if (typeof id !== 'string' || id === '') throw new ProtocolError('envelope-malformed', 'envelope needs an id');
  return { to, from, kind, id, body: body ?? {} };
}

/** Validate an untrusted value as an envelope. Returns a code, or undefined when fine. */
export function validateEnvelope(value) {
  if (typeof value !== 'object' || value === null) return 'envelope-malformed';
  const { to, from, kind, id, body } = value;
  if (typeof to !== 'string' || to === '') return 'envelope-malformed';
  if (typeof from !== 'string' || from === '') return 'envelope-malformed';
  if (typeof kind !== 'string' || kind === '') return 'envelope-malformed';
  if (typeof id !== 'string' || id === '') return 'envelope-malformed';
  if (body !== undefined && (typeof body !== 'object' || body === null)) return 'envelope-malformed';
  return undefined;
}

/**
 * An in-memory per-device mailbox.
 *
 * Delivery is at-most-once: a message stays in the queue until a reader takes
 * it and acknowledges it. The relay holds nothing else, and nothing is written
 * to disk.
 */
export function createMailbox() {
  const queues = new Map();
  const pending = new Map(); // device -> Set of taken-but-unacked ids

  const queueFor = (device) => {
    let queue = queues.get(device);
    if (queue === undefined) {
      queue = [];
      queues.set(device, queue);
    }
    return queue;
  };

  const takenFor = (device) => {
    let set = pending.get(device);
    if (set === undefined) {
      set = new Set();
      pending.set(device, set);
    }
    return set;
  };

  return {
    push(envelope) {
      queueFor(envelope.to).push(envelope);
    },
    peekCount(device) {
      return queueFor(device).length;
    },
    takeNext(device) {
      const queue = queueFor(device);
      while (queue.length > 0) {
        const envelope = queue.shift();
        if (pending.get(device)?.has(envelope.id) === true) continue; // re-queue guard
        takenFor(device).add(envelope.id);
        return envelope;
      }
      return undefined;
    },
    ack(device, id) {
      takenFor(device).delete(id);
    },
    clear(device) {
      queues.delete(device);
      pending.delete(device);
    },
  };
}
