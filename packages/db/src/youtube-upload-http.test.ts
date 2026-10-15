import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { fetch as undiciFetch } from "undici";
import { routedFetcher, type ConnectionEvent } from "./publishing-connection";
import { uploadYoutubeVideo } from "./youtube-upload";

const proxyId = "00000000-0000-0000-0000-000000000001";
const chunkSize = 8 * 1024 * 1024;
const session = (number: number) => `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-${number}`;

// Real HTTP responses exercise Fetch's redirect handling; returning new Response(308)
// from a mock does not reproduce the failure when Google also sends Location.
for (const mode of ["direct", "proxy"] as const) {
  test(`${mode}: a 308 with Location continues the same upload without redirecting or replaying a chunk`, async () => {
    const total = 2 * chunkSize + 16;
    let acknowledged = mode === "proxy" ? chunkSize : 0;
    let currentSession = 1;
    let persistedSession = mode === "proxy" ? session(1) : "";
    let starts = 0;
    const reads: number[] = [];
    const events: ConnectionEvent[] = [];
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url!, "http://fixture.invalid");
        if (request.method === "POST") {
          starts++;
          for await (const _ of request) { /* Consume metadata. */ }
          response.writeHead(200, { Location: session(currentSession), "Content-Length": "0" });
          response.end(); return;
        }
        assert.equal(url.searchParams.get("upload_id"), `session-${currentSession}`);
        assert.equal(persistedSession, session(currentSession), "save the session before using it");
        const range = String(request.headers["content-range"]);
        if (!range.startsWith("bytes */")) {
          const match = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/)!;
          assert.equal(Number(match[1]), acknowledged, "never replay acknowledged bytes");
          let size = 0;
          for await (const bytes of request) size += bytes.length;
          assert.equal(size, Number(match[2]) - acknowledged + 1);
          acknowledged += size;
        }
        if (acknowledged === total) {
          response.writeHead(201, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ id: "confirmed-video" })); return;
        }
        // Google can replace the upload URI in an incomplete/probe response.
        currentSession++;
        const next = new URL(session(currentSession));
        response.writeHead(308, { Range: `bytes=0-${acknowledged - 1}`,
          Location: currentSession === 2 ? `${next.pathname}${next.search}` : next.href, "Content-Length": "0" });
        response.end();
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const localOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send = (async (raw, options) => {
      const url = new URL(String(raw));
      const local = `${localOrigin}${url.pathname}${url.search}`;
      return mode === "direct" ? fetch(local, options) : undiciFetch(local, options as any) as unknown as Promise<Response>;
    }) as typeof fetch;
    const unused = (async () => { throw new Error("Unexpected connection route"); }) as typeof fetch;
    const transport = routedFetcher({ target: "youtube", policy: mode === "direct" ? { mode } : { mode, proxyId },
      direct: mode === "direct" ? send : unused, proxied: mode === "proxy" ? send : unused,
      onEvent: async (event) => { events.push(event); } });
    try {
      const id = await uploadYoutubeVideo({ source: { size: total, read: async (start, end) => {
        reads.push(start); return Buffer.alloc(end - start);
      } }, type: "video/mp4", token: "fixture-token", metadata: {}, session: persistedSession || undefined,
        saveSession: async (value) => { persistedSession = value; }, saveProgress: async () => {},
      }, transport.fetch);
      assert.equal(id, "confirmed-video");
      assert.equal(starts, mode === "direct" ? 1 : 0);
      assert.deepEqual(reads, mode === "direct" ? [0, chunkSize, 2 * chunkSize] : [chunkSize, 2 * chunkSize]);
      assert.equal(events.some((event) => event.result === "network_error"), false);
      assert.equal(events.some((event) => event.result === "destination_http_308"), false);
    } finally {
      server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test("an upload cannot automatically follow a non-resumable redirect", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    response.writeHead(307, { Location: "/unexpected", "Content-Length": "0" }); response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const localOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (async (_raw, options) => fetch(localOrigin, options)) as typeof fetch;
  const transport = routedFetcher({ target: "youtube", policy: { mode: "direct" }, direct: send, proxied: send });
  try {
    await assert.rejects(transport.fetch(session(1), { method: "PUT", headers: { "Content-Range": "bytes */16", "Content-Length": "0" } }), /تغییر مسیر نامعتبر/);
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
