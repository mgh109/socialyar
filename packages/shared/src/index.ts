import { z } from "zod";
export * from "./calendar";

export const channelSchema = z.enum(["instagram", "telegram", "website", "x", "linkedin", "eitaa", "youtube"]);
export type Channel = z.infer<typeof channelSchema>;

export const runStatusSchema = z.enum(["queued", "running", "waiting_approval", "failed", "completed"]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export * from "./content-collection";
