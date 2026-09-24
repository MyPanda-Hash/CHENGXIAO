# dsh-peer-mcp self-hosted relay.
#
# The relay is zero-dependency Node (built-ins only), so the image is just a
# runtime plus the source tree. Build from the repository root:
#
#   docker build -t dsh-peer-relay .
#   docker run -d --name dsh-peer-relay -p 7332:7332 dsh-peer-relay
#
# Or use docker-compose.relay.yml. Put it behind a TLS reverse proxy before
# exposing it beyond a trusted network; the channel is end-to-end encrypted
# regardless, but registration should not be world-open in production.

FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production \
    DSH_RELAY_HOST=0.0.0.0 \
    DSH_RELAY_PORT=7332

# Only the runtime source is needed; tests, docs and packaging stay out.
COPY src ./src

EXPOSE 7332

# alpine has busybox wget; probe the health route the same way an operator would.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${DSH_RELAY_PORT}/health || exit 1

CMD ["node", "src/relay-server-bin.js"]
