export type YoutubeItem = { id: string; runId: string | null; stepKey: string; status: string; title: string; description: string; channelName: string;
  progress: number; videoId: string | null; actualPrivacy: string | null; error: string | null; updatedAt: string;
  createdAt?: string; approvedAt?: string | null; scheduledAt: string | null; settings: Record<string, unknown>; logs: Array<Record<string, unknown>> };

export type WorkflowApproval={runId:string;workflowName:string;stepKey:string;stepName:string;output:{actionLabel?:string;actionStatus?:string;images?:Array<{url:string}>;imageGeneration?:{error?:string};title?:string|null;text?:string;imageUrl?:string|null;videoUrl?:string|null;url?:string;sentiment?:string;commentId?:string;reply?:string;decision?:string;reason?:string}|null;createdAt:string|null};

export type ApprovalRow={approval:{id:string;status:string;reason:string|null;agentRecommendation:string|null;createdAt:string};variant:{id:string;channel:string;title:string|null;body:string;status:string;settings?:Record<string,unknown>;calendarVersion?:number;updatedAt?:string};content:{id:string;runId:string|null;title:string|null;metadata?:Record<string,unknown>}};
