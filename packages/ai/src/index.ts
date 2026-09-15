export type AIUsage = { model: string; inputTokens: number; outputTokens: number; costUsd: number };

export interface AIProvider {
  generate(input: { system?: string; prompt: string }): Promise<{ text: string; usage: AIUsage }>;
}
