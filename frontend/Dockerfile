# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS dependencies

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY . .
# The app may have no public assets yet; keep the runtime copy valid either way.
RUN mkdir -p public \
    && npm run build \
    && test -f .next/standalone/server.js

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN groupadd --system --gid 10001 acreiq \
    && useradd --system --uid 10001 --gid acreiq --create-home acreiq
WORKDIR /app
COPY --from=build --chown=10001:10001 /app/.next/standalone ./
COPY --from=build --chown=10001:10001 /app/.next/static ./.next/static
COPY --from=build --chown=10001:10001 /app/public ./public
USER 10001:10001

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=6s --start-period=45s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/api/health', {signal: AbortSignal.timeout(4000)}).then(async r => { if (!r.ok || (await r.json()).status !== 'ok') process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "server.js"]
