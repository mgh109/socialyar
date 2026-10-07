import { test } from "node:test";
import assert from "node:assert/strict";
import { routedFetcher, connectionPolicy, AmbiguousDeliveryError, connectionErrorReason, checkDestination, uploadYoutubeVideo,
  validateProxyHost, createProxyDispatcher, encryptSecret, type ConnectionEvent } from "@socialyar/db";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
const proxyId = "00000000-0000-0000-0000-000000000001";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const network = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error("details must remain private"), { code }) });

test("auto falls back for a read network failure and records the actual route", async () => {
  const events: ConnectionEvent[] = []; let proxies = 0;
  const t = routedFetcher({ target: "telegram", policy: { mode: "auto", proxyId }, proxyName: "work-proxy",
    direct: (async () => { throw network("ENOTFOUND"); }) as typeof fetch,
    proxied: (async () => { proxies++; return json({ ok: true }); }) as typeof fetch,
    onEvent: async (e) => { events.push(e); } });
  assert.equal((await t.fetch("https://api.telegram.org/bot0:invalid/getMe")).status, 200);
  assert.equal(proxies, 1); assert.equal(t.getRoute().proxyName, "work-proxy");
  assert.deepEqual(events.map((e) => e.result), ["network_error", "fallback_selected", "connected"]);
});
test("token, permission, content and HTTP server failures never change route", async () => {
  for (const status of [400,401,403,429,500,503]) {
    let proxies = 0;
    const t = routedFetcher({ target: "youtube", policy: { mode: "auto", proxyId }, direct: (async () => json({ error: { message: "invalid credentials" } }, status)) as typeof fetch,
      proxied: (async () => { proxies++; return json({}); }) as typeof fetch });
    assert.equal((await t.fetch("https://www.googleapis.com/youtube/v3/videos?id=test")).status, status);
    assert.equal(proxies, 0); assert.equal(t.getRoute().route, "direct");
  }
});
test("application and certificate failures never trigger automatic fallback", async () => {
  for (const error of [new Error("Invalid token"), network("CERT_HAS_EXPIRED")]) {
    let proxies = 0;
    const t = routedFetcher({ target: "instagram", policy: { mode: "auto", proxyId }, direct: (async () => { throw error; }) as typeof fetch,
      proxied: (async () => { proxies++; return json({}); }) as typeof fetch });
    await assert.rejects(t.fetch("https://graph.facebook.com/me")); assert.equal(proxies, 0);
  }
});
test("proxy-only never sends directly and direct-only never uses the proxy", async () => {
  let directs = 0; let proxies = 0;
  const functions = { target: "telegram" as const, direct: (async () => { directs++; return json({}); }) as typeof fetch,
    proxied: (async () => { proxies++; return json({}); }) as typeof fetch };
  await routedFetcher({ ...functions, policy: { mode: "proxy", proxyId } }).fetch("https://api.telegram.org/bot0:invalid/getMe");
  assert.equal(directs, 0); assert.equal(proxies, 1);
  await routedFetcher({ ...functions, policy: { mode: "direct" } }).fetch("https://api.telegram.org/bot0:invalid/getMe");
  assert.equal(directs, 1); assert.equal(proxies, 1);
});
test("ambiguous Telegram sends are held rather than resent via proxy", async () => {
  let proxies = 0;
  const t = routedFetcher({ target: "telegram", policy: { mode: "auto", proxyId }, direct: (async () => { throw network("ECONNRESET"); }) as typeof fetch,
    proxied: (async () => { proxies++; return json({ ok: true }); }) as typeof fetch });
  await assert.rejects(t.fetch("https://api.telegram.org/bot0:invalid/sendMessage", { method: "POST", body: "{}" }), AmbiguousDeliveryError);
  assert.equal(proxies, 0);
});
test("lost Telegram response body is also classified as unknown delivery", async () => {
  let proxies = 0;
  const response = () => new Response(new ReadableStream({ start(controller) { controller.error(network("ECONNRESET")); } }));
  const t = routedFetcher({ target: "telegram", policy: { mode: "auto", proxyId }, direct: (async () => response()) as typeof fetch,
    proxied: (async () => { proxies++; return json({}); }) as typeof fetch });
  await assert.rejects(t.fetch("https://api.telegram.org/bot0:invalid/sendMessage", { method: "POST" }), AmbiguousDeliveryError); assert.equal(proxies, 0);
});
test("definite pre-send failure can send via proxy; proxy reset remains unknown", async () => {
  let proxies = 0;
  const t = routedFetcher({ target: "telegram", policy: { mode: "auto", proxyId }, direct: (async () => { throw network("ECONNREFUSED"); }) as typeof fetch,
    proxied: (async () => { proxies++; throw network("ECONNRESET"); }) as typeof fetch });
  await assert.rejects(t.fetch("https://api.telegram.org/bot0:invalid/sendMessage", { method: "POST" }), AmbiguousDeliveryError); assert.equal(proxies, 1);
});
test("an uncertain YouTube chunk is probed on the proxy before any replay", async () => {
  const session = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=known"; const ranges: string[] = [];
  const t = routedFetcher({ target: "youtube", policy: { mode: "auto", proxyId }, direct: (async (_url, options) => {
    if (options?.method === "POST") return new Response(null, { headers: { location: session } });
    throw network("ECONNRESET");
  }) as typeof fetch,
    proxied: (async (_url, options) => { const range = new Headers(options?.headers).get("Content-Range")!; ranges.push(range);
      if (range === "bytes */16") return json({ id: "already-uploaded" }); throw new Error("Must not resend bytes"); }) as typeof fetch });
  const id = await uploadYoutubeVideo({ bytes: Buffer.alloc(16), type: "video/mp4", token: "fake",
    metadata: {}, saveSession: async () => {}, saveProgress: async () => {} }, t.fetch);
  assert.equal(id, "already-uploaded"); assert.deepEqual(ranges, ["bytes */16"]);
});
test("proxy errors redact URLs, usernames and passwords, including nested causes", () => {
  const error = new TypeError("fetch failed", { cause: new Error("Proxy response (407): http://secret-user:secret-pass@proxy.example") });
  const reason = connectionErrorReason(error); assert.match(reason, /احراز هویت/); assert.ok(!reason.includes("secret")); assert.ok(!reason.includes("proxy.example"));
});
test("destination tests reject captive portals and unavailable services", async () => {
  const portal = await checkDestination("telegram", (async () => new Response("<html>login</html>")) as typeof fetch);
  assert.equal(portal.reachable, false);
  const unavailable = await checkDestination("instagram", (async () => json({ error: "upstream unavailable" }, 503)) as typeof fetch);
  assert.equal(unavailable.reachable, false);
});
test("service-specific missing-auth responses verify service reachability separately from authorization", async () => {
  const telegram = await checkDestination("telegram", (async () => json({ ok: false, description: "Unauthorized" }, 401)) as typeof fetch);
  assert.equal(telegram.reachable, true); assert.equal(telegram.authorizationVerified, false);
  const google = await checkDestination("youtube", (async () => json({ error: { message: "Missing auth" } }, 401)) as typeof fetch);
  assert.equal(google.reachable, true); assert.equal(google.checks.length, 3);
});
test("routing cannot follow redirects or send credentials to an unrelated host", async () => {
  let sent = 0;
  const t = routedFetcher({ target: "youtube", policy: { mode: "direct" }, direct: (async (_url, options) => { sent++; assert.equal(options?.redirect, "error"); return json({}); }) as typeof fetch,
    proxied: fetch });
  await assert.rejects(t.fetch("https://example.com/steal-token"), /official service/); assert.equal(sent, 0);
  await t.fetch("https://www.googleapis.com/youtube/v3/videos"); assert.equal(sent, 1);
});
test("connection policies require a saved proxy and prevent private-network proxy scans", async () => {
  assert.deepEqual(connectionPolicy(undefined), { mode: "direct" });
  assert.throws(() => connectionPolicy({ mode: "auto" }), /saved proxy/);
  assert.throws(() => connectionPolicy({ mode: "other" }), /Invalid/);
  await assert.rejects(validateProxyHost("127.0.0.1"), /public IPv4/);
  await assert.rejects(validateProxyHost("user:password@host"), /Invalid/);
});
test("HTTP proxy authentication is sent only to the tunnel endpoint and 407 stays a failure", async () => {
  const server = createHttpServer(); let authorization = "";
  server.on("connect", (request, socket) => {
    authorization = String(request.headers["proxy-authorization"]);
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const previous = process.env.HOOR_SECRET_KEY; process.env.HOOR_SECRET_KEY = Buffer.alloc(32, 1).toString("base64");
  const agent = await createProxyDispatcher({ id: proxyId, name: "test", protocol: "http", host: "test-proxy.example", port: (server.address() as AddressInfo).port,
    authEnc: encryptSecret(JSON.stringify({ username: "test-user", password: "test-password" })), isActive: true }, async () => "127.0.0.1");
  try {
    await assert.rejects(fetch("https://www.googleapis.com/youtube/v3/channels", { dispatcher: agent, signal: AbortSignal.timeout(5000) } as any), (error: unknown) => {
      assert.match(connectionErrorReason(error), /احراز هویت/); assert.ok(!connectionErrorReason(error).includes("test-password")); return true;
    });
    assert.equal(authorization, `Basic ${Buffer.from("test-user:test-password").toString("base64")}`);
  } finally { await agent.destroy(); await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.HOOR_SECRET_KEY; else process.env.HOOR_SECRET_KEY = previous; }
});
test("SOCKS5 authentication failure does not count as destination access", async () => {
  let attempted = false;
  const server = createTcpServer((socket) => {
    socket.once("data", () => {
      socket.write(Buffer.from([5,2]));
      socket.once("data", () => { attempted = true; socket.end(Buffer.from([1,1])); });
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const previous = process.env.HOOR_SECRET_KEY; process.env.HOOR_SECRET_KEY = Buffer.alloc(32, 1).toString("base64");
  const agent = await createProxyDispatcher({ id: proxyId, name: "test", protocol: "socks5", host: "test-proxy.example", port: (server.address() as AddressInfo).port,
    authEnc: encryptSecret(JSON.stringify({ username: "test-user", password: "test-password" })), isActive: true }, async () => "127.0.0.1");
  try {
    await assert.rejects(fetch("https://api.telegram.org/bot0:invalid/getMe", { dispatcher: agent, signal: AbortSignal.timeout(5000) } as any), (error: unknown) => {
      assert.match(connectionErrorReason(error), /احراز هویت/); return true;
    }); assert.equal(attempted, true);
  } finally { await agent.destroy(); await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.HOOR_SECRET_KEY; else process.env.HOOR_SECRET_KEY = previous; }
});
