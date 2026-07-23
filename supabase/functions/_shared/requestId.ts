/**
 * Sprint 2 Task 6B - correlation IDs. A request ID ties together a
 * caller's own logs, this service's structured logs, and the audit row
 * for the same request, without ever needing to correlate by timestamp
 * guesswork.
 *
 * Accepts an incoming X-Request-ID only if it looks safe (bounded
 * length, restricted character set) - an unbounded or unusual value
 * could otherwise end up verbatim in logs/audit rows (log injection,
 * oversized rows). Anything else is replaced with a fresh server-side
 * ID, never rejected outright - a malformed request ID is not a reason
 * to fail the caller's actual request.
 */

const REQUEST_ID_HEADER = "X-Request-ID";
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function resolveRequestId(req: Request): string {
  const incoming = req.headers.get(REQUEST_ID_HEADER);
  if (incoming && SAFE_REQUEST_ID.test(incoming)) {
    return incoming;
  }
  return crypto.randomUUID();
}

export { REQUEST_ID_HEADER };
