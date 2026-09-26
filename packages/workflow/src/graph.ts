export type GraphNode = { key: string; type: string };
export type GraphEdge = { sourceKey: string; targetKey: string };

const sources = new Set(["rss_source", "manual_input"]);
const outputs = new Set(["publish", "draft"]);
export const supportedTypes = new Set(["rss_source", "manual_input", "filter", "ai", "human_approval", "draft", "publish"]);

/** A DAG with reachable inputs and explicit terminals; joins accept the first active input. */
export function graphProblem(nodes: GraphNode[], edges: GraphEdge[], active: boolean): string | null {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  if (byKey.size !== nodes.length || nodes.some((node) => !supportedTypes.has(node.type))) return "graph_invalid_step";
  const incoming = new Map(nodes.map((node) => [node.key, 0]));
  const outgoing = new Map(nodes.map((node) => [node.key, [] as string[]]));
  const seen = new Set<string>();
  for (const edge of edges) {
    const from = byKey.get(edge.sourceKey), to = byKey.get(edge.targetKey);
    const id = `${edge.sourceKey}\u0000${edge.targetKey}`;
    if (!from || !to || from.key === to.key || sources.has(to.type) || outputs.has(from.type) || seen.has(id))
      return "graph_invalid_connection";
    seen.add(id); incoming.set(to.key, incoming.get(to.key)! + 1); outgoing.get(from.key)!.push(to.key);
  }
  const degree = new Map(incoming);
  const ready = nodes.filter((node) => !degree.get(node.key)).map((node) => node.key);
  let visited = 0;
  while (ready.length) {
    const key = ready.shift()!;
    visited++;
    for (const target of outgoing.get(key)!) {
      degree.set(target, degree.get(target)! - 1);
      if (!degree.get(target)) ready.push(target);
    }
  }
  if (visited !== nodes.length) return "graph_cycle";
  if (!active) return null;
  const roots = nodes.filter((node) => sources.has(node.type));
  if (!roots.length || nodes.some((node) => sources.has(node.type) ? incoming.get(node.key) !== 0 : incoming.get(node.key) === 0))
    return "graph_missing_input";
  const reached = new Set(roots.map((node) => node.key));
  const queue = [...reached];
  while (queue.length) for (const next of outgoing.get(queue.shift()!)!) if (!reached.has(next)) { reached.add(next); queue.push(next); }
  if (reached.size !== nodes.length || nodes.some((node) => !outgoing.get(node.key)!.length && !outputs.has(node.type)))
    return "graph_unfinished_branch";
  return null;
}
