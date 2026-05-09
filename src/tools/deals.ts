import { z } from "zod";
import {
  defineTool,
  clean,
  refOf,
  tinyDeal,
  tinyActivity,
  getRefName,
} from "./shared.js";
import type { Filter } from "../client/raynet.js";

const DEAL_STATUS = ["B_ACTIVE", "E_WIN", "F_LOST", "G_STORNO"] as const;

const DealItemSchema = z.object({
  product: z.number().int().positive().optional(),
  name: z.string().min(1).optional(),
  count: z.number().optional(),
  unit: z.string().optional(),
  unitPrice: z.number().optional(),
  discount: z.number().optional(),
  taxRate: z.number().optional(),
  description: z.string().optional(),
});

const DealWriteCommon = {
  name: z.string().min(1).max(255),
  company: z.number().int().positive(),
  person: z.number().int().positive().optional(),
  owner: z.number().int().positive().optional(),
  businessCasePhase: z.number().int().positive().optional(),
  category: z.number().int().positive().optional(),
  source: z.number().int().positive().optional(),
  project: z.number().int().positive().optional(),
  originLead: z.number().int().positive().optional(),
  estimatedValue: z.number().optional(),
  totalAmount: z.number().optional(),
  exchangeRate: z.number().optional(),
  probability: z.number().min(0).max(100).optional(),
  currency: z.string().max(8).optional(),
  description: z.string().max(8000).optional(),
  validFrom: z.string().optional(),
  businessCaseClassification1: z.number().int().positive().optional(),
  businessCaseClassification2: z.number().int().positive().optional(),
  businessCaseClassification3: z.number().int().positive().optional(),
  customFields: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
};

const DealCreateSchema = z.object({
  ...DealWriteCommon,
  items: z.array(DealItemSchema).optional(),
});
const DealUpdateSchema = z
  .object({ businessCaseId: z.number().int().positive() })
  .merge(z.object(DealWriteCommon).partial());

export const searchDeals = defineTool({
  name: "search_deals",
  description:
    "Search RAYNET deals (business cases). Filter by company, person, owner, " +
    "phase, status, or value range. Status enum: B_ACTIVE (open), E_WIN, F_LOST, " +
    "G_STORNO. Returns short matches; call get_deal for full detail.",
  category: "read",
  scopes: ["crm.read"],
  inputSchema: z.object({
    query: z.string().min(1).optional(),
    companyId: z.number().int().positive().optional(),
    personId: z.number().int().positive().optional(),
    ownerUserId: z.number().int().positive().optional(),
    phaseId: z.number().int().positive().optional(),
    status: z.enum(DEAL_STATUS).optional(),
    minTotalAmount: z.number().optional(),
    maxTotalAmount: z.number().optional(),
    limit: z.number().int().min(1).max(50).default(10),
    offset: z.number().int().min(0).default(0),
  }),
  async handler(input, { client }) {
    const filters: Filter[] = [];
    if (input.companyId !== undefined)
      filters.push({ attr: "company", value: input.companyId });
    if (input.personId !== undefined)
      filters.push({ attr: "person", value: input.personId });
    if (input.ownerUserId !== undefined)
      filters.push({ attr: "owner", value: input.ownerUserId });
    if (input.phaseId !== undefined)
      filters.push({ attr: "businessCasePhase", value: input.phaseId });
    if (input.status) filters.push({ attr: "status", value: input.status });
    if (input.minTotalAmount !== undefined)
      filters.push({ attr: "totalAmount", op: "GE", value: input.minTotalAmount });
    if (input.maxTotalAmount !== undefined)
      filters.push({ attr: "totalAmount", op: "LE", value: input.maxTotalAmount });

    const res = await client.list<Record<string, unknown>>("/businessCase/", {
      ...(input.query !== undefined && { fulltext: input.query }),
      filters,
      limit: input.limit,
      offset: input.offset,
    });
    return {
      query: input.query ?? null,
      totalCount: res.totalCount ?? null,
      offset: input.offset,
      limit: input.limit,
      results: res.data.map(tinyDeal),
    };
  },
});

export const getDeal = defineTool({
  name: "get_deal",
  description:
    "Get a RAYNET deal. Mode 'brief' returns the profile only; mode 'full' " +
    "additionally fetches participants, the phase-change history, and the most " +
    "recent activities linked to the deal.",
  category: "read",
  scopes: ["crm.read"],
  inputSchema: z.object({
    businessCaseId: z.number().int().positive(),
    mode: z.enum(["brief", "full"]).default("full"),
    activitiesLimit: z.number().int().min(0).max(20).default(5),
  }),
  async handler(input, { client }) {
    const deal = await client.get<Record<string, unknown>>(
      `/businessCase/${input.businessCaseId}/`,
    );
    if (input.mode === "brief") {
      return {
        deal: tinyDeal(deal),
        owner: getRefName(deal["owner"]),
        description: deal["description"],
      };
    }

    const parallel = await client.parallel({
      participants: () =>
        client.list<Record<string, unknown>>(
          `/businessCase/${input.businessCaseId}/participants/`,
          { limit: 50 },
        ),
      phaseChanges: () =>
        client.list<Record<string, unknown>>(
          `/businessCase/${input.businessCaseId}/phaseChanges`,
          { limit: 25 },
        ),
      recentActivities: () =>
        client.list<Record<string, unknown>>("/activity/", {
          filters: [{ attr: "businessCase", value: input.businessCaseId }],
          limit: input.activitiesLimit,
          sortColumn: "scheduledFrom",
          sortDirection: "DESC",
        }),
    });
    return {
      deal: tinyDeal(deal),
      owner: getRefName(deal["owner"]),
      description: deal["description"],
      items: deal["items"] ?? null,
      participants: parallel.participants.ok
        ? parallel.participants.value.data.map((p) => ({
            id: p["id"],
            person: getRefName(p["person"]),
            company: getRefName(p["company"]),
            note: p["note"],
            category: getRefName(p["category"]),
          }))
        : [],
      phaseChanges: parallel.phaseChanges.ok
        ? parallel.phaseChanges.value.data.map((c) => ({
            id: c["id"],
            since: c["since"],
            till: c["till"],
            phase: getRefName(c["phase"]),
            user: getRefName(c["user"]),
          }))
        : [],
      recentActivities: parallel.recentActivities.ok
        ? parallel.recentActivities.value.data.map(tinyActivity)
        : [],
      partial: {
        participants: parallel.participants.ok ? null : parallel.participants.error.kind,
        phaseChanges: parallel.phaseChanges.ok ? null : parallel.phaseChanges.error.kind,
        recentActivities: parallel.recentActivities.ok
          ? null
          : parallel.recentActivities.error.kind,
      },
    };
  },
});

export const createDeal = defineTool({
  name: "create_deal",
  description:
    "Create a new RAYNET deal. 'name' and 'company' (id) are required. To create " +
    "a deal with line items in one call, pass items[]; this calls /businessCase/createWithItems.",
  category: "write",
  scopes: ["crm.deals.write"],
  inputSchema: DealCreateSchema,
  async handler(input, { client }) {
    const { items, ...common } = input;
    const body = clean({
      ...(common as Record<string, unknown>),
      company: refOf(common.company),
      person: refOf(common.person),
      owner: refOf(common.owner),
      businessCasePhase: refOf(common.businessCasePhase),
      category: refOf(common.category),
      source: refOf(common.source),
      project: refOf(common.project),
      originLead: refOf(common.originLead),
      businessCaseClassification1: refOf(common.businessCaseClassification1),
      businessCaseClassification2: refOf(common.businessCaseClassification2),
      businessCaseClassification3: refOf(common.businessCaseClassification3),
    });
    if (items && items.length > 0) {
      const created = await client.create<{ id: number }>(
        "/businessCase/createWithItems",
        { ...body, items: items.map((i) => clean({ ...i, product: refOf(i.product) })) },
      );
      return { id: created.id, ok: true, withItems: items.length };
    }
    const created = await client.create<{ id: number }>("/businessCase/", body);
    return { id: created.id, ok: true };
  },
});

export const updateDeal = defineTool({
  name: "update_deal",
  description:
    "Update a RAYNET deal. Provide businessCaseId and only the fields you want " +
    "to change. To change the phase prefer change_deal_phase, which records the " +
    "transition explicitly.",
  category: "write",
  scopes: ["crm.deals.write"],
  inputSchema: DealUpdateSchema,
  async handler(input, { client }) {
    const { businessCaseId, ...rest } = input;
    const body = clean({
      ...(rest as Record<string, unknown>),
      company: refOf(rest.company),
      person: refOf(rest.person),
      owner: refOf(rest.owner),
      businessCasePhase: refOf(rest.businessCasePhase),
      category: refOf(rest.category),
      source: refOf(rest.source),
      project: refOf(rest.project),
      originLead: refOf(rest.originLead),
      businessCaseClassification1: refOf(rest.businessCaseClassification1),
      businessCaseClassification2: refOf(rest.businessCaseClassification2),
      businessCaseClassification3: refOf(rest.businessCaseClassification3),
    });
    const updated = await client.update<{ id: number }>(
      `/businessCase/${businessCaseId}/`,
      body,
    );
    return { id: updated.id ?? businessCaseId, ok: true };
  },
});

export const changeDealPhase = defineTool({
  name: "change_deal_phase",
  description:
    "Move a deal to a new phase. This is a thin wrapper around update_deal that " +
    "submits only the phase change so the transition is easy to audit. Closing a " +
    "deal as won/lost is done by transitioning to the corresponding terminal phase " +
    "configured in RAYNET (the deal's status is derived from its phase).",
  category: "write",
  scopes: ["crm.deals.write"],
  inputSchema: z.object({
    businessCaseId: z.number().int().positive(),
    phaseId: z.number().int().positive(),
    note: z.string().max(2000).optional(),
  }),
  async handler(input, { client }) {
    const body = clean({
      businessCasePhase: { id: input.phaseId },
      description: input.note,
    });
    await client.update(`/businessCase/${input.businessCaseId}/`, body);
    return {
      id: input.businessCaseId,
      phaseId: input.phaseId,
      ok: true,
    };
  },
});

export const deleteDeal = defineTool({
  name: "delete_deal",
  description:
    "DELETE a RAYNET deal. Destructive. Requires crm.destructive scope. " +
    "Pass confirm=true explicitly.",
  category: "destructive",
  scopes: ["crm.destructive"],
  inputSchema: z.object({
    businessCaseId: z.number().int().positive(),
    confirm: z.literal(true),
  }),
  async handler(input, { client }) {
    await client.remove(`/businessCase/${input.businessCaseId}/`);
    return { id: input.businessCaseId, deleted: true };
  },
});
