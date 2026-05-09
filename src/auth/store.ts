import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import type { RaynetRegion } from "../util/config.js";

export const TenantSchema = z.object({
  id: z.string().min(1),
  region: z.enum(["cz", "sk", "com", "eu"]),
  instanceName: z.string().min(1),
  username: z.string().min(1),
  apiKey: z.string().min(1),
  scopes: z.array(z.string()).default(["crm.read"]),
  createdAt: z.string(),
  label: z.string().optional(),
});
export type Tenant = z.infer<typeof TenantSchema>;

const StoreSchema = z.object({
  version: z.literal(1),
  tenants: z.record(z.string(), TenantSchema),
});

type EncryptedBlob = { v: 1; iv: string; tag: string; data: string };

/**
 * File-backed tenant credential store. Optionally AES-256-GCM-encrypted with a
 * base64 key. Suitable for self-hosted single-process deployments. For
 * production multi-instance deployments, swap this out for a real secret
 * manager and a database.
 */
export class TenantStore {
  private readonly file: string;
  private readonly key: Buffer | null;
  private cache: Map<string, Tenant> = new Map();
  private byBearer: Map<string, string> = new Map();
  private bearerByTenant: Map<string, string> = new Map();
  private loaded = false;

  constructor(file: string, base64Key?: string) {
    this.file = file;
    this.key = base64Key ? Buffer.from(base64Key, "base64") : null;
    if (this.key && this.key.length !== 32) {
      throw new Error("CREDENTIALS_KEY must decode to 32 bytes (base64).");
    }
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = this.decode(raw);
      for (const [bearer, tenant] of Object.entries(parsed.tenants)) {
        this.byBearer.set(bearer, tenant.id);
        this.bearerByTenant.set(tenant.id, bearer);
        this.cache.set(tenant.id, tenant);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.loaded = true;
  }

  async createTenant(input: {
    region: RaynetRegion;
    instanceName: string;
    username: string;
    apiKey: string;
    scopes?: string[];
    label?: string;
  }): Promise<{ tenant: Tenant; bearer: string }> {
    await this.init();
    const id = crypto.randomUUID();
    const bearer = "rnt_" + crypto.randomBytes(24).toString("base64url");
    const tenant: Tenant = {
      id,
      region: input.region,
      instanceName: input.instanceName,
      username: input.username,
      apiKey: input.apiKey,
      scopes: input.scopes ?? ["crm.read"],
      createdAt: new Date().toISOString(),
      ...(input.label !== undefined && { label: input.label }),
    };
    this.cache.set(id, tenant);
    this.byBearer.set(bearer, id);
    this.bearerByTenant.set(id, bearer);
    await this.persist();
    return { tenant, bearer };
  }

  async revoke(tenantId: string): Promise<boolean> {
    await this.init();
    const bearer = this.bearerByTenant.get(tenantId);
    if (!bearer) return false;
    this.byBearer.delete(bearer);
    this.bearerByTenant.delete(tenantId);
    this.cache.delete(tenantId);
    await this.persist();
    return true;
  }

  async lookupByBearer(bearer: string): Promise<Tenant | null> {
    await this.init();
    const id = this.byBearer.get(bearer);
    return id ? (this.cache.get(id) ?? null) : null;
  }

  async list(): Promise<Tenant[]> {
    await this.init();
    return [...this.cache.values()];
  }

  private async persist(): Promise<void> {
    const tenants: Record<string, Tenant> = {};
    for (const [bearer, id] of this.byBearer.entries()) {
      const t = this.cache.get(id);
      if (t) tenants[bearer] = t;
    }
    const payload = { version: 1 as const, tenants };
    StoreSchema.parse(payload);
    const serialized = JSON.stringify(payload);
    const encoded = this.encode(serialized);
    await fs.writeFile(this.file, encoded, { mode: 0o600 });
  }

  private encode(plaintext: string): string {
    if (!this.key) return plaintext;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob: EncryptedBlob = {
      v: 1,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: encrypted.toString("base64"),
    };
    return JSON.stringify(blob);
  }

  private decode(raw: string): z.infer<typeof StoreSchema> {
    if (!this.key) {
      return StoreSchema.parse(JSON.parse(raw));
    }
    const blob = JSON.parse(raw) as EncryptedBlob;
    if (blob.v !== 1) throw new Error("Unsupported credentials blob version");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(blob.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(blob.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return StoreSchema.parse(JSON.parse(decrypted));
  }
}
