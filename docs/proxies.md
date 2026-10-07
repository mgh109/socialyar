# Publishing proxies

Apply `packages/db/migrations/0007_publishing_proxies.sql` after migration `0006_youtube.sql` before starting the updated API and worker. These are plain SQL migrations; use the deployment's SQL runner, or `psql "$DATABASE_URL" -f packages/db/migrations/0007_publishing_proxies.sql`. No proxy is enabled globally and no service-account credentials are changed by this migration.

In **Settings → پروکسی‌ها**, create any number of named HTTP, HTTPS or SOCKS5 proxies with host, port, optional username/password and active status. The host field contains a hostname or IPv4 address without a URL scheme or port. To prevent using the server as an internal network scanner, proxy hosts must resolve to public IPv4 addresses; loopback, private networks and link-local addresses are rejected. The worker pins the validated proxy address to avoid DNS rebinding. HTTPS proxy and destination TLS certificates remain verified. HTTP and SOCKS5 proxy authentication is not encrypted on the hop to the proxy; use an HTTPS proxy when that hop needs TLS protection.

Credentials are encrypted together using the existing server-side `HOOR_SECRET_KEY`. API and worker must share that key. Responses only expose `hasCredentials`, never the username/password or ciphertext. Leave credential fields empty while editing to preserve them; select the explicit clear-credentials checkbox to remove them. Reported network errors contain fixed descriptions, without the original exception text or proxy URL. Proxy deletion or deactivation causes dependent proxy/auto policies to fail clearly instead of silently changing to a direct route.

Each publication card has its own `config.connection`:

```json
{ "mode": "auto", "proxyId": "saved-proxy-uuid" }
```

- `direct`: official API calls go directly from the worker.
- `proxy`: official API calls use the selected active proxy only.
- `auto`: direct first; switch to the selected proxy only after a recognized network error. HTTP errors, invalid tokens, missing permissions, quota/content errors and certificate failures never trigger fallback.

The policy is copied into the queued publication/YouTube item's settings so later card edits do not silently reroute an already approved item. Eitaa and other unsupported destinations retain their direct connection. YouTube's Google token refresh, resumable upload, thumbnail upload and processing queries all use the selected transport. External source-media download remains a separate, validated ingestion step. Google sign-in/account management and official service authorization remain separate from card routing.

The shared `publishingTransport` API supports YouTube, Telegram and Instagram's official Graph endpoints and can be passed to future service adapters without setting a process-wide dispatcher. The existing native Telegram publisher already uses it. **The native Instagram publication adapter is still not implemented**; this change provides its reusable network settings, transport and destination test without claiming that Instagram publication is operational. The workflow builder displays the selector for a supported destination account/card. Each destination needs its own publication card.

Connection tests are persisted in `connection_checks` and queued in BullMQ's `connection-checks` queue. A dedicated consumer inside the **same worker process that publishes** executes them, including when publication jobs are busy. Run the worker with the same environment/container/network as production publication. The result records status, response time, last-check time, executor, actual route, proxy name and a sanitized failure reason. Worker queue failures and pending tests are never reported as success. Restarting the UI retrieves the last persisted check for each proxy/destination.

A test must receive a recognizable response from the official service endpoint. YouTube tests reach the Google token endpoint, YouTube API and resumable-upload endpoint. Telegram tests reach its Bot API; Instagram tests reach Meta's Graph API. Structured missing-auth responses are accepted as **network reachability only**, with `authorizationVerified=false`; valid OAuth/bot permissions are tested separately through account connection checks. Proxy authentication errors, captive-portal HTML, timeouts, invalid TLS and unavailable-service responses are failures. Tests do not publish content.

For unknown send results, the transport never blindly repeats a write after a reset or response-body failure. YouTube queries the existing resumable session through the newly selected route before sending another chunk. Expired sessions remain errors rather than creating another upload. Telegram's `sendMessage` API provides no idempotency key or API to recover the ID of a response that was lost; those publications are held with `deliveryUnknown=true`, and automatic and schedule-based resends are blocked. Inspect the destination before explicitly creating any replacement item. A confirmed external publication ID also prevents resending if local persistence subsequently fails.

`publication_connection_events` records actual route, proxy name, result, error and timestamp per execution. Reports appear in the run page, calendar publications and YouTube review, and the canvas shows configured routing or the last actual route. Reports never include proxy usernames/passwords. The per-card **بررسی اتصال** button uses the current selected policy; after a failed direct test, the card offers proxy selection/testing in place.

Validation commands:

```sh
pnpm typecheck
pnpm --filter @socialyar/worker exec tsx --test src/publishing-connection.test.ts src/youtube.test.ts
```

The automated tests cover routing, non-network failures, lost responses, status probing, service-response validation, secret redaction, media isolation and deduplication. End-to-end tests of a real proxy require that proxy, the migrated PostgreSQL database, Redis and the running publication worker; no real proxy credentials or service-account authorization are supplied by this repository.
