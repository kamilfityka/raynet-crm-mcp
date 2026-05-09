import { request, Agent } from "undici";
import { ToolError, fromUpstreamHttp } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import type { Tenant } from "../auth/store.js";
import { raynetBaseUrl } from "../util/config.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PAGE_SIZE = 100;
const MAX_CONCURRENT_PER_TENANT = 3;

/**
 * RAYNET enforces:
 *   - 24,000 req/day per instance
 *   - 4 concurrent connections (we self-limit to 3 to leave headroom)
 *   - 20 wrong logins -> 60-min IP block (so we NEVER retry on 401)
 */
const agent = new Agent({
  connect: { timeout: 10_000 },
  bodyTimeout: DEFAULT_TIMEOUT_MS,
  headersTimeout: DEFAULT_TIMEOUT_MS,
  keepAliveTimeout: 30_000,
});

const concurrencyByTenant = new Map<string, number>();
const queueByTenant = new Map<string, Array<() => void>>();

async function withConcurrencyLimit<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const inflight = concurrencyByTenant.get(tenantId) ?? 0;
  if (inflight >= MAX_CONCURRENT_PER_TENANT) {
    await new Promise<void>((resolve) => {
      const q = queueByTenant.get(tenantId) ?? [];
      q.push(resolve);
      queueByTenant.set(tenantId, q);
    });
  }
  concurrencyByTenant.set(tenantId, (concurrencyByTenant.get(tenantId) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    concurrencyByTenant.set(tenantId, (concurrencyByTenant.get(tenantId) ?? 1) - 1);
    const q = queueByTenant.get(tenantId);
    const next = q?.shift();
    if (next) next();
  }
}

export type FilterOp =
  | "EQ"
  | "NE"
  | "LT"
  | "LE"
  | "GT"
  | "GE"
  | "LIKE"
  | "LIKE_NOCASE"
  | "IN"
  | "NOT_IN";

export type Filter = {
  attr: string;
  op?: FilterOp;
  value: string | number;
};

export type ListQuery = {
  fulltext?: string;
  offset?: number;
  limit?: number;
  sortColumn?: string;
  sortDirection?: "ASC" | "DESC";
  filters?: Filter[];
  /** Extra free-form query params (escape hatch). */
  extra?: Record<string, string | number | boolean>;
};

export type RaynetListResponse<T> = {
  data: T[];
  totalCount?: number;
  offset?: number;
  limit?: number;
};

export type RateLimitState = {
  limit?: number;
  remaining?: number;
  resetEpoch?: number;
};

export class RaynetClient {
  private readonly tenant: Tenant;
  private readonly logger: Logger;
  private readonly baseUrl: string;
  private readonly authHeader: string;
  rateLimit: RateLimitState = {};

  constructor(tenant: Tenant, logger: Logger) {
    this.tenant = tenant;
    this.logger = logger.child({ tenantId: tenant.id });
    this.baseUrl = raynetBaseUrl(tenant.region);
    this.authHeader =
      "Basic " +
      Buffer.from(`${tenant.username}:${tenant.apiKey}`).toString("base64");
  }

  async list<T>(path: string, query: ListQuery = {}): Promise<RaynetListResponse<T>> {
    const url = this.buildUrl(path, query);
    const json = await this.fetchJson("GET", url);
    return this.normalizeList<T>(json, query);
  }

  async get<T>(path: string): Promise<T> {
    const json = await this.fetchJson("GET", this.buildUrl(path));
    if (json && typeof json === "object" && "data" in json) {
      return (json as { data: T }).data;
    }
    return json as T;
  }

  /**
   * Execute several read-only requests in parallel while respecting the
   * per-tenant concurrency cap. Failures of any sub-request surface as the
   * `error` field; callers decide whether the missing piece is fatal.
   */
  async parallel<T extends Record<string, () => Promise<unknown>>>(
    jobs: T,
  ): Promise<{
    [K in keyof T]:
      | { ok: true; value: Awaited<ReturnType<T[K]>> }
      | { ok: false; error: ToolError };
  }> {
    const entries = Object.entries(jobs);
    const results = await Promise.all(
      entries.map(async ([k, fn]) => {
        try {
          return [k, { ok: true as const, value: await fn() }] as const;
        } catch (err) {
          const e =
            err instanceof ToolError
              ? err
              : new ToolError("internal", (err as Error).message);
          return [k, { ok: false as const, error: e }] as const;
        }
      }),
    );
    return Object.fromEntries(results) as never;
  }

  private buildUrl(path: string, query: ListQuery = {}): string {
    const url = new URL(this.baseUrl + ensureLeading(path));
    if (query.fulltext) url.searchParams.set("fulltext", query.fulltext);
    if (typeof query.offset === "number")
      url.searchParams.set("offset", String(query.offset));
    if (typeof query.limit === "number") {
      url.searchParams.set(
        "limit",
        String(Math.max(1, Math.min(MAX_PAGE_SIZE, query.limit))),
      );
    }
    if (query.sortColumn) url.searchParams.set("sortColumn", query.sortColumn);
    if (query.sortDirection) url.searchParams.set("sortDirection", query.sortDirection);
    for (const f of query.filters ?? []) {
      const op = f.op ?? "EQ";
      const key = op === "EQ" ? f.attr : `${f.attr}[${op}]`;
      url.searchParams.set(key, String(f.value));
    }
    for (const [k, v] of Object.entries(query.extra ?? {})) {
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async fetchJson(method: string, url: string): Promise<unknown> {
    return withConcurrencyLimit(this.tenant.id, async () => {
      const started = Date.now();
      const res = await request(url, {
        method: method as "GET" | "POST" | "PUT" | "DELETE",
        dispatcher: agent,
        headers: {
          authorization: this.authHeader,
          "x-instance-name": this.tenant.instanceName,
          accept: "application/json",
          "user-agent": "raynet-crm-mcp/0.1",
        },
        bodyTimeout: DEFAULT_TIMEOUT_MS,
        headersTimeout: DEFAULT_TIMEOUT_MS,
      }).catch((err: Error) => {
        throw new ToolError("timeout", `RAYNET request failed: ${err.message}`);
      });

      this.captureRateLimit(res.headers);
      const text = await res.body.text();
      const elapsed = Date.now() - started;

      this.logger.debug(
        {
          url: redactUrl(url),
          status: res.statusCode,
          elapsed,
          remaining: this.rateLimit.remaining,
        },
        "raynet.request",
      );

      if (res.statusCode >= 200 && res.statusCode < 300) {
        return text ? JSON.parse(text) : null;
      }

      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON; keep as text
      }
      throw fromUpstreamHttp(res.statusCode, parsed, `${method} ${redactUrl(url)}`);
    });
  }

  private captureRateLimit(headers: Record<string, string | string[] | undefined>): void {
    const limit = headerNumber(headers["x-ratelimit-limit"]);
    const remaining = headerNumber(headers["x-ratelimit-remaining"]);
    const reset = headerNumber(headers["x-ratelimit-reset"]);
    if (limit !== undefined) this.rateLimit.limit = limit;
    if (remaining !== undefined) this.rateLimit.remaining = remaining;
    if (reset !== undefined) this.rateLimit.resetEpoch = reset;
  }

  private normalizeList<T>(json: unknown, query: ListQuery): RaynetListResponse<T> {
    const obj = (json && typeof json === "object" ? json : {}) as Record<
      string,
      unknown
    >;
    const data = Array.isArray(obj["data"]) ? (obj["data"] as T[]) : [];
    const totalCount =
      typeof obj["totalCount"] === "number" ? (obj["totalCount"] as number) : undefined;
    const out: RaynetListResponse<T> = { data };
    if (totalCount !== undefined) out.totalCount = totalCount;
    if (query.offset !== undefined) out.offset = query.offset;
    if (query.limit !== undefined) out.limit = query.limit;
    return out;
  }
}

function ensureLeading(p: string): string {
  return p.startsWith("/") ? p : "/" + p;
}

function headerNumber(v: string | string[] | undefined): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    return url.pathname + (url.search ? "?" + url.searchParams.toString() : "");
  } catch {
    return u;
  }
}
