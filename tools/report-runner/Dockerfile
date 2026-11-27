FROM node:22-bookworm-slim

ENV TZ=Asia/Taipei

WORKDIR /app

COPY tools/cyberbiz-reports/requirements-scrapling-probe.txt /tmp/requirements-scrapling-probe.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && python3 -m pip install --break-system-packages --no-cache-dir \
      msoffcrypto-tool -r /tmp/requirements-scrapling-probe.txt \
    && scrapling install \
    && rm -rf /var/lib/apt/lists/* /tmp/requirements-scrapling-probe.txt

COPY tools/shopee-sales-report-export ./tools/shopee-sales-report-export
COPY tools/cyberbiz-reports/package.json tools/cyberbiz-reports/package-lock.json ./tools/cyberbiz-reports/
WORKDIR /app/tools/cyberbiz-reports
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium
COPY tools/cyberbiz-reports ./

WORKDIR /app
COPY tools/cyberbiz-reports/lib/report-ingest.mjs ./tools/cyberbiz-reports/lib/report-ingest.mjs
COPY tools/report-runner ./tools/report-runner

EXPOSE 8080
CMD ["node", "tools/report-runner/server.mjs"]
