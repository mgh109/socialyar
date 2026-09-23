# syntax=docker/dockerfile:1
# Build context is the repo root:
#   docker build -f apps/worker/Dockerfile -t socialyar-worker .

ARG NODE_VERSION=22-alpine
ARG PNPM_VERSION=9.15.0

# ── base: node + pnpm ────────────────────────────────────────
FROM node:${NODE_VERSION} AS base
RUN apk add --no-cache libc6-compat \
  && corepack enable \
  && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ── manifests: dependency metadata only (cache-friendly) ─────
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/ai/package.json packages/ai/
COPY packages/channels/package.json packages/channels/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY packages/workflow/package.json packages/workflow/

# ── prod-deps: production deps for worker + workspace deps ───
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile --prod --filter @socialyar/worker...

# ── runner ───────────────────────────────────────────────────
# Workspace packages ship raw .ts (exports -> ./src/index.ts),
# so the workspace layout is preserved and run via tsx.
FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app ./
COPY --chown=node:node tsconfig.base.json ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node apps/worker ./apps/worker
USER node
WORKDIR /app/apps/worker
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
