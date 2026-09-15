import { ContentStudio } from "../../components/content-studio";

export default async function ContentStudioPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <ContentStudio runId={runId} />;
}
