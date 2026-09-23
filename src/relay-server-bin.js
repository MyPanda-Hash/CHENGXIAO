#!/usr/bin/env node
import { createRelayServer } from './relay/index.js';

/**
 * Standalone relay entry: run a self-hosted relay anywhere Node runs.
 *
 *   DSH_RELAY_HOST=0.0.0.0 DSH_RELAY_PORT=7332 node src/relay-server-bin.js
 *
 * The relay holds no secrets and writes nothing to disk: it routes sealed
 * envelopes between registered devices and forgets everything on restart.
 * Put it behind TLS (a reverse proxy) before exposing it beyond a trusted
 * network — the channel is end-to-end encrypted regardless, but registration
 * itself should not be world-open in production.
 */

const host = process.env.DSH_RELAY_HOST ?? '0.0.0.0';
const portCandidate = Number(process.env.DSH_RELAY_PORT ?? process.env.PORT ?? 7332);
const port = Number.isInteger(portCandidate) && portCandidate > 0 && portCandidate <= 65535 ? portCandidate : 7332;

const relay = await createRelayServer({
  host,
  port,
  log: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
});

process.stdout.write(`dsh-peer-mcp relay listening on ${host}:${String(relay.port)}\n`);
process.stdout.write('devices connect with relayUrl http://<this-host>:<port>\n');

const shutdown = () => {
  relay.http.close();
  relay.http.closeAllConnections?.();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
