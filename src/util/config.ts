import { z } from "zod";

const RegionSchema = z.enum(["cz", "sk", "com", "eu"]);
export type RaynetRegion = z.infer<typeof RegionSchema>;

const RAYNET_REGION_BASE_URLS: Record<RaynetRegion, string> = {
  cz: "https://app.raynet.cz/api/v2",
  sk: "https://app.raynetcrm.sk/api/v2",
  com: "https://app.raynetcrm.com/api/v2",
  eu: "https://eu.raynetcrm.com/api/v2",
};

export function raynetBaseUrl(region: RaynetRegion): string {
  return RAYNET_REGION_BASE_URLS[region];
}

const ConfigSchema = z.object({
  publicBaseUrl: z.string().url(),
  port: z.coerce.number().int().min(1).max(65535),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  adminTokens: z.array(z.string().min(16)).default([]),
  credentialsFile: z.string().min(1),
  credentialsKey: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  defaultRegion: RegionSchema.default("eu"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const raw = {
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:3000",
    port: process.env.PORT ?? "3000",
    logLevel: process.env.LOG_LEVEL ?? "info",
    adminTokens: (process.env.ADMIN_TOKENS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    credentialsFile: process.env.CREDENTIALS_FILE ?? "./data/tenants.json",
    credentialsKey: process.env.CREDENTIALS_KEY,
    defaultRegion: process.env.DEFAULT_RAYNET_REGION ?? "eu",
  };
  return ConfigSchema.parse(raw);
}
