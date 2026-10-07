import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { SocksClient } from "socks";
import { connect as tlsConnect } from "node:tls";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, eq } from "drizzle-orm";
import { getDb } from "./client";
import { publishingProxies } from "./schema";
import { decryptSecret } from "./secrets";

export type PublishingTarget = "youtube" | "telegram" | "instagram";
export type ConnectionPolicy = { mode: "direct" | "proxy" | "auto"; proxyId?: string };
export type ConnectionEvent = { route: "direct" | "proxy"; proxyName?: string; result: string; error?: string };
export type ProxyConfig = { id: string; name: string; protocol: string; host: string; port: number; authEnc: string | null; isActive: boolean };
export const destinationHosts: Record<PublishingTarget, string[]> = {
  youtube: ["www.googleapis.com", "oauth2.googleapis.com"],
  telegram: ["api.telegram.org"],
  instagram: ["graph.instagram.com", "graph.facebook.com", "www.instagram.com"],
};
export function connectionPolicy(raw: unknown): ConnectionPolicy {
  if (raw === undefined || raw === null) return { mode: "direct" };
  const value = raw as ConnectionPolicy;
  if (!value || !["direct", "proxy", "auto"].includes(value.mode)) throw new Error("Invalid connection mode");
  if (value.mode !== "direct" && (typeof value.proxyId !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value.proxyId))) throw new Error("Select a saved proxy");
  return { mode: value.mode, ...(value.mode !== "direct" ? { proxyId: value.proxyId } : {}) };
}
function errorCodes(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const e = error as { code?: string; cause?: unknown; errors?: unknown[]; name?: string };
  return [e.code ?? "", e.name ?? "", ...errorCodes(e.cause), ...(e.errors ?? []).flatMap(errorCodes)];
}
function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const e = error as { message?: string; cause?: unknown; errors?: unknown[] };
  return [e.message ?? "", errorText(e.cause), ...(e.errors ?? []).map(errorText)].join(" ");
}
export function isConnectionError(error: unknown) {
  return errorCodes(error).some((code) => ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "TimeoutError"].includes(code));
}
export function definitelyNotSent(error: unknown) {
  return errorCodes(error).some((code) => ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"].includes(code));
}
export class AmbiguousDeliveryError extends Error {
  readonly code = "DELIVERY_UNKNOWN";
  constructor() { super("نتیجه ارسال نامشخص است؛ برای جلوگیری از انتشار تکراری، وضعیت مقصد باید پیش از ارسال دوباره بررسی شود."); }
}
// Never persist underlying exception text: it may contain a proxy URL, password or service token.
export function connectionErrorReason(error: unknown) {
  const codes = errorCodes(error);
  const text = errorText(error);
  if (error instanceof Error && ["احراز هویت پروکسی ناموفق بود؛ نام کاربری و رمز را بررسی کنید.", "اتصال شبکه برقرار نشد یا مهلت پاسخ پایان یافت.", "اعتبار گواهی اتصال امن تأیید نشد."].includes(error.message)) return error.message;
  if (codes.includes("DELIVERY_UNKNOWN") || error instanceof AmbiguousDeliveryError) return new AmbiguousDeliveryError().message;
  if (codes.includes("PROXY_UNAVAILABLE")) return "پروکسی انتخاب‌شده حذف شده یا غیرفعال است.";
  if (/407|authentication|auth failed|username.*password/i.test(text)) return "احراز هویت پروکسی ناموفق بود؛ نام کاربری و رمز را بررسی کنید.";
  if (isConnectionError(error)) return "اتصال شبکه برقرار نشد یا مهلت پاسخ پایان یافت.";
  if (codes.some((c) => /CERT|TLS|SSL/.test(c))) return "اعتبار گواهی اتصال امن تأیید نشد.";
  return "اتصال به پروکسی یا سرویس مقصد ناموفق بود.";
}
export async function validateProxyHost(host: string) {
  if (!host || /[\s/@?#\\]/.test(host) || host.includes(":") && !isIP(host)) throw new Error("Invalid proxy host");
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address, family }) => family !== 4 ||
    /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.(?:18|19)\.|22[4-9]\.|23\d\.|24\d\.|25\d\.)/.test(address))) throw new Error("Proxy host must resolve to public IPv4");
  return addresses[0].address;
}
export async function loadPublishingProxy(workspaceId: string, id: string) {
  const [proxy] = await getDb().select().from(publishingProxies).where(and(eq(publishingProxies.id, id), eq(publishingProxies.workspaceId, workspaceId), eq(publishingProxies.isActive, true)));
  if (!proxy) throw Object.assign(new Error("پروکسی انتخاب‌شده فعال نیست یا به این فضای کاری تعلق ندارد."), { code: "PROXY_UNAVAILABLE" });
  return proxy;
}
export async function validateConnectionPolicy(workspaceId: string, raw: unknown) {
  const policy = connectionPolicy(raw);
  if (policy.proxyId) await loadPublishingProxy(workspaceId, policy.proxyId);
  return policy;
}
export async function createProxyDispatcher(proxy: ProxyConfig, resolveHost = validateProxyHost): Promise<Dispatcher> {
  const address = await resolveHost(proxy.host);
  const auth = proxy.authEnc ? JSON.parse(decryptSecret(proxy.authEnc)) as { username: string; password: string } : null;
  if (proxy.protocol === "http" || proxy.protocol === "https") {
    const pinnedLookup: any = (_hostname: string, options: any, callback: any) => options?.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4);
    return new ProxyAgent({ uri: `${proxy.protocol}://${proxy.host}:${proxy.port}`, ...(auth ? { token: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}` } : {}),
      proxyTls: { lookup: pinnedLookup, rejectUnauthorized: true }, requestTls: { rejectUnauthorized: true } });
  }
  if (proxy.protocol !== "socks5") throw new Error("Unsupported proxy protocol");
  return new Agent({ connect: (options, callback) => {
    void SocksClient.createConnection({ proxy: { host: address, port: proxy.port, type: 5, ...(auth ? { userId: auth.username, password: auth.password } : {}) },
      command: "connect", destination: { host: options.hostname, port: Number(options.port || 443) }, timeout: 15000 }).then(({ socket }) => {
      const secure = tlsConnect({ socket, servername: options.hostname, rejectUnauthorized: true });
      const timeout = setTimeout(() => secure.destroy(Object.assign(new Error("TLS connection timeout"), { code: "ETIMEDOUT" })), 15000);
      const failed = (error: Error) => { clearTimeout(timeout); callback(error, null); };
      secure.once("error", failed);
      secure.once("secureConnect", () => { clearTimeout(timeout); secure.removeListener("error", failed); callback(null, secure); });
    }, (error) => callback(error, null));
  } });
}
export function routedFetcher(input: {
  target: PublishingTarget; policy: ConnectionPolicy; proxyName?: string;
  direct: typeof fetch; proxied: typeof fetch; onEvent?: (event: ConnectionEvent) => Promise<void>;
}) {
  let route: "direct" | "proxy" = input.policy.mode === "proxy" ? "proxy" : "direct";
  const emit = (result: string, error?: string) => input.onEvent?.({ route, ...(route === "proxy" ? { proxyName: input.proxyName } : {}), result, ...(error ? { error } : {}) });
  const request: typeof fetch = async (resource, options = {}) => {
    const url = new URL(typeof resource === "string" || resource instanceof URL ? resource : resource.url);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !destinationHosts[input.target].includes(url.hostname)) throw new Error("Destination is not an official service endpoint");
    const method = (options.method ?? "GET").toUpperCase();
    const replaySafe = ["GET", "HEAD"].includes(method) || input.target === "youtube" &&
      (method === "PUT" && new Headers(options.headers).get("Content-Range")?.startsWith("bytes */") ||
      (url.hostname === "oauth2.googleapis.com" || method === "POST" && (url.searchParams.get("uploadType") === "resumable" || url.pathname.endsWith("/thumbnails/set"))));
    const receive = async (send: typeof fetch, init: RequestInit) => {
      const response = await send(resource, init);
      if (!response.body) return response;
      // Publication API responses are small JSON documents. Include body-read failures
      // in delivery classification, including a lost Telegram sendMessage response.
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 2_000_000) throw new Error("Destination response exceeds limit");
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    try {
      let response: Response;
      try { response = await receive(route === "direct" ? input.direct : input.proxied, { ...options, redirect: "error" }); }
      catch (error) {
        await emit("network_error", connectionErrorReason(error));
        if (route !== "direct" || input.policy.mode !== "auto" || !isConnectionError(error) || options.signal?.aborted && options.signal.reason?.name !== "TimeoutError") {
          if (!replaySafe && isConnectionError(error) && !definitelyNotSent(error)) throw new AmbiguousDeliveryError();
          throw error;
        }
        route = "proxy"; await emit("fallback_selected");
        if (!replaySafe && !definitelyNotSent(error)) throw new AmbiguousDeliveryError();
        // The direct timeout must not leave the fallback with an already aborted signal.
        response = await receive(input.proxied, { ...options, redirect: "error", signal: options.signal?.aborted ? AbortSignal.timeout(30000) : options.signal });
      }
      await emit(response.ok ? "connected" : `destination_http_${response.status}`);
      return response;
    } catch (error) {
      if (error instanceof AmbiguousDeliveryError) throw error;
      if (!replaySafe && isConnectionError(error) && !definitelyNotSent(error)) throw new AmbiguousDeliveryError();
      if (isConnectionError(error)) {
        const code = errorCodes(error).find((c) => /^(?:E[A-Z_]+|UND_ERR_.*|TimeoutError)$/.test(c));
        throw Object.assign(new Error(connectionErrorReason(error)), { code });
      }
      throw new Error(connectionErrorReason(error));
    }
  };
  return { fetch: request, getRoute: () => ({ route, proxyName: route === "proxy" ? input.proxyName : undefined }) };
}
export async function publishingTransport(workspaceId: string, raw: unknown, target: PublishingTarget, onEvent?: (event: ConnectionEvent) => Promise<void>) {
  const policy = connectionPolicy(raw);
  const proxy = policy.proxyId ? await loadPublishingProxy(workspaceId, policy.proxyId) : undefined;
  let dispatcher: Dispatcher | undefined;
  const proxied: typeof fetch = async (resource, options) => {
    dispatcher ??= await createProxyDispatcher(proxy!);
    return undiciFetch(resource as any, { ...options, dispatcher } as any) as unknown as Promise<Response>;
  };
  return { ...routedFetcher({ policy, target, proxyName: proxy?.name, direct: fetch, proxied, onEvent }), close: async () => { await dispatcher?.destroy(); } };
}
