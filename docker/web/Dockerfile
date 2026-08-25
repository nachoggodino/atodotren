# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM node:24.15.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/canonical-journeys/package.json packages/canonical-journeys/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/gtfs-realtime/package.json packages/gtfs-realtime/package.json
COPY packages/gtfs-static/package.json packages/gtfs-static/package.json
COPY packages/observability/package.json packages/observability/package.json
RUN --mount=type=cache,target=/root/.npm npm ci

FROM dependencies AS build
COPY apps/web apps/web
RUN NEXT_BUILD_TARGET=standalone npm run build --workspace @atodotren/web

FROM node:24.15.0-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
