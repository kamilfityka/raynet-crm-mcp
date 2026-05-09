import express from "express";
import { pinoHttp } from "pino-http";
import { z } from "zod";
import { loadConfig } from "./util/config.js";
import { createLogger } from "./util/logger.js";
import { TenantStore } from "./auth/store.js";
import { adminAuth, bearerAuth } from "./auth/middleware.js";
import { handleMcpRequest } from "./mcp/server.js";
import { ALL_TOOLS } from "./tools/index.js";

const ConnectBodySchema = z.object({
  region: z.enum(["cz", "sk", "com", "eu"]).optional(),
  instanceName: z.string().min(1),
  username: z.string().min(1),
  apiKey: z.string().min(1),
  scopes: z.array(z.string()).optional(),
  label: z.string().max(120).optional(),
});

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const store = new TenantStore(config.credentialsFile, config.credentialsKey);
  await store.init();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(pinoHttp({ logger }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "raynet-crm-mcp", version: "0.1.0" });
  });

  app.get("/.well-known/mcp", (_req, res) => {
    res.json({
      name: "raynet-crm-mcp",
      version: "0.1.0",
      transport: "streamable-http",
      endpoint: `${config.publicBaseUrl}/mcp`,
      auth: { type: "bearer" },
      tools: ALL_TOOLS.map((t) => ({
        name: t.name,
        category: t.category,
        scopes: t.scopes,
      })),
    });
  });

  // ---- Admin: tenant registration --------------------------------------
  // This is a placeholder for full OAuth 2.1 + DCR. Until that is in place,
  // self-hosted operators can register tenants by calling /admin/connect with
  // an admin token configured via ADMIN_TOKENS.
  app.post("/admin/connect", adminAuth(config.adminTokens), async (req, res) => {
    const parsed = ConnectBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "validation", details: parsed.error.flatten() });
      return;
    }
    const { tenant, bearer } = await store.createTenant({
      region: parsed.data.region ?? config.defaultRegion,
      instanceName: parsed.data.instanceName,
      username: parsed.data.username,
      apiKey: parsed.data.apiKey,
      ...(parsed.data.scopes !== undefined && { scopes: parsed.data.scopes }),
      ...(parsed.data.label !== undefined && { label: parsed.data.label }),
    });
    logger.info(
      {
        tenantId: tenant.id,
        region: tenant.region,
        instanceName: tenant.instanceName,
        scopes: tenant.scopes,
      },
      "tenant.created",
    );
    res.status(201).json({
      tenantId: tenant.id,
      bearer,
      mcpEndpoint: `${config.publicBaseUrl}/mcp`,
      hint: "Configure your MCP client with this endpoint and pass the bearer token in Authorization: Bearer <token>.",
    });
  });

  app.get("/admin/tenants", adminAuth(config.adminTokens), async (_req, res) => {
    const tenants = await store.list();
    res.json({
      tenants: tenants.map((t) => ({
        id: t.id,
        region: t.region,
        instanceName: t.instanceName,
        scopes: t.scopes,
        label: t.label,
        createdAt: t.createdAt,
      })),
    });
  });

  app.delete(
    "/admin/tenants/:id",
    adminAuth(config.adminTokens),
    async (req, res) => {
      const id = req.params["id"];
      if (!id) {
        res.status(400).json({ error: "validation", message: "Missing tenant id." });
        return;
      }
      const ok = await store.revoke(id);
      res.status(ok ? 204 : 404).end();
    },
  );

  // ---- MCP endpoint ----------------------------------------------------
  const mcpHandler = async (
    req: express.Request,
    res: express.Response,
  ): Promise<void> => {
    if (!req.tenant) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      await handleMcpRequest(req.tenant, logger, req, res);
    } catch (err) {
      logger.error({ err }, "mcp.handler.error");
      if (!res.headersSent) {
        res.status(500).json({ error: "internal" });
      }
    }
  };
  app.post("/mcp", bearerAuth(store), mcpHandler);
  app.get("/mcp", bearerAuth(store), mcpHandler);
  app.delete("/mcp", bearerAuth(store), mcpHandler);

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      logger.error({ err }, "unhandled");
      if (!res.headersSent) res.status(500).json({ error: "internal" });
    },
  );

  app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        publicBaseUrl: config.publicBaseUrl,
        adminEnabled: config.adminTokens.length > 0,
      },
      "listening",
    );
  });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
