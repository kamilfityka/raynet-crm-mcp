import {
  searchCompanies,
  getCompany,
  createCompany,
  updateCompany,
  deleteCompany,
} from "./companies.js";
import {
  searchContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
} from "./contacts.js";
import {
  searchDeals,
  getDeal,
  createDeal,
  updateDeal,
  changeDealPhase,
  deleteDeal,
} from "./deals.js";
import {
  listActivities,
  getActivity,
  listUpcomingTasks,
  createActivity,
  updateActivity,
  completeActivity,
  deleteActivity,
} from "./activities.js";

export type AnyTool =
  | typeof searchCompanies
  | typeof getCompany
  | typeof createCompany
  | typeof updateCompany
  | typeof deleteCompany
  | typeof searchContacts
  | typeof getContact
  | typeof createContact
  | typeof updateContact
  | typeof deleteContact
  | typeof searchDeals
  | typeof getDeal
  | typeof createDeal
  | typeof updateDeal
  | typeof changeDealPhase
  | typeof deleteDeal
  | typeof listActivities
  | typeof getActivity
  | typeof listUpcomingTasks
  | typeof createActivity
  | typeof updateActivity
  | typeof completeActivity
  | typeof deleteActivity;

export const ALL_TOOLS: readonly AnyTool[] = [
  // Contact database — companies
  searchCompanies,
  getCompany,
  createCompany,
  updateCompany,
  deleteCompany,
  // Contact database — contacts
  searchContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  // Business — deals
  searchDeals,
  getDeal,
  createDeal,
  updateDeal,
  changeDealPhase,
  deleteDeal,
  // Activities
  listActivities,
  getActivity,
  listUpcomingTasks,
  createActivity,
  updateActivity,
  completeActivity,
  deleteActivity,
] as const;

/**
 * Available granular scopes. Tools require ALL their declared scopes to be
 * present on the tenant.
 *
 * Recommended starter set:
 *   - read-only:   ["crm.read"]
 *   - read+write:  ["crm.read","crm.contacts.write","crm.deals.write","crm.activities.write"]
 *   - power user:  add "crm.destructive" — deletes only, never enabled by default.
 */
export const KNOWN_SCOPES = [
  "crm.read",
  "crm.contacts.write",
  "crm.deals.write",
  "crm.activities.write",
  "crm.destructive",
] as const;

export function pickToolsForScopes(scopes: readonly string[]): AnyTool[] {
  const set = new Set(scopes);
  return ALL_TOOLS.filter((t) => t.scopes.every((s) => set.has(s)));
}

export { ToolError } from "../util/errors.js";
