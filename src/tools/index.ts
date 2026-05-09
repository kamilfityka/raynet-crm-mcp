import { z } from "zod";
import type { RaynetClient, Filter } from "../client/raynet.js";
import { ToolError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";

export type ToolContext = {
  client: RaynetClient;
  logger: Logger;
};

export type Tool<I extends z.ZodTypeAny, O> = {
  name: string;
  description: string;
  inputSchema: I;
  category: "read" | "write" | "destructive";
  scopes: string[];
  handler: (input: z.infer<I>, ctx: ToolContext) => Promise<O>;
};

export function defineTool<I extends z.ZodTypeAny, O>(t: Tool<I, O>): Tool<I, O> {
  return t;
}

/* ------------------------- helpers ------------------------- */

function takeFirst<T>(arr: T[] | undefined, n: number): T[] {
  if (!arr) return [];
  return arr.slice(0, n);
}

function tinyPerson(p: Record<string, unknown>): Record<string, unknown> {
  return {
    id: p["id"],
    firstName: p["firstName"],
    lastName: p["lastName"],
    titleBefore: p["titleBefore"],
    titleAfter: p["titleAfter"],
    primaryRole: p["role"],
    primaryAccountId: getRefId(p["primaryRelationship"]),
    primaryAccountName: getRefName(p["primaryRelationship"]),
    contact: p["contactInfo"] ?? p["contact"],
  };
}

function tinyCompany(c: Record<string, unknown>): Record<string, unknown> {
  return {
    id: c["id"],
    name: c["name"],
    state: c["state"],
    primaryAddress: c["primaryAddress"],
    rating: c["rating"],
    owner: getRefName(c["owner"]),
    category: getRefName(c["category"]),
  };
}

function tinyDeal(d: Record<string, unknown>): Record<string, unknown> {
  return {
    id: d["id"],
    name: d["name"],
    code: d["code"],
    state: d["state"],
    phase: getRefName(d["phase"]),
    priceFinal: d["priceFinal"],
    currency: d["currency"],
    owner: getRefName(d["owner"]),
    company: getRefName(d["company"]),
    person: getRefName(d["person"]),
    closeDate: d["closeDate"] ?? d["closingDate"],
    successProbability: d["successProbability"],
  };
}

function tinyTask(t: Record<string, unknown>): Record<string, unknown> {
  return {
    id: t["id"],
    subject: t["subject"],
    deadline: t["deadline"],
    status: t["status"],
    priority: t["priority"],
    owner: getRefName(t["owner"]),
    company: getRefName(t["company"]),
    person: getRefName(t["person"]),
    businessCase: getRefName(t["businessCase"]),
  };
}

function getRefId(v: unknown): unknown {
  if (v && typeof v === "object" && "id" in v) return (v as { id: unknown }).id;
  return undefined;
}

function getRefName(v: unknown): unknown {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return o["name"] ?? o["fullName"] ?? o["label"] ?? o["id"];
  }
  return undefined;
}

/* ------------------------- tools ------------------------- */

export const searchCompanies = defineTool({
  name: "search_companies",
  description:
    "Search RAYNET CRM accounts (companies) by free-text query, name, regNumber " +
    "(IČO), VAT id (DIČ), or email domain. Returns a short list of matches with " +
    "minimal fields. Use get_company_context to fetch full details for one match.",
  category: "read",
  scopes: ["crm.read"],
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe("Free-text query: company name, IČO, DIČ, e-mail domain, etc."),
    limit: z.number().int().min(1).max(25).default(10),
    onlyValid: z
      .boolean()
      .default(true)
      .describe("If true, exclude soft-deleted/invalid accounts."),
  }),
  async handler(input, { client }) {
    const filters = input.onlyValid
      ? [{ attr: "state", op: "EQ" as const, value: "ACTIVE" }]
      : [];
    const res = await client.list<Record<string, unknown>>("/company/", {
      fulltext: input.query,
      limit: input.limit,
      filters,
      sortColumn: "name",
      sortDirection: "ASC",
    });
    return {
      query: input.query,
      totalCount: res.totalCount ?? null,
      results: res.data.map(tinyCompany),
    };
  },
});

export const searchContacts = defineTool({
  name: "search_contacts",
  description:
    "Search RAYNET CRM contacts (people) by free-text query: name, e-mail, " +
    "phone, or company name. Returns a short list of matches.",
  category: "read",
  scopes: ["crm.read"],
  inputSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  async handler(input, { client }) {
    const res = await client.list<Record<string, unknown>>("/person/", {
      fulltext: input.query,
      limit: input.limit,
      sortColumn: "lastName",
      sortDirection: "ASC",
    });
    return {
      query: input.query,
      totalCount: res.totalCount ?? null,
      results: res.data.map(tinyPerson),
    };
  },
});

export const getCompanyContext = defineTool({
  name: "get_company_context",
  description:
    "Get a consolidated view of a single RAYNET account: profile, primary " +
    "contacts, open deals, recent activities, and upcoming tasks. Use " +
    "search_companies first if you don't know the id.",
  category: "read",
  scopes: ["crm.read"],
  inputSchema: z.object({
    companyId: z.number().int().positive(),
    activitiesLimit: z.number().int().min(0).max(20).default(5),
    tasksLimit: z.number().int().min(0).max(20).default(5),
  }),
  async handler(input, { client }) {
    const company = await client.get<Record<string, unknown>>(
      `/company/${input.companyId}/`,
    );

    const parallel = await client.parallel({
      contacts: () =>
        client.list<Record<string, unknown>>("/person/", {
          filters: [
            { attr: "primaryRelationship.company", op: "EQ", value: input.companyId },
          ],
          limit: 10,
          sortColumn: "lastName",
          sortDirection: "ASC",
        }),
      openDeals: () =>
        client.list<Record<string, unknown>>("/businessCase/", {
          filters: [
            { attr: "company", op: "EQ", value: input.companyId },
            { attr: "state", op: "EQ", value: "IN_PROGRESS" },
          ],
          limit: 10,
          sortColumn: "closeDate",
          sortDirection: "ASC",
        }),
      recentActivities: () =>
        client.list<Record<string, unknown>>("/activity/", {
          filters: [{ attr: "company", op: "EQ", value: input.companyId }],
          limit: input.activitiesLimit,
          sortColumn: "since",
          sortDirection: "DESC",
        }),
      upcomingTasks: () =>
        client.list<Record<string, unknown>>("/task/", {
          filters: [
            { attr: "company", op: "EQ", value: input.companyId },
            { attr: "status", op: "NE", value: "DONE" },
          ],
          limit: input.tasksLimit,
          sortColumn: "deadline",
          sortDirection: "ASC",
        }),
    });

    return {
      company: tinyCompany(company),
      raw: {
        owner: getRefName(company["owner"]),
        addresses: company["addresses"] ?? company["primaryAddress"],
        regNumber: company["regNumber"],
        taxNumber: company["taxNumber"],
        rating: company["rating"],
        notice: company["notice"],
      },
      contacts: takeFirst(parallel.contacts.ok ? parallel.contacts.value.data : [], 10).map(
        tinyPerson,
      ),
      openDeals: takeFirst(
        parallel.openDeals.ok ? parallel.openDeals.value.data : [],
        10,
      ).map(tinyDeal),
      recentActivities: parallel.recentActivities.ok
        ? parallel.recentActivities.value.data.map((a) => ({
            id: a["id"],
            type: a["category"] ?? a["activityType"],
            subject: a["subject"],
            since: a["since"],
            till: a["till"],
            owner: getRefName(a["owner"]),
          }))
        : [],
      upcomingTasks: parallel.upcomingTasks.ok
        ? parallel.upcomingTasks.value.data.map(tinyTask)
        : [],
      partial: {
        contacts: parallel.contacts.ok ? null : parallel.contacts.error.kind,
        openDeals: parallel.openDeals.ok ? null : parallel.openDeals.error.kind,
        recentActivities: parallel.recentActivities.ok
          ? null
          : parallel.recentActivities.error.kind,
        upcomingTasks: parallel.upcomingTasks.ok
          ? null
          : parallel.upcomingTasks.error.kind,
      },
    };
  },
});

export const listUpcomingTasks = defineTool({
  name: "list_upcoming_tasks",
  description:
    "List the current user's open RAYNET tasks ordered by deadline. By default " +
    "only tasks with deadline in the next 14 days and status != DONE are returned.",
  category: "read",
  scopes: ["crm.read"],
  inputSchema: z.object({
    daysAhead: z.number().int().min(0).max(90).default(14),
    ownerUserId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Filter to a specific owner. Omit to fetch tasks for any owner."),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  async handler(input, { client }) {
    const now = new Date();
    const until = new Date(now.getTime() + input.daysAhead * 86_400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const filters: Filter[] = [
      { attr: "status", op: "NE", value: "DONE" },
      { attr: "deadline", op: "GE", value: fmt(now) },
      { attr: "deadline", op: "LE", value: fmt(until) },
    ];
    if (input.ownerUserId !== undefined) {
      filters.push({ attr: "owner", op: "EQ", value: input.ownerUserId });
    }

    const res = await client.list<Record<string, unknown>>("/task/", {
      filters,
      limit: input.limit,
      sortColumn: "deadline",
      sortDirection: "ASC",
    });
    return {
      windowFrom: fmt(now),
      windowTo: fmt(until),
      totalCount: res.totalCount ?? null,
      tasks: res.data.map(tinyTask),
    };
  },
});

export const ALL_TOOLS = [
  searchCompanies,
  searchContacts,
  getCompanyContext,
  listUpcomingTasks,
] as const;

export type AnyTool = (typeof ALL_TOOLS)[number];

export function pickToolsForScopes(scopes: string[]): AnyTool[] {
  const set = new Set(scopes);
  return ALL_TOOLS.filter((t) => t.scopes.every((s) => set.has(s)));
}

export { ToolError };
