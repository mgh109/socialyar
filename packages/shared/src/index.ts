import { z } from "zod";
export * from "./calendar";

export const channelSchema = z.enum(["instagram", "telegram", "website", "x", "linkedin", "eitaa", "youtube", "bale"]);
export type Channel = z.infer<typeof channelSchema>;

export const runStatusSchema = z.enum(["queued", "running", "waiting_approval", "failed", "completed"]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export * from "./content-collection";
export * from "./google-sheet";

export * from "./instagram";

export * from "./image-generation";

// YouTube Data API thumbnails.set: maximum uploaded image size is 50 MB.
export const YOUTUBE_COVER_MAX_BYTES = 50_000_000;

export * from "./youtube-analysis";
