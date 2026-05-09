import { z } from "zod";
import type { RaynetClient } from "../client/raynet.js";
import type { Logger } from "../util/logger.js";
import { ToolError } from "../util/errors.js";

export type ToolContext = {
  client: RaynetClient;
  logger: Logger;
};

export type ToolCategory = "read" | "write" | "destructive";

export type Tool<I extends z.ZodTypeAny, O> = {
  name: string;
  description: string;
  inputSchema: I;
  category: ToolCategory;
  scopes: string[];
  handler: (input: z.infer<I>, ctx: ToolContext) => Promise<O>;
};

export function defineTool<I extends z.ZodTypeAny, O>(t: Tool<I, O>): Tool<I, O> {
  return t;
}

/** RAYNET reference: { id: <number> }. */
export const RefSchema = z
  .object({ id: z.number().int().positive() })
  .describe("RAYNET reference: { id: number } pointing to another record.");

export const RefOrIdSchema = z.union([
  RefSchema,
  z.number().int().positive().transform((id) => ({ id })),
]);

/** Drop undefined / null fields so we never send them in PUT/POST bodies. */
export function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out as Partial<T>;
}

/** Normalize a numeric id to a RAYNET ref body fragment. */
export function refOf(id: number | undefined): { id: number } | undefined {
  return typeof id === "number" ? { id } : undefined;
}

/** Activity types supported by RAYNET. */
export const ACTIVITY_TYPES = [
  "task",
  "meeting",
  "phoneCall",
  "email",
  "letter",
  "event",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * RAYNET path segments for activities. Three of the six types use lowerCamelCase
 * in the URL (`phonecall` for list/create, `phoneCall` for detail). We normalize
 * by exposing one logical type and mapping to the right path internally.
 */
export function activityListPath(t: ActivityType): string {
  return t === "phoneCall" ? "/phonecall/" : `/${t}/`;
}
export function activityItemPath(t: ActivityType, id: number): string {
  return `/${t}/${id}/`;
}

export function getRefId(v: unknown): number | undefined {
  if (v && typeof v === "object" && "id" in v) {
    const id = (v as { id: unknown }).id;
    if (typeof id === "number") return id;
  }
  return undefined;
}

export function getRefName(v: unknown): unknown {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return o["name"] ?? o["fullName"] ?? o["label"] ?? o["title"] ?? o["id"];
  }
  return undefined;
}

/* ------- response field minimizers ------- */

export function tinyCompany(c: Record<string, unknown>): Record<string, unknown> {
  return {
    id: c["id"],
    name: c["name"],
    state: c["state"],
    rating: c["rating"],
    role: c["role"],
    primaryAddress: c["primaryAddress"],
    owner: getRefName(c["owner"]),
    category: getRefName(c["category"]),
    regNumber: c["regNumber"],
    taxNumber: c["taxNumber"],
  };
}

export function tinyPerson(p: Record<string, unknown>): Record<string, unknown> {
  return {
    id: p["id"],
    firstName: p["firstName"],
    lastName: p["lastName"],
    titleBefore: p["titleBefore"],
    titleAfter: p["titleAfter"],
    primaryAccountId: getRefId(p["primaryRelationship"]),
    primaryAccountName: getRefName(p["primaryRelationship"]),
    contact: p["contactInfo"] ?? p["contact"],
    owner: getRefName(p["owner"]),
  };
}

export function tinyDeal(d: Record<string, unknown>): Record<string, unknown> {
  return {
    id: d["id"],
    name: d["name"],
    code: d["code"],
    state: d["state"],
    phase: getRefName(d["businessCasePhase"] ?? d["phase"]),
    estimatedValue: d["estimatedValue"],
    totalAmount: d["totalAmount"],
    currency: d["currency"],
    probability: d["probability"],
    owner: getRefName(d["owner"]),
    company: getRefName(d["company"]),
    person: getRefName(d["person"]),
    validFrom: d["validFrom"],
  };
}

export function tinyActivity(
  a: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: a["id"],
    type: a["category"] ?? a["activityType"] ?? a["type"],
    title: a["title"] ?? a["subject"],
    deadline: a["deadline"],
    scheduledFrom: a["scheduledFrom"] ?? a["since"],
    scheduledTill: a["scheduledTill"] ?? a["till"],
    completed: a["completed"],
    priority: a["priority"],
    owner: getRefName(a["owner"]),
    company: getRefName(a["company"]),
    person: getRefName(a["person"]),
    businessCase: getRefName(a["businessCase"]),
  };
}

export { ToolError };
