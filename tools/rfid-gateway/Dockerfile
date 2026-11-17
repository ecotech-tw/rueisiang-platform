FROM node:22-bookworm-slim

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

ENV NODE_ENV=production
ENV LISTEN_HOST=0.0.0.0
ENV LISTEN_PORT=6000
ENV HEALTH_HOST=0.0.0.0
ENV HEALTH_PORT=8788

EXPOSE 6000/tcp 8788/tcp

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.HEALTH_PORT || 8788) + '/healthz').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "src/server.mjs"]
