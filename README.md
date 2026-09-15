# SocialYar

AI-native social/content workflow platform.

## Architecture

- `apps/web` — Next.js product UI
- `apps/api` — Fastify API
- `apps/worker` — BullMQ workflow worker
- `packages/workflow` — workflow runtime
- `packages/ai` — model/provider abstraction
- `packages/channels` — social publishing adapters
- `packages/db` — DB schema/migrations package
- `packages/shared` — shared schemas/types
- `packages/ui` — design tokens/UI primitives

## MVP flow

Workflow → Run → Content Studio → Channel Variants → Approval → Calendar/Publish → Analytics/Reports

## Next implementation slice

1. Add Drizzle schema + migrations for workflows/runs/content/approvals/publications.
2. Implement persisted workflow CRUD.
3. Add run event stream over SSE.
4. Implement first AI content generation step.
5. Build Content Studio from the approved Figma prototype.
