import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { generateNewsDraft, type AIConnection } from "@socialyar/ai";
import { aiSettings, decryptSecret, encryptSecret, getDb } from "@socialyar/db";

const settingsSchema = z.object({
  provider: z.enum(["openai", "openrouter", "gapgpt"]),
  model: z.string().min(1).max(120),
  token: z.string().min(8).optional(),
});

export async function aiSettingsRoutes(app: FastifyInstance) {
  const db = getDb();
  app.addHook("onRequest", app.authenticate);

  app.get("/settings/ai", async (request) => {
    const [row] = await db.select().from(aiSettings)
      .where(eq(aiSettings.workspaceId, request.auth.workspaceId)).limit(1);
    return { configured: Boolean(row), provider: row?.provider ?? "openrouter", model: row?.model ?? "" };
  });

  app.put("/settings/ai", async (request, reply) => {
    const input = settingsSchema.parse(request.body);
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
  });

  app.post("/settings/ai/test", async (request, reply) => {
    const input = z.object({ text: z.string().min(10).max(3000) }).parse(request.body);
    const [row] = await db.select().from(aiSettings)
      .where(eq(aiSettings.workspaceId, request.auth.workspaceId)).limit(1);
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
