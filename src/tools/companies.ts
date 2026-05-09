import { z } from "zod";
import {
  defineTool,
  RefSchema,
  clean,
  refOf,
  tinyCompany,
  tinyPerson,
  tinyDeal,
  tinyActivity,
  getRefName,
} from "./shared.js";
import type { Filter } from "../client/raynet.js";

const COMPANY_STATE = [
  "A_POTENTIAL",
  "B_ACTUAL",
  "C_DEFERRED",
  "D_UNATTRACTIVE",
] as const;
const COMPANY_RATING = ["A", "B", "C"] as const;
const COMPANY_ROLE = [
  "A_SUBSCRIBER",
  "B_PARTNER",
  "C_SUPPLIER",
  "D_RIVAL",
] as const;

const AddressSchema = z.object({
  type: z.string().optional(),
  street: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional(),
  zipCode: z.string().optional(),
  country: z.string().optional(),
  isPrimary: z.boolean().optional(),
});

const CompanyWriteCommon = {
  name: z.string().min(1).max(255),
  rating: z.enum(COMPANY_RATING),
  state: z.enum(COMPANY_STATE),
  role: z.enum(COMPANY_ROLE),
  notice: z.string().max(4000).optional(),
  regNumber: z.string().max(64).optional(),
  taxNumber: z.string().max(64).optional(),
  taxNumber2: z.string().max(64).optional(),
  bankAccount: z.string().max(64).optional(),
  databox: z.string().max(64).optional(),
  birthday: z.string().optional(),
  owner: z.number().int().positive().optional(),
  category: z.number().int().positive().optional(),
  legalForm: z.number().int().positive().optional(),
  paymentTerm: z.number().int().positive().optional(),
  employeesNumber: z.number().int().positive().optional(),
  turnover: z.number().int().positive().optional(),
  economyActivity: z.number().int().positive().optional(),
  companyClassification1: z.number().int().positive().optional(),
  companyClassification2: z.number().int().positive().optional(),
  companyClassification3: z.number().int().positive().optional(),
  contactSource: z.number().int().positive().optional(),
  addresses: z.array(AddressSchema).optional(),
  customFields: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
};

export const searchCompanies = defineTool({
  name: "search_companies",
  description:
    "Search RAYNET CRM accounts (companies). Free-text query covers name, IČO " +
    "(regNumber), DIČ (taxNumber), e-mail domain, etc. Use additional filters to " +
    "narrow by owner, rating, role, state. Returns short matches; call get_company " +
    "for full detail.",
  category: "read",
  scopes: ["crm.read"],
  inputSchema: z.object({
    query: z.string().min(1).optional(),
    ownerUserId: z.number().int().positive().optional(),
    rating: z.enum(COMPANY_RATING).optional(),
    role: z.enum(COMPANY_ROLE).optional(),
    state: z.enum(COMPANY_STATE).optional(),
    onlyValid: z.boolean().default(true),
    limit: z.number().int().min(1).max(50).default(10),
    offset: z.number().int().min(0).default(0),
  }),
  async handler(input, { client }) {
    const filters: Filter[] = [];
    if (input.ownerUserId !== undefined)
      filters.push({ attr: "owner", value: input.ownerUserId });
    if (input.rating) filters.push({ attr: "rating", value: input.rating });
    if (input.role) filters.push({ attr: "role", value: input.role });
    if (input.state) filters.push({ attr: "state", value: input.state });
    else if (input.onlyValid)
      filters.push({ attr: "state", value: "B_ACTUAL" });

    const res = await client.list<Record<string, unknown>>("/company/", {
      ...(input.query !== undefined && { fulltext: input.query }),
      filters,
      limit: input.limit,
      offset: input.offset,
      sortColumn: "name",
      sortDirection: "ASC",
    });
    return {
      query: input.query ?? null,
      totalCount: res.totalCount ?? null,
      offset: input.offset,
      limit: input.limit,
      results: res.data.map(tinyCompany),
    };
  },
});

export const getCompany = defineTool({
  name: "get_company",
  description:
    "Get a RAYNET account. Mode 'brief' returns the profile only; mode 'full' " +
    "additionally fetches primary contacts, open deals, recent activities, and " +
    "upcoming tasks in parallel. Use search_companies first if you don't have an id.",
  category: "read",
  scopes: ["crm.read"],
  inputSchema: z.object({
    companyId: z.number().int().positive(),
    mode: z.enum(["brief", "full"]).default("full"),
    activitiesLimit: z.number().int().min(0).max(20).default(5),
    tasksLimit: z.number().int().min(0).max(20).default(5),
  }),
  async handler(input, { client }) {
    const company = await client.get<Record<string, unknown>>(
      `/company/${input.companyId}/`,
    );
    if (input.mode === "brief") {
      return {
        company: tinyCompany(company),
        owner: getRefName(company["owner"]),
        addresses: company["addresses"] ?? company["primaryAddress"],
        notice: company["notice"],
      };
    }

    const parallel = await client.parallel({
      contacts: () =>
        client.list<Record<string, unknown>>("/person/", {
          filters: [
            {
              attr: "primaryRelationship-company-id",
              value: input.companyId,
            },
          ],
          limit: 10,
          sortColumn: "lastName",
          sortDirection: "ASC",
        }),
      openDeals: () =>
        client.list<Record<string, unknown>>("/businessCase/", {
          filters: [
            { attr: "company", value: input.companyId },
            { attr: "status", op: "EQ", value: "B_ACTIVE" },
          ],
          limit: 10,
        }),
      recentActivities: () =>
        client.list<Record<string, unknown>>("/activity/", {
          filters: [
            { attr: "companyContextFilter", value: input.companyId },
          ],
          limit: input.activitiesLimit,
          sortColumn: "scheduledFrom",
          sortDirection: "DESC",
        }),
      upcomingTasks: () =>
        client.list<Record<string, unknown>>("/task/", {
          filters: [
            { attr: "companyContextFilter", value: input.companyId },
            { attr: "completed", op: "EQ", value: "false" },
          ],
          limit: input.tasksLimit,
          sortColumn: "deadline",
          sortDirection: "ASC",
        }),
    });

    return {
      company: tinyCompany(company),
      owner: getRefName(company["owner"]),
      addresses: company["addresses"] ?? company["primaryAddress"],
      notice: company["notice"],
      contacts: parallel.contacts.ok
        ? parallel.contacts.value.data.map(tinyPerson)
        : [],
      openDeals: parallel.openDeals.ok
        ? parallel.openDeals.value.data.map(tinyDeal)
        : [],
      recentActivities: parallel.recentActivities.ok
        ? parallel.recentActivities.value.data.map(tinyActivity)
        : [],
      upcomingTasks: parallel.upcomingTasks.ok
        ? parallel.upcomingTasks.value.data.map(tinyActivity)
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

const CompanyCreateSchema = z.object(CompanyWriteCommon);
const CompanyUpdateSchema = z
  .object({ companyId: z.number().int().positive() })
  .merge(CompanyCreateSchema.partial());

export const createCompany = defineTool({
  name: "create_company",
  description:
    "Create a new RAYNET account. 'name' is required. Reference fields (owner, " +
    "category, legalForm, …) take RAYNET picklist ids — call search_* tools or " +
    "the picklist endpoints to discover ids first.",
  category: "write",
  scopes: ["crm.contacts.write"],
  inputSchema: CompanyCreateSchema,
  async handler(input, { client }) {
    const body = clean({
      ...input,
      owner: refOf(input.owner),
      category: refOf(input.category),
      legalForm: refOf(input.legalForm),
      paymentTerm: refOf(input.paymentTerm),
      employeesNumber: refOf(input.employeesNumber),
      turnover: refOf(input.turnover),
      economyActivity: refOf(input.economyActivity),
      companyClassification1: refOf(input.companyClassification1),
      companyClassification2: refOf(input.companyClassification2),
      companyClassification3: refOf(input.companyClassification3),
      contactSource: refOf(input.contactSource),
    });
    const created = await client.create<{ id: number }>("/company/", body);
    return { id: created.id, ok: true };
  },
});

export const updateCompany = defineTool({
  name: "update_company",
  description:
    "Update a RAYNET account. Provide companyId and only the fields you want to " +
    "change. Reference fields take ids; passing an empty value clears them on " +
    "RAYNET's side, so omit fields you do not intend to touch.",
  category: "write",
  scopes: ["crm.contacts.write"],
  inputSchema: CompanyUpdateSchema,
  async handler(input, { client }) {
    const { companyId, ...rest } = input;
    const body = clean({
      ...(rest as Record<string, unknown>),
      owner: refOf(rest.owner),
      category: refOf(rest.category),
      legalForm: refOf(rest.legalForm),
      paymentTerm: refOf(rest.paymentTerm),
      employeesNumber: refOf(rest.employeesNumber),
      turnover: refOf(rest.turnover),
      economyActivity: refOf(rest.economyActivity),
      companyClassification1: refOf(rest.companyClassification1),
      companyClassification2: refOf(rest.companyClassification2),
      companyClassification3: refOf(rest.companyClassification3),
      contactSource: refOf(rest.contactSource),
    });
    const updated = await client.update<{ id: number }>(
      `/company/${companyId}/`,
      body,
    );
    return { id: updated.id ?? companyId, ok: true };
  },
});

export const deleteCompany = defineTool({
  name: "delete_company",
  description:
    "DELETE a RAYNET account. This is a destructive operation: related deals, " +
    "activities, and contacts may be affected per RAYNET rules. Requires the " +
    "crm.destructive scope. Pass confirm=true explicitly.",
  category: "destructive",
  scopes: ["crm.destructive"],
  inputSchema: z.object({
    companyId: z.number().int().positive(),
    confirm: z.literal(true).describe("Must be set to true to perform deletion."),
  }),
  async handler(input, { client }) {
    await client.remove(`/company/${input.companyId}/`);
    return { id: input.companyId, deleted: true };
  },
});

export { RefSchema };
