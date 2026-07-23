/**
 * Sprint 2 Task 6B - structured logging for Identity's Edge Functions.
 * Replaces ad-hoc console.error(...) calls with one consistent JSON
 * shape, so log output can actually be searched/filtered by field
 * (request_id, consumer, operation, outcome) instead of parsing prose.
 *
 * Never pass a credential, access token, password, or raw Authorization
 * header value into `fields` - this module does not scrub its input,
 * the same discipline as every other place in this codebase that logs
 * request context (see e.g. link-account's own header comments).
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  requestId: string;
  consumer?: string | null;
  operation: string;
  outcome: string;
  productKey?: string | null;
  durationMs?: number;
  errorCode?: string | null;
}

export function logEvent(level: LogLevel, fields: LogFields): void {
  const line = {
    timestamp: new Date().toISOString(),
    level,
    request_id: fields.requestId,
    consumer: fields.consumer ?? null,
    operation: fields.operation,
    outcome: fields.outcome,
    product_key: fields.productKey ?? null,
    duration_ms: fields.durationMs ?? null,
    error_code: fields.errorCode ?? null,
  };
  const line_str = JSON.stringify(line);
  if (level === "error") console.error(line_str);
  else if (level === "warn") console.warn(line_str);
  else console.log(line_str);
}
