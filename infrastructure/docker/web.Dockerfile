# syntax=docker/dockerfile:1.7
# Builds a React app and serves it as static files: --build-arg APP=candidate-web|admin-web
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json tsconfig.web.json vite.shared.ts vitest.shared.ts ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --offline
ARG APP
# Public build-time config only. Never pass secrets as VITE_* args.
ARG VITE_API_URL
ARG VITE_APP_ENV=production
# Optional (empty = feature off): Google sign-in client id; admin's link to the candidate site.
ARG VITE_GOOGLE_CLIENT_ID=
ARG VITE_CANDIDATE_URL=
ENV VITE_API_URL=${VITE_API_URL} VITE_APP_ENV=${VITE_APP_ENV} \
    VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID} VITE_CANDIDATE_URL=${VITE_CANDIDATE_URL}
RUN pnpm turbo run build --filter=@cbi/${APP}

FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
ARG APP
COPY infrastructure/docker/spa.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/${APP}/dist /usr/share/nginx/html
EXPOSE 8080
