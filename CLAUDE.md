# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common commands

```bash
npm install
npm run dev          # tsx watch on src/index.ts
npm run build        # tsc -> dist/
npm start            # node dist/index.js (run after build)
npm run typecheck    # tsc --noEmit; this is also `npm run lint`
```

There is no test runner configured. `npm run lint` is just `tsc --noEmit` — there is no ESLint.

Local run requires `.env` (copy from `.env.example`). At minimum set `ADMIN_TOKENS` to a strong value to enable `/admin/*` for tenant onboarding. Tenant credentials persist to `CREDENTIALS_FILE` (default `./data/tenants.json`); set `CREDENTIALS_KEY` (base64-encoded 32 bytes) to encrypt them at rest with AES-256-GCM.

Smoke tests against a running server:
```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/.well-known/mcp
# Register a tenant -> returns a `bearer` shown ONCE; use it as Authorization to /mcp
curl -X POST http://localhost:3000/admin/connect \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"region":"eu","instanceName":"...","username":"...","apiKey":"...","label":"..."}'
```

## Architecture

This is a **business-adapter MCP server** in front of RAYNET CRM, not a 1:1 REST proxy. The whole design hinges on that distinction — the upstream API has 439 endpoints across 26 resources including destructive ones (`merge`, `anonymize`, `bulkDelete`); exposing all of that to Claude would blow the tool budget and hand the model dangerous primitives. Instead a small curated tool set covers exactly three areas: **Contact database** (companies + contacts), **Business** (deals), **Activities** (task / meeting / phoneCall / email / letter / event). Other RAYNET resources are deliberately out of scope.

### Request flow

```
HTTP request -> Express (src/index.ts)
  /admin/*           -> adminAuth (ADMIN_TOKENS)         -> TenantStore CRUD
  /mcp (POST/GET/DEL)-> bearerAuth -> req.tenant         -> handleMcpRequest
                                                            └─ stateless: fresh McpServer + StreamableHTTPServerTransport per request
                                                               └─ tools filtered by tenant.scopes
                                                                  └─ tool.handler({ client: RaynetClient(tenant), logger })
                                                                     └─ undici -> RAYNET REST v2
```

`/mcp` uses **stateless Streamable HTTP** (no `sessionIdGenerator`); each request constructs its own `McpServer` + `StreamableHTTPServerTransport` bound to the authenticated tenant. This is the cross-tenant isolation guarantee — there is no shared MCP session state.

### Tools registry and scopes (src/tools/index.ts)

`ALL_TOOLS` is a flat readonly array. Each tool declares `scopes: string[]` and `pickToolsForScopes(tenant.scopes)` filters by **set inclusion of every required scope**. Scope vocabulary lives in `KNOWN_SCOPES`:

| Scope | Grants |
| --- | --- |
| `crm.read` | all `search_*`, `get_*`, `list_*` |
| `crm.contacts.write` | create/update of companies + contacts |
| `crm.deals.write` | create/update/phase-change of deals |
| `crm.activities.write` | create/update/complete of activities |
| `crm.destructive` | all `delete_*`. Default-off. Tools also require `confirm: true` in the call. |

When adding a new tool: define it with `defineTool(...)` in the appropriate `src/tools/<area>.ts`, export it, then register it in `ALL_TOOLS` in `src/tools/index.ts` (and add it to the `AnyTool` union). The MCP layer uses `t.inputSchema` for both registration shape and re-validation; cross-field constraints with `.refine()` are supported because `unwrapShape` peels `ZodEffects` to reach the underlying object.

### RaynetClient (src/client/raynet.ts) — the safety surface

This is where every guarantee in the README is enforced. Read before changing.

- **Per-tenant concurrency cap of 3** (`MAX_CONCURRENT_PER_TENANT`); RAYNET allows 4, we leave headroom. Queue is in-process — incorrect across multiple replicas. Don't increase the cap without coordinating a shared limiter.
- **Page size capped at 100** (`MAX_PAGE_SIZE`) regardless of caller (`buildUrl` clamps `limit`). RAYNET allows 1000.
- **Never retry on 401.** RAYNET locks the source IP for 60 minutes after 20 wrong logins. `fromUpstreamHttp` surfaces 401 as `unauthorized` immediately and the tool loop does not retry. Do not add retries here.
- **RAYNET REST conventions** (counter-intuitive): `PUT /<collection>/` creates, `POST /<resource>/<id>/` updates. `client.create()` and `client.update()` reflect this — don't "fix" them to standard REST.
- Auth header is HTTP Basic of `username:apiKey` plus an `X-Instance-Name` header — both are required.
- Filter syntax: `attr[OP]=value` (e.g. `name[LIKE_NOCASE]=foo`). `EQ` uses bare `attr=value`. See `FilterOp` and `buildUrl`.
- `client.parallel({...})` runs read-only sub-requests through the same per-tenant limiter and returns `{ ok, value | error }` per key — used by `get_*` tools in `mode=full` to assemble a context object without one failure killing the whole call.
- `rateLimit` (last-seen `X-Ratelimit-*`) is captured per call and logged on each `tool.ok` / `tool.err`.

### Tools layout (src/tools/)

- `shared.ts` — `defineTool`, `RefSchema`/`RefOrIdSchema` (RAYNET ref shape `{ id }`), `clean()` (drops `undefined`/`null` from PUT/POST bodies), `refOf(id)`, `tinyCompany`/`tinyPerson`/`tinyDeal`/`tinyActivity` field-minimizers (project upstream payloads down to small named fields — used everywhere to keep responses small).
- `companies.ts`, `contacts.ts`, `deals.ts`, `activities.ts` — one file per area.
- Activities use a logical type set `["task","meeting","phoneCall","email","letter","event"]`. RAYNET URL paths are inconsistent (`phonecall` lowercase for list/create, `phoneCall` camelCase for detail) — `activityListPath` / `activityItemPath` encapsulate this; do not hand-build activity paths.

### TenantStore (src/auth/store.ts)

File-backed credential store, optionally AES-256-GCM-encrypted with `CREDENTIALS_KEY` (base64 32-byte). Bearer tokens prefixed `rnt_` are minted on register and stored as the JSON object key (`tenants[bearer] = tenant`). The bearer is only returned once from `POST /admin/connect`; revoke via `DELETE /admin/tenants/:id`. Designed for self-hosted single-process deployments — replace with a real secret manager + DB before scaling out.

### Config & errors

- `src/util/config.ts` — `loadConfig()` validates env via Zod; `raynetBaseUrl(region)` resolves region (`cz`/`sk`/`com`/`eu`) to its REST base.
- `src/util/errors.ts` — `ToolError(kind, message, { hint, details })` with stable `kind` strings (`unauthorized`, `not_found`, `rate_limited`, `upstream_error`, …). `fromUpstreamHttp(status, body, ctx)` is the single mapper from RAYNET HTTP responses; tool handlers should `throw new ToolError(...)` for their own validation failures rather than throwing raw `Error`s — the MCP layer wraps unknown errors as `internal`.

### TypeScript settings worth knowing

`tsconfig.json` sets `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. The repo is ESM (`"type": "module"`, `module: NodeNext`) — **always use `.js` extensions in relative imports** even when importing `.ts` files (e.g. `import { ... } from "./shared.js"`). The build emits to `dist/`.

## Reference

`documentation/api/openapi.json` is the source of truth for RAYNET endpoint paths and filter attribute names — consult it when adding tools rather than guessing path segments.
