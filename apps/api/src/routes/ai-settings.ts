import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { generateNewsDraft, type AIConnection } from "@socialyar/ai";
import { aiProfiles, aiSettings, decryptSecret, encryptSecret, getDb, secretConfigurationProblem, workflowSteps, workflowVersions, workflows } from "@socialyar/db";

const settingsSchema = z.object({
  provider: z.enum(["openai", "openrouter", "gapgpt"]),
  model: z.string().min(1).max(120),
  token: z.string().min(8).optional(),
});
const profileSchema = settingsSchema.extend({ name: z.string().trim().min(1).max(80) });
const profileIdSchema = z.object({ profileId: z.string().uuid() });

function isMissingSettingsTable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const detail = current as { code?: string; cause?: unknown };
    if (detail.code === "42P01") return true;
    current = detail.cause;
  }
  return false;
}

export async function aiSettingsRoutes(app: FastifyInstance) {
  const db = getDb();
  app.addHook("onRequest", app.authenticate);

  app.get("/settings/ai", async (request, reply) => {
    try {
      const [row] = await db.select().from(aiSettings)
        .where(eq(aiSettings.workspaceId, request.auth.workspaceId)).limit(1);
      return { configured: Boolean(row), provider: row?.provider ?? "openrouter", model: row?.model ?? "",
        configurationProblem: secretConfigurationProblem() };
    } catch (error) {
      if (isMissingSettingsTable(error)) return reply.code(503).send({ error: "ai_settings_migration_required" });
      throw error;
    }
  });

  app.get("/settings/ai/profiles", async (request, reply) => {
    try {
      const [legacy, profiles] = await Promise.all([
        db.select({ provider: aiSettings.provider, model: aiSettings.model }).from(aiSettings)
          .where(eq(aiSettings.workspaceId, request.auth.workspaceId)).limit(1),
        db.select({ id: aiProfiles.id, name: aiProfiles.name, provider: aiProfiles.provider, model: aiProfiles.model })
          .from(aiProfiles).where(eq(aiProfiles.workspaceId, request.auth.workspaceId)).orderBy(asc(aiProfiles.createdAt)),
      ]);
      return { profiles: [
        ...(legacy[0] ? [{ id: "default", name: "پیش‌فرض", ...legacy[0] }] : []),
        ...profiles,
      ], configurationProblem: secretConfigurationProblem() };
    } catch (error) {
      if (isMissingSettingsTable(error)) return reply.code(503).send({ error: "ai_profiles_migration_required" });
      throw error;
    }
  });

  app.post("/settings/ai/profiles", async (request, reply) => {
    const input = profileSchema.parse(request.body);
    const problem = secretConfigurationProblem();
    if (problem) return reply.code(503).send({ error: problem });
    if (!input.token) return reply.code(400).send({ error: "token_required_for_provider" });
    try {
      const [row] = await db.insert(aiProfiles).values({ workspaceId: request.auth.workspaceId,
        name: input.name, provider: input.provider, model: input.model, encryptedToken: encryptSecret(input.token) })
        .returning({ id: aiProfiles.id, name: aiProfiles.name, provider: aiProfiles.provider, model: aiProfiles.model });
      return reply.code(201).send(row);
    } catch (error) {
      if (isMissingSettingsTable(error)) return reply.code(503).send({ error: "ai_profiles_migration_required" });
      throw error;
    }
  });

  app.put("/settings/ai/profiles/:profileId", async (request, reply) => {
    const { profileId } = profileIdSchema.parse(request.params);
    const input = profileSchema.parse(request.body);
    const problem = secretConfigurationProblem();
    if (problem) return reply.code(503).send({ error: problem });
    try {
      const [existing] = await db.select().from(aiProfiles).where(and(eq(aiProfiles.id, profileId),
        eq(aiProfiles.workspaceId, request.auth.workspaceId))).limit(1);
      if (!existing) return reply.code(404).send({ error: "ai_profile_not_found" });
      if (existing.provider !== input.provider && !input.token) return reply.code(400).send({ error: "token_required_for_provider" });
      const [row] = await db.update(aiProfiles).set({ name: input.name, provider: input.provider,
        model: input.model, encryptedToken: input.token ? encryptSecret(input.token) : existing.encryptedToken,
        updatedAt: new Date() }).where(eq(aiProfiles.id, profileId))
        .returning({ id: aiProfiles.id, name: aiProfiles.name, provider: aiProfiles.provider, model: aiProfiles.model });
      return row;
    } catch (error) {
      if (isMissingSettingsTable(error)) return reply.code(503).send({ error: "ai_profiles_migration_required" });
      throw error;
    }
  });

  app.delete("/settings/ai/profiles/:profileId", async (request, reply) => {
    const { profileId } = profileIdSchema.parse(request.params);
    try {
      const used = await db.select({ config: workflowSteps.config }).from(workflowSteps)
        .innerJoin(workflowVersions, eq(workflowSteps.workflowVersionId, workflowVersions.id))
        .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
        .where(and(eq(workflows.workspaceId, request.auth.workspaceId), eq(workflowSteps.type, "ai")));
      if (used.some((step) => step.config.profileId === profileId)) return reply.code(409).send({ error: "ai_profile_in_use" });
      const [row] = await db.delete(aiProfiles).where(and(eq(aiProfiles.id, profileId),
        eq(aiProfiles.workspaceId, request.auth.workspaceId))).returning({ id: aiProfiles.id });
      if (!row) return reply.code(404).send({ error: "ai_profile_not_found" });
      return { deleted: true };
    } catch (error) {
      if (isMissingSettingsTable(error)) return reply.code(503).send({ error: "ai_profiles_migration_required" });
      throw error;
    }
  });

  app.put("/settings/ai", async (request, reply) => {
    const input = settingsSchema.parse(request.body);
    const configurationProblem = secretConfigurationProblem();
    if (configurationProblem) return reply.code(503).send({ error: configurationProblem });
    try {
      const [existing] = await db.select().from(aiSettings)
        .where(eq(aiSettings.workspaceId, request.auth.workspaceId)).limit(1);
      if ((!existing || existing.provider !== input.provider) && !input.token) return reply.code(400).send({ error: "token_required_for_provider" });
      const encryptedToken = input.token ? encryptSecret(input.token) : existing!.encryptedToken;
      await db.insert(aiSettings).values({
        workspaceId: request.auth.workspaceId, provider: input.provider,
        model: input.model, encryptedToken, updatedAt: new Date(),
      }).onConflictDoUpdate({ target: aiSettings.workspaceId, set: {
        provider: input.provider, model: input.model, encryptedToken, updatedAt: new Date(),
      } });
      return { configured: true, provider: input.provider, model: input.model };
    } catch (error) {
      if (isMissingSettingsTable(error)) return reply.code(503).send({ error: "ai_settings_migration_required" });
      throw error;
    }
  });

  app.post("/settings/ai/test", async (request, reply) => {
    const input = z.object({ text: z.string().min(10).max(3000), profileId: z.union([z.literal("default"), z.string().uuid()]).optional() }).parse(request.body);
    const [row] = input.profileId && input.profileId !== "default" ? await db.select().from(aiProfiles)
      .where(and(eq(aiProfiles.id, input.profileId), eq(aiProfiles.workspaceId, request.auth.workspaceId))).limit(1) :
      await db.select().from(aiSettings).where(eq(aiSettings.workspaceId, request.auth.workspaceId)).limit(1);
    if (!row) return reply.code(409).send({ error: "ai_not_configured" });
    try {
      const text = await generateNewsDraft({ provider: row.provider as AIConnection["provider"],
        model: row.model, token: decryptSecret(row.encryptedToken) }, { title: "آزمایش اتصال", text: input.text });
      return { text };
    } catch (error) {
      request.log.error({ error }, "AI connection test failed");
      return reply.code(502).send({ error: "ai_provider_error", message: error instanceof Error ? error.message : "Provider error" });
    }
  });
}
