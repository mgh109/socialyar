import { z } from "zod";

export const channelSchema = z.enum(["instagram", "telegram", "website", "x", "linkedin", "eitaa"]);
export type Channel = z.infer<typeof channelSchema>;

export const runStatusSchema = z.enum(["queued", "running", "waiting_approval", "failed", "completed"]);
export type RunStatus = z.infer<typeof runStatusSchema>;
