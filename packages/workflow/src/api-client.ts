import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ApiConnection = { baseUrl: string; authType: string; headerName: string | null; token: string };

export function validApiBase(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      isIP(url.hostname.replace(/[\[\]]/g, "")) === 0 && !/^(localhost|.*\.(?:local|internal))$/i.test(url.hostname);
  } catch { return false; }
}

export async function apiRequest(connection: ApiConnection, path: string, method: "GET" | "POST" | "PATCH", body?: unknown,
  idempotencyKey?: string): Promise<unknown> {
  if (!validApiBase(connection.baseUrl) || !path.startsWith("/") || path.startsWith("//") ||
    /(?:^|\/)\.\.?\//.test(path) || /%2e|%2f|%5c/i.test(path)) throw new Error("نشانی API معتبر نیست");
  const base = new URL(connection.baseUrl);
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error("مسیر باید روی همان میزبان اتصال API باشد");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address, family }) => family !== 4 ||
    /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.18\.|198\.19\.|22[4-9]\.|23\d\.|24\d\.|25\d\.)/.test(address))) {
    throw new Error("میزبان API باید نشانی عمومی داشته باشد");
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (connection.authType === "bearer") headers.Authorization = `Bearer ${connection.token}`;
  else if (connection.authType === "api_key" && connection.headerName && /^X-[A-Za-z0-9-]{1,60}$/i.test(connection.headerName))
    headers[connection.headerName] = connection.token;
  else throw new Error("روش احراز هویت API معتبر نیست");
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error", signal: AbortSignal.timeout(15000) });
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 1_000_000) throw new Error("پاسخ API بیش از اندازه بزرگ است");
  const reader = response.body?.getReader();
  let text = "";
  if (reader) {
    const decoder = new TextDecoder(); let size = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 1_000_000) { await reader.cancel(); throw new Error("پاسخ API بیش از اندازه بزرگ است"); }
      text += decoder.decode(value, { stream: true }); }
    text += decoder.decode();
  }
  if (!response.ok) throw new Error(`API پاسخ ${response.status} داد`);
  try { return text ? JSON.parse(text) : {}; } catch { throw new Error("پاسخ API باید JSON باشد"); }
}

export function apiField(value: unknown, path: string): unknown {
  if (path === "$" || !path) return value;
  return path.split(".").filter(Boolean).reduce<unknown>((item, key) =>
    item && typeof item === "object" ? (item as Record<string, unknown>)[key] : undefined, value);
}

export type CommentSourceConfig = { itemsPath: string; idField: string; textField: string;
  contextField?: string; readMode?: string; postId?: string; postIdField?: string; batchLimit?: number; readAll?: boolean };

function arrayPaths(value: unknown, prefix = "$", depth = 0): string[] {
  if (Array.isArray(value)) return [prefix];
  if (!value || typeof value !== "object" || depth >= 3) return [];
  return Object.entries(value as Record<string, unknown>).slice(0, 20).flatMap(([key, item]) =>
    arrayPaths(item, prefix === "$" ? key : `${prefix}.${key}`, depth + 1)).slice(0, 12);
}

export function inspectApiComments(response: unknown, config: CommentSourceConfig) {
  const items = apiField(response, config.itemsPath);
  const availablePaths = arrayPaths(response);
  if (!Array.isArray(items)) throw new Error(
    `مسیر «${config.itemsPath}» آرایهٔ کامنت‌ها نیست. مسیرهای آرایهٔ پاسخ: ${availablePaths.join("، ") || "پیدا نشد"}`);
  const mode = config.readMode ?? "single";
  const postId = String(config.postId ?? "").trim();
  const matching = mode === "post" ? items.filter((item) =>
    String(apiField(item, config.postIdField || "postId") ?? "") === postId) : items;
  const limit = Number.isInteger(config.batchLimit) && Number(config.batchLimit) > 0 && Number(config.batchLimit) <= 5000
    ? Number(config.batchLimit) : 10;
  const selected = matching.slice(0, mode === "single" ? 50 : limit);
  const comments = selected.flatMap((item): Array<{ id: string; text: string; context: string }> => {
    const id = apiField(item, config.idField), text = apiField(item, config.textField);
    if ((typeof id !== "string" && typeof id !== "number") || typeof text !== "string" || !text.trim()) return [];
    const context = apiField(item, config.contextField || "context");
    return [{ id: String(id), text: text.trim(), context: typeof context === "string" ? context : "" }];
  });
  return { rawCount: items.length, matchedCount: matching.length, selectedCount: selected.length,
    validCount: comments.length, comments, availablePaths };
}

/** Fetch successive pages; some APIs enforce a smaller page size than requested. */
export async function readApiComments(connection: ApiConnection, path: string, config: CommentSourceConfig,
  request: typeof apiRequest = apiRequest) {
  const target = config.readAll ? 5000 : config.readMode === "single" ? 50 :
    Math.min(1000, Math.max(1, Number(config.batchLimit ?? 10)));
  const url = new URL(path, "https://api.invalid");
  const firstPage = Math.max(1, Number(url.searchParams.get("PageNumber") ?? 1) || 1);
  const requestedSize = Math.min(100, Math.max(20, target));
  const seen = new Set<string>();
  const collected: unknown[] = [];
  let pagesFetched = 0;
  let availablePaths: string[] = [];
  for (let page = firstPage; page < firstPage + 100 && collected.length < 5000; page++) {
    url.searchParams.set("PageNumber", String(page));
    url.searchParams.set("PageSize", String(requestedSize));
    const response = await request(connection, url.pathname + url.search, "GET");
    const items = apiField(response, config.itemsPath);
    if (!Array.isArray(items)) {
      // Preserve the descriptive path error from the ordinary inspector.
      inspectApiComments(response, config);
      throw new Error("آرایهٔ کامنت‌ها پیدا نشد");
    }
    if (!availablePaths.length) availablePaths = arrayPaths(response);
    pagesFetched++;
    if (!items.length) break;
    let added = 0;
    for (const item of items) {
      const id = apiField(item, config.idField);
      const fingerprint = id == null ? JSON.stringify(item) : String(id);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint); collected.push(item); added++;
    }
    if (!added) break; // An API that ignores pagination returned the same page again.
    const matched = config.readMode === "post" ? collected.filter((item) =>
      String(apiField(item, config.postIdField || "postId") ?? "") === String(config.postId ?? "")).length : collected.length;
    if (!config.readAll && matched >= target) break;
  }
  const result = inspectApiComments(collected, { ...config, itemsPath: "$", batchLimit: target });
  return { ...result, availablePaths, pagesFetched,
    capped: config.readAll === true && (collected.length >= 5000 || pagesFetched >= 100) };
}
