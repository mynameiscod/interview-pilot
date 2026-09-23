# syntax=docker/dockerfile:1.7
# Builds a Node service from the monorepo: --build-arg SERVICE=api|worker
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG SERVICE
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --offline
RUN pnpm turbo run build --filter=@cbi/${SERVICE}...
# Self-contained production bundle: service dist + built workspace deps + prod node_modules.
RUN pnpm --filter @cbi/${SERVICE} deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
ARG APP_VERSION=0.0.0-dev
ENV NODE_ENV=production APP_VERSION=${APP_VERSION}
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
# SIGTERM goes straight to node, which drains connections/jobs before exiting.
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
