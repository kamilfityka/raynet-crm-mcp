import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Request, Response } from "express";
import { z } from "zod";
import { RaynetClient } from "../client/raynet.js";
import { pickToolsForScopes } from "../tools/index.js";
import { ToolError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import type { Tenant } from "../auth/store.js";

const SERVER_INFO = {
  name: "raynet-crm-mcp",
  version: "0.1.0",
} as const;

/**
 * Build a per-request stateless MCP server bound to a specific tenant. The MCP
 * spec's Streamable HTTP transport supports stateless mode (no session id) —
 * each request is independent, which keeps tenant isolation simple.
 */
export function buildMcpServer(tenant: Tenant, logger: Logger): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions:
      "RAYNET CRM connector. Covers Contact database (companies + contacts), " +
      "Business (deals), and Activities (task/meeting/call/email/letter/event). " +
      "Use search_* tools first to locate records, then get_* with mode=full " +
      "for consolidated context. Reference fields take RAYNET ids — fetch them " +
      "via search_* before passing to create_*/update_* tools. delete_* tools " +
      "require confirm=true and the crm.destructive scope. Data may include " +
      "personal information — only fetch what you need to answer the question.",
  });

  const client = new RaynetClient(tenant, logger);
  const tools = pickToolsForScopes(tenant.scopes);

  for (const tool of tools) {
    // Each tool is its own concrete type; widen for registration loop and
    // re-validate inside the handler with the original schema.
    const t = tool as unknown as {
      name: string;
      description: string;
      inputSchema: z.ZodTypeAny;
      category: string;
      handler: (input: unknown, ctx: { client: RaynetClient; logger: Logger }) => Promise<unknown>;
    };
    const shape = unwrapShape(t.inputSchema);
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: shape },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (rawArgs: unknown) => {
        const parsed = t.inputSchema.safeParse(rawArgs);
        if (!parsed.success) {
          return errorResult(
            new ToolError("validation", "Input validation failed.", {
              details: parsed.error.flatten(),
            }),
          );
        }
        try {
          const value = await t.handler(parsed.data, { client, logger });
          logger.info(
            {
              tool: t.name,
              category: t.category,
              tenantId: tenant.id,
              raynetRemaining: client.rateLimit.remaining,
            },
            "tool.ok",
          );
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(value, null, 2) },
            ],
          };
        } catch (err) {
          const e =
            err instanceof ToolError
              ? err
              : new ToolError("internal", (err as Error).message);
          logger.warn(
            {
              tool: t.name,
              kind: e.kind,
              status: e.status,
              tenantId: tenant.id,
              raynetRemaining: client.rateLimit.remaining,
            },
            "tool.err",
          );
          return errorResult(e);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    );
  }

  return server;
}

/**
 * Tools may wrap their input schema in `.refine()` for cross-field constraints,
 * which produces a `ZodEffects` rather than a `ZodObject`. The MCP SDK expects
 * the bare `.shape` to expose individual parameters, so unwrap effects until we
 * reach the underlying object.
 */
function unwrapShape(schema: z.ZodTypeAny): z.ZodRawShape {
  let s: z.ZodTypeAny = schema;
  // ZodEffects wraps the inner schema under _def.schema
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  while ((s as any)?._def?.typeName === "ZodEffects") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s = (s as any)._def.schema as z.ZodTypeAny;
  }
  return (s as unknown as z.AnyZodObject).shape;
}

function errorResult(e: ToolError) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: e.kind,
            message: e.message,
            ...(e.hint && { hint: e.hint }),
          },
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * Handle a single MCP HTTP request statelessly. Each call creates a fresh
 * server + transport instance — there is no shared state between calls, which
 * avoids cross-tenant leaks.
 */
export async function handleMcpRequest(
  tenant: Tenant,
  logger: Logger,
  req: Request,
  res: Response,
): Promise<void> {
  // Stateless: omit sessionIdGenerator entirely; each request is independent
  // and bound to a single authenticated tenant.
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  const server = buildMcpServer(tenant, logger);
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  // The SDK transport's optional callbacks declare `(() => void) | undefined`
  // which the strict Transport interface refines to `(() => void)`. Cast to
  // bridge the signatures — runtime behavior is unaffected.
  await server.connect(transport as unknown as Transport);
  await transport.handleRequest(req, res, req.body);
}
