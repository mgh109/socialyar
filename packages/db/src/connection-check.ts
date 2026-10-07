import { connectionErrorReason, publishingTransport, type ConnectionPolicy, type PublishingTarget } from "./publishing-connection";

export async function checkDestination(target: PublishingTarget, request: typeof fetch) {
  if (target === "dropbox") {
    const response = await request("https://www.dropbox.com/", { method: "HEAD", signal: AbortSignal.timeout(15000) });
    return { reachable: response.ok, checks: [{ url: "https://www.dropbox.com/", status: response.status, reachable: response.ok }], authorizationVerified: false };
  }
  const urls = target === "youtube" ? [
    { url: "https://oauth2.googleapis.com/token", method: "POST", body: new URLSearchParams({ grant_type: "refresh_token" }) },
    { url: "https://www.googleapis.com/youtube/v3/channels?part=id", method: "GET" },
    { url: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", method: "POST", body: "{}" },
  ] : target === "telegram" ? [{ url: "https://api.telegram.org/bot0:invalid/getMe", method: "GET" }] : [{ url: "https://graph.facebook.com/me?fields=id", method: "GET" }];
  const checks: Array<{ url: string; status: number; reachable: boolean }> = [];
  for (const { url, ...options } of urls) {
    const response = await request(url, { ...options, signal: AbortSignal.timeout(15000) });
    const data = await response.json().catch(() => null);
    // A provider's structured missing-auth response proves service access without claiming OAuth authorization.
    const recognized = target === "telegram" ? data?.ok === false && typeof data.description === "string" && [401, 404].includes(response.status) :
      target === "instagram" ? [400,401,403].includes(response.status) && typeof data?.error?.code === "number" :
        [400,401,403,404,405].includes(response.status) && (typeof data?.error === "string" || typeof data?.error?.message === "string");
    const reachable = response.ok && data !== null && typeof data === "object" || recognized;
    checks.push({ url, status: response.status, reachable });
    if (!reachable) return { reachable: false, checks, error: `سرویس مقصد در دسترس نیست یا پاسخ معتبر نداد (HTTP ${response.status}).`, authorizationVerified: false };
  }
  return { reachable: true, checks, authorizationVerified: false };
}
export async function runConnectionCheck(workspaceId: string, target: PublishingTarget, policy: ConnectionPolicy) {
  const started = Date.now(); const transport = await publishingTransport(workspaceId, policy, target);
  try { return { ...await checkDestination(target, transport.fetch), ...transport.getRoute(), responseMs: Date.now() - started, checkedAt: new Date().toISOString(), executor: "publication-worker" }; }
  catch (error) { return { reachable: false, error: connectionErrorReason(error), ...transport.getRoute(), responseMs: Date.now() - started, checkedAt: new Date().toISOString(), executor: "publication-worker" }; }
  finally { await transport.close(); }
}
