import { z } from "zod";
import {
  defineTool,
  clean,
  refOf,
  tinyPerson,
  tinyDeal,
  tinyActivity,
  getRefName,
} from "./shared.js";
import type { Filter } from "../client/raynet.js";

const PERSON_GENDER = ["MALE", "FEMALE", "OTHER"] as const;

const ContactInfoSchema = z.object({
  email: z.string().email().optional(),
  email2: z.string().email().optional(),
  phone: z.string().optional(),
  phone2: z.string().optional(),
  mobile: z.string().optional(),
  fax: z.string().optional(),
  www: z.string().optional(),
});

const RelationshipSchema = z.object({
  company: z.number().int().positive().optional(),
  role: z.string().optional(),
  isPrimary: z.boolean().optional(),
});

const PersonWriteCommon = {
  firstName: z.string().min(1).max(120).optional(),
  lastName: z.string().min(1).max(120),
  titleBefore: z.string().max(40).optional(),
  titleAfter: z.string().max(40).optional(),
  salutation: z.string().max(40).optional(),
  gender: z.enum(PERSON_GENDER).optional(),
  birthday: z.string().optional(),
  notice: z.string().max(4000).optional(),
  language: z.string().max(8).optional(),
  maritalStatus: z.string().max(40).optional(),
  keyman: z.boolean().optional(),
  owner: z.number().int().positive().optional(),
  category: z.number().int().positive().optional(),
  contactInfo: ContactInfoSchema.optional(),
  relationship: z
    .array(
      RelationshipSchema.transform((r) =>
        clean({
          ...r,
          company: refOf(r.company),
        }),
      ),
    )
    .optional(),
  customFields: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
};

export const searchContacts = defineTool({
  name: "search_contacts",
  description:
    "Search RAYNET CRM contacts (people). Free-text query covers name, e-mail, " +
    "phone, or company name. Returns short matches; call get_contact for full detail.",
  category: "read",
  scopes: ["crm.read"],
  inputSchema: z.object({
    query: z.string().min(1).optional(),
    companyId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Restrict to people whose primary account is this company id."),
    ownerUserId: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(50).default(10),
    offset: z.number().int().min(0).default(0),
  }),
  async handler(input, { client }) {
    const filters: Filter[] = [];
    if (input.companyId !== undefined)
      filters.push({ attr: "primaryRelationship.company", value: input.companyId });
    if (input.ownerUserId !== undefined)
      filters.push({ attr: "owner", value: input.ownerUserId });

    const res = await client.list<Record<string, unknown>>("/person/", {
      ...(input.query !== undefined && { fulltext: input.query }),
      filters,
      limit: input.limit,
      offset: input.offset,
      sortColumn: "lastName",
      sortDirection: "ASC",
    });
    return {
      query: input.query ?? null,
      totalCount: res.totalCount ?? null,
      offset: input.offset,
      limit: input.limit,
      results: res.data.map(tinyPerson),
    };
  },
});

export const getContact = defineTool({
  name: "get_contact",
  description:
    "Get a RAYNET contact. Mode 'brief' returns the profile only; mode 'full' " +
    "additionally fetches related accounts, open deals, recent activities and " +
    "upcoming tasks linked to the person.",
  category: "read",
  scopes: ["crm.read"],
  inputSchema: z.object({
    personId: z.number().int().positive(),
    mode: z.enum(["brief", "full"]).default("full"),
    activitiesLimit: z.number().int().min(0).max(20).default(5),
    tasksLimit: z.number().int().min(0).max(20).default(5),
  }),
  async handler(input, { client }) {
    const person = await client.get<Record<string, unknown>>(
      `/person/${input.personId}/`,
    );
    if (input.mode === "brief") {
      return {
        contact: tinyPerson(person),
        owner: getRefName(person["owner"]),
        notice: person["notice"],
        relationships: person["relationship"] ?? person["relationships"],
      };
    }

    const parallel = await client.parallel({
      openDeals: () =>
        client.list<Record<string, unknown>>("/businessCase/", {
          filters: [
            { attr: "person", value: input.personId },
            { attr: "state", value: "IN_PROGRESS" },
          ],
          limit: 10,
        }),
      recentActivities: () =>
        client.list<Record<string, unknown>>("/activity/", {
          filters: [{ attr: "person", value: input.personId }],
          limit: input.activitiesLimit,
          sortColumn: "since",
          sortDirection: "DESC",
        }),
      upcomingTasks: () =>
        client.list<Record<string, unknown>>("/task/", {
          filters: [
            { attr: "person", value: input.personId },
            { attr: "completed", value: "false" },
          ],
          limit: input.tasksLimit,
          sortColumn: "deadline",
          sortDirection: "ASC",
        }),
    });
    return {
      contact: tinyPerson(person),
      owner: getRefName(person["owner"]),
      notice: person["notice"],
      relationships: person["relationship"] ?? person["relationships"],
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

const PersonCreateSchema = z.object(PersonWriteCommon);
const PersonUpdateSchema = z
  .object({ personId: z.number().int().positive() })
  .merge(PersonCreateSchema.partial());

export const createContact = defineTool({
  name: "create_contact",
  description:
    "Create a new RAYNET contact. 'lastName' is required. Pass relationship[] " +
    "with a company id to link the contact to an account. Reference fields take ids.",
  category: "write",
  scopes: ["crm.contacts.write"],
  inputSchema: PersonCreateSchema,
  async handler(input, { client }) {
    const body = clean({
      ...input,
      owner: refOf(input.owner),
      category: refOf(input.category),
    });
    const created = await client.create<{ id: number }>("/person/", body);
    return { id: created.id, ok: true };
  },
});

export const updateContact = defineTool({
  name: "update_contact",
  description:
    "Update a RAYNET contact. Provide personId and only the fields you want to " +
    "change. Omit fields you don't intend to touch.",
  category: "write",
  scopes: ["crm.contacts.write"],
  inputSchema: PersonUpdateSchema,
  async handler(input, { client }) {
    const { personId, ...rest } = input;
    const body = clean({
      ...(rest as Record<string, unknown>),
      owner: refOf(rest.owner),
      category: refOf(rest.category),
    });
    const updated = await client.update<{ id: number }>(
      `/person/${personId}/`,
      body,
    );
    return { id: updated.id ?? personId, ok: true };
  },
});

export const deleteContact = defineTool({
  name: "delete_contact",
  description:
    "DELETE a RAYNET contact. Destructive. Requires crm.destructive scope. " +
    "Pass confirm=true explicitly.",
  category: "destructive",
  scopes: ["crm.destructive"],
  inputSchema: z.object({
    personId: z.number().int().positive(),
    confirm: z.literal(true),
  }),
  async handler(input, { client }) {
    await client.remove(`/person/${input.personId}/`);
    return { id: input.personId, deleted: true };
  },
});
