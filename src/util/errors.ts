export type ErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "ambiguous"
  | "validation"
  | "conflict"
  | "rate_limited"
  | "upstream_error"
  | "timeout"
  | "internal";

export class ToolError extends Error {
  readonly kind: ErrorKind;
  readonly status: number;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(
    kind: ErrorKind,
    message: string,
    opts: { status?: number; hint?: string; details?: unknown } = {},
  ) {
    super(message);
    this.kind = kind;
    this.status = opts.status ?? defaultStatus(kind);
    if (opts.hint !== undefined) this.hint = opts.hint;
    if (opts.details !== undefined) this.details = opts.details;
  }
}

function defaultStatus(kind: ErrorKind): number {
  switch (kind) {
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "ambiguous":
      return 409;
    case "validation":
      return 400;
    case "conflict":
      return 409;
    case "rate_limited":
      return 429;
    case "upstream_error":
      return 502;
    case "timeout":
      return 504;
    case "internal":
      return 500;
  }
}

/**
 * Map a raw upstream Raynet HTTP error into a ToolError. Raynet returns 401 for
 * bad credentials and locks the IP after 20 wrong logins for 60 minutes — we
 * must NOT retry on 401.
 */
export function fromUpstreamHttp(
  status: number,
  body: unknown,
  context: string,
): ToolError {
  if (status === 401) {
    return new ToolError(
      "unauthorized",
      `RAYNET rejected the request: invalid credentials (${context}).`,
      {
        hint: "Re-register the tenant; do NOT retry — RAYNET locks the source IP after 20 failed logins for 60 minutes.",
        details: body,
      },
    );
  }
  if (status === 403) {
    return new ToolError("forbidden", `RAYNET denied the request (${context}).`, {
      details: body,
    });
  }
  if (status === 404) {
    return new ToolError("not_found", `Record not found (${context}).`, {
      hint: "Use the matching search_* tool first to locate a valid id.",
      details: body,
    });
  }
  if (status === 429) {
    return new ToolError(
      "rate_limited",
      `RAYNET rate limit reached (${context}).`,
      {
        hint: "Wait until the X-Ratelimit-Reset window passes, or reduce concurrent calls (max 4).",
        details: body,
      },
    );
  }
  if (status >= 500) {
    return new ToolError("upstream_error", `RAYNET error ${status} (${context}).`, {
      details: body,
    });
  }
  return new ToolError("validation", `RAYNET rejected the request (${context}).`, {
    details: body,
  });
}
