import { z } from "zod";
import {
  defineTool,
  clean,
  refOf,
  tinyActivity,
  ACTIVITY_TYPES,
  activityListPath,
  activityItemPath,
  type ActivityType,
} from "./shared.js";
import type { Filter } from "../client/raynet.js";

const ACTIVITY_PRIORITY = ["LOW", "NORMAL", "HIGH"] as const;

const ActivityWriteCommon = {
  title: z.string().min(1).max(255),
  priority: z.enum(ACTIVITY_PRIORITY).default("NORMAL"),
  owner: z.number().int().positive(),
  description: z.string().max(8000).optional(),
  solution: z.string().max(8000).optional(),
  scheduledFrom: z
    .string()
    .optional()
    .describe("Start, ISO8601 or 'yyyy-MM-dd HH:mm'."),
  scheduledTill: z.string().optional(),
  completed: z.boolean().optional(),
  company: z.number().int().positive().optional(),
  person: z.number().int().positive().optional(),
  businessCase: z.number().int().positive().optional(),
  project: z.number().int().positive().optional(),
  offer: z.number().int().positive().optional(),
  salesOrder: z.number().int().positive().optional(),
  category: z.number().int().positive().optional(),
  tags: z.array(z.string()).optional(),
};

const ActivityCreateSchema = z
  .object({
    type: z.enum(ACTIVITY_TYPES),
    deadline: z
      .string()
      .optional()
      .describe("Required for type=task. ISO8601 or 'yyyy-MM-dd HH:mm'."),
    ...ActivityWriteCommon,
  })
  .refine((v) => v.type !== "task" || !!v.deadline, {
    path: ["deadline"],
    message: "deadline is required when type=task",
  });

const ActivityUpdateSchema = z
  .object({
    type: z.enum(ACTIVITY_TYPES),
    activityId: z.number().int().positive(),
    deadline: z.string().optional(),
  })
  .merge(z.object(ActivityWriteCommon).partial());

function shapeBody(input: Record<string, unknown>): Record<string, unknown> {
  return clean({
    ...input,
    owner: refOf(input["owner"] as number | undefined),
    company: refOf(input["company"] as number | undefined),
    person: refOf(input["person"] as number | undefined),
    businessCase: refOf(input["businessCase"] as number | undefined),
    project: refOf(input["project"] as number | undefined),
    offer: refOf(input["offer"] as number | undefined),
    salesOrder: refOf(input["salesOrder"] as number | undefined),
    category: refOf(input["category"] as number | undefined),
  });
}

export const listActivities = defineTool({
  name: "list_activities",
  description:
    "List RAYNET activities (tasks, meetings, calls, emails, letters, events) " +
    "with filters by type, owner, linked entity, completion, and date range. " +
    "Backed by GET /activity/, which returns mixed types in one feed.",
  category: "read",
  scopes: ["crm.read"],
  inputSchema: z.object({
    type: z.enum(ACTIVITY_TYPES).optional(),
    companyId: z.number().int().positive().optional(),
    personId: z.number().int().positive().optional(),
    businessCaseId: z.number().int().positive().optional(),
    ownerUserId: z.number().int().positive().optional(),
    completed: z.boolean().optional(),
    fromDate: z.string().optional().describe("ISO date (yyyy-MM-dd) lower bound."),
    toDate: z.string().optional().describe("ISO date (yyyy-MM-dd) upper bound."),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  }),
  async handler(input, { client }) {
    const filters: Filter[] = [];
    if (input.type) filters.push({ attr: "category", value: input.type });
    if (input.companyId !== undefined)
      filters.push({ attr: "company", value: input.companyId });
    if (input.personId !== undefined)
      filters.push({ attr: "person", value: input.personId });
    if (input.businessCaseId !== undefined)
      filters.push({ attr: "businessCase", value: input.businessCaseId });
    if (input.ownerUserId !== undefined)
      filters.push({ attr: "owner", value: input.ownerUserId });
    if (input.completed !== undefined)
      filters.push({ attr: "completed", value: String(input.completed) });
    if (input.fromDate)
      filters.push({ attr: "since", op: "GE", value: input.fromDate });
    if (input.toDate) filters.push({ attr: "since", op: "LE", value: input.toDate });

    const res = await client.list<Record<string, unknown>>("/activity/", {
      filters,
      limit: input.limit,
      offset: input.offset,
      sortColumn: "since",
      sortDirection: "DESC",
    });
    return {
      totalCount: res.totalCount ?? null,
      offset: input.offset,
      limit: input.limit,
      activities: res.data.map(tinyActivity),
    };
  },
});

export const getActivity = defineTool({
  name: "get_activity",
  description:
    "Get a single activity by type and id. Returns the full RAYNET payload, " +
    "minimally shaped to the most relevant fields.",
  category: "read",
  scopes: ["crm.read"],
  inputSchema: z.object({
    type: z.enum(ACTIVITY_TYPES),
    activityId: z.number().int().positive(),
  }),
  async handler(input, { client }) {
    const a = await client.get<Record<string, unknown>>(
      activityItemPath(input.type as ActivityType, input.activityId),
    );
    return {
      ...tinyActivity(a),
      description: a["description"],
      solution: a["solution"],
      tags: a["tags"],
      raw: a,
    };
  },
});

export const listUpcomingTasks = defineTool({
  name: "list_upcoming_tasks",
  description:
    "Convenience tool: open tasks (completed=false) with deadline in the next " +
    "N days, ordered by deadline ascending. Equivalent to a filtered list_activities " +
    "but optimized for the daily-standup question.",
  category: "read",
  scopes: ["crm.read"],
  inputSchema: z.object({
    daysAhead: z.number().int().min(0).max(90).default(14),
    ownerUserId: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  async handler(input, { client }) {
    const now = new Date();
    const until = new Date(now.getTime() + input.daysAhead * 86_400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const filters: Filter[] = [
      { attr: "completed", value: "false" },
      { attr: "deadline", op: "GE", value: fmt(now) },
      { attr: "deadline", op: "LE", value: fmt(until) },
    ];
    if (input.ownerUserId !== undefined)
      filters.push({ attr: "owner", value: input.ownerUserId });

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
      tasks: res.data.map(tinyActivity),
    };
  },
});

export const createActivity = defineTool({
  name: "create_activity",
  description:
    "Create an activity in RAYNET. Choose type: task, meeting, phoneCall, " +
    "email, letter, or event. Tasks additionally require 'deadline'. Other " +
    "types use 'scheduledFrom' / 'scheduledTill' for time. Link to a record " +
    "via company / person / businessCase ids.",
  category: "write",
  scopes: ["crm.activities.write"],
  inputSchema: ActivityCreateSchema,
  async handler(input, { client }) {
    const { type, ...rest } = input;
    const body = shapeBody(rest as Record<string, unknown>);
    const created = await client.create<{ id: number }>(
      activityListPath(type as ActivityType),
      body,
    );
    return { id: created.id, type, ok: true };
  },
});

export const updateActivity = defineTool({
  name: "update_activity",
  description:
    "Update an activity. Provide type, activityId, and only the fields you want " +
    "to change. To mark complete, prefer complete_activity.",
  category: "write",
  scopes: ["crm.activities.write"],
  inputSchema: ActivityUpdateSchema,
  async handler(input, { client }) {
    const { type, activityId, ...rest } = input;
    const body = shapeBody(rest as Record<string, unknown>);
    const updated = await client.update<{ id: number }>(
      activityItemPath(type as ActivityType, activityId),
      body,
    );
    return { id: updated.id ?? activityId, type, ok: true };
  },
});

export const completeActivity = defineTool({
  name: "complete_activity",
  description:
    "Mark an activity as completed (or reopen by setting completed=false). " +
    "Optionally attach a 'solution' note describing the outcome.",
  category: "write",
  scopes: ["crm.activities.write"],
  inputSchema: z.object({
    type: z.enum(ACTIVITY_TYPES),
    activityId: z.number().int().positive(),
    completed: z.boolean().default(true),
    solution: z.string().max(8000).optional(),
  }),
  async handler(input, { client }) {
    const body = clean({ completed: input.completed, solution: input.solution });
    await client.update(
      activityItemPath(input.type as ActivityType, input.activityId),
      body,
    );
    return {
      id: input.activityId,
      type: input.type,
      completed: input.completed,
      ok: true,
    };
  },
});

export const deleteActivity = defineTool({
  name: "delete_activity",
  description:
    "DELETE an activity. Destructive. Requires crm.destructive scope. " +
    "Pass confirm=true explicitly.",
  category: "destructive",
  scopes: ["crm.destructive"],
  inputSchema: z.object({
    type: z.enum(ACTIVITY_TYPES),
    activityId: z.number().int().positive(),
    confirm: z.literal(true),
  }),
  async handler(input, { client }) {
    await client.remove(activityItemPath(input.type as ActivityType, input.activityId));
    return { id: input.activityId, type: input.type, deleted: true };
  },
});
