import { RunLive } from "../../components/run-live";

export default async function RunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <RunLive runId={runId} />;
}
