import { CommentReports } from "../../components/comment-reports";
export default async function CommentsPage({
  searchParams,
}: {
  searchParams: Promise<{ workflowId?: string }>;
}) {
  const query = await searchParams;
  return (
    <CommentReports
      initialWorkflowId={
        typeof query.workflowId === "string" ? query.workflowId : ""
      }
    />
  );
}
