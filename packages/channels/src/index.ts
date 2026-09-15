import type { Channel } from "@socialyar/shared";

export type PublishRequest = { channel: Channel; content: string; scheduledAt?: string };

export interface ChannelPublisher {
  publish(request: PublishRequest): Promise<{ externalId: string; publishedAt: string }>;
}
