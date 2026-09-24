export type AIUsage = { model: string; inputTokens: number; outputTokens: number; costUsd: number };

export interface AIProvider {
  generate(input: { system?: string; prompt: string }): Promise<{ text: string; usage: AIUsage }>;
}

export type AIConnection = { provider: "openai" | "openrouter"; model: string; token: string };

export async function generateNewsDraft(connection: AIConnection, article: { title: string; text: string; url?: string }) {
  const endpoint = connection.provider === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: connection.model,
      messages: [
        { role: "system", content: "شما دبیر خبر فارسی هستید. فقط بر اساس متن ورودی، خلاصه‌ای کوتاه، دقیق و بی‌طرف بنویس. واقعیت یا نقل‌قول تازه نساز. اگر اطلاعات کافی نیست، همین را شفاف بگو." },
        { role: "user", content: `عنوان: ${article.title}\nمتن: ${article.text.slice(0, 9000)}\nمنبع: ${article.url ?? "نامشخص"}` },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });
  const data = await response.json() as { error?: { message?: string }; choices?: Array<{ message?: { content?: string } }> };
  if (!response.ok) throw new Error(`AI request failed (${response.status}): ${data.error?.message ?? "Provider error"}`);
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("AI provider returned no text");
  return text;
}
