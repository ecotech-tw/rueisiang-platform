FROM node:22-bookworm-slim

ENV TZ=Asia/Taipei

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --break-system-packages --no-cache-dir msoffcrypto-tool

COPY tools/shopee-sales-report-export ./tools/shopee-sales-report-export
COPY tools/cyberbiz-reports/lib/report-ingest.mjs ./tools/cyberbiz-reports/lib/report-ingest.mjs
COPY tools/report-runner ./tools/report-runner

EXPOSE 8080
CMD ["node", "tools/report-runner/server.mjs"]
