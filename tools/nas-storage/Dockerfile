FROM node:22-bookworm-slim

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

ENV NODE_ENV=production
ENV STORAGE_ROOT=/storage
ENV LISTEN_HOST=0.0.0.0
ENV LISTEN_PORT=8787

RUN mkdir -p /storage

EXPOSE 8787

# The bind-mounted DSM share supplies its own permissions. The container has no
# Docker socket or host filesystem mount other than the explicit storage share.
USER root

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.LISTEN_PORT || 8787) + '/healthz').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "src/server.mjs"]
