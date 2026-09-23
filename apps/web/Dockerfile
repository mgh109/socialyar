# syntax=docker/dockerfile:1
# Build context is the repo root:
#   docker build -f apps/web/Dockerfile -t socialyar-web .

ARG NODE_VERSION=22-alpine
ARG PNPM_VERSION=9.15.0

# ── base: node + pnpm ────────────────────────────────────────
FROM node:${NODE_VERSION} AS base
RUN apk add --no-cache libc6-compat \
  && corepack enable \
  && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ── build: install deps + Next.js standalone build ───────────
FROM base AS build
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
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile --filter @socialyar/web...
COPY . .
# NEXT_PUBLIC_* vars are inlined at build time
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WORKSPACE_ID
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_WORKSPACE_ID=${NEXT_PUBLIC_WORKSPACE_ID}
RUN pnpm --filter @socialyar/web build

# ── runner: standalone output only (smallest image) ──────────
FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
