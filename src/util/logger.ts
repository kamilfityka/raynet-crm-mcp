import pino from "pino";

export function createLogger(level: string): pino.Logger {
  return pino({
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-api-key']",
        "headers.authorization",
        "credentials.apiKey",
        "credentials.username",
        "*.apiKey",
        "*.password",
      ],
      censor: "[redacted]",
    },
    base: { service: "raynet-crm-mcp" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = pino.Logger;
