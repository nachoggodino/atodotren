# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM node:24.15.0-bookworm-slim AS build-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/observability/package.json packages/observability/package.json
RUN --mount=type=cache,target=/root/.npm npm ci

FROM build-dependencies AS build
COPY tsconfig.json tsconfig.base.json ./
COPY scripts/clean-generated.ts scripts/clean-generated.ts
COPY apps/worker apps/worker
COPY packages/config packages/config
COPY packages/db packages/db
COPY packages/observability packages/observability
RUN npm run build

# This stage intentionally runs on TARGETPLATFORM. Native install scripts and
# compiled addons (including the future SQLite spool dependency) therefore
# match the runtime image instead of the machine running BuildKit.
FROM node:24.15.0-bookworm-slim AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/observability/package.json packages/observability/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:24.15.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=node:node /app/packages/config/package.json ./packages/config/package.json
COPY --from=build --chown=node:node /app/packages/config/dist ./packages/config/dist
COPY --from=build --chown=node:node /app/packages/db/package.json ./packages/db/package.json
COPY --from=build --chown=node:node /app/packages/db/dist ./packages/db/dist
COPY --from=build --chown=node:node /app/packages/observability/package.json ./packages/observability/package.json
COPY --from=build --chown=node:node /app/packages/observability/dist ./packages/observability/dist
COPY --chown=node:node migrations ./migrations

USER node
ENTRYPOINT ["node", "apps/worker/dist/cli.js"]
CMD ["doctor"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["node", "apps/worker/dist/cli.js", "doctor"]
