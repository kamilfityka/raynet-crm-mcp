import type { Request, Response, NextFunction } from "express";
import type { TenantStore, Tenant } from "./store.js";

declare module "express-serve-static-core" {
  interface Request {
    tenant?: Tenant;
  }
}

export function bearerAuth(store: TenantStore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) {
      res.status(401).json({
        error: "unauthorized",
        message: "Missing Bearer token. Register a tenant via POST /admin/connect.",
      });
      return;
    }
    const tenant = await store.lookupByBearer(m[1]!.trim());
    if (!tenant) {
      res.status(401).json({
        error: "unauthorized",
        message: "Unknown or revoked Bearer token.",
      });
      return;
    }
    req.tenant = tenant;
    next();
  };
}

export function adminAuth(adminTokens: string[]) {
  const set = new Set(adminTokens);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (set.size === 0) {
      res.status(503).json({
        error: "admin_disabled",
        message:
          "Admin endpoints are disabled. Set ADMIN_TOKENS in the environment to enable tenant registration.",
      });
      return;
    }
    const header = req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m || !set.has(m[1]!.trim())) {
      res.status(401).json({ error: "unauthorized", message: "Admin token required." });
      return;
    }
    next();
  };
}
