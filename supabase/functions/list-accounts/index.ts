import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeOperation } from "../_shared/credentialRegistry.ts";
import { resolveRequestId, REQUEST_ID_HEADER } from "../_shared/requestId.ts";
import { logEvent } from "../_shared/logger.ts";
import { writeAuditLog } from "../_shared/auditLog.ts";

/**
 * Sprint 2 Task 3 - read-only operational visibility for Platform Admin.
 * Returns every WEGN Account with its linked products. This function
 * performs no writes and never will - it is the read counterpart to
 * link-account, not a replacement for it.
 *
 * Authorization (Sprint 2 Task 5): Platform Admin's own scoped credential
 * via ../_shared/credentialRegistry.ts - permitted to call list-accounts
 * only, never link-account. The old shared bootstrap secret is no longer
 * accepted - every consumer has cut over and the secret itself has been
 * deleted.
 *
 * Sprint 2 Task 6B: cursor-based pagination (see DEFAULT_LIMIT/MAX_LIMIT
 * below), plus the same request-ID/structured-log/audit-log contract as
 * link-account - see that function's own header for the shared
 * reasoning. Ordering is (created_at DESC, id DESC) - the id tiebreaker
 * makes pages stable even when two accounts share a created_at.
 *
 * Deliberately does NOT return wegn_accounts.email - the requesting
 * page's spec has no email column, and there is no reason for this
 * endpoint to carry a personal identifier its only caller never displays.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-request-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": REQUEST_ID_HEADER,
};

function jsonResponse(requestId: string, body: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ...(body as Record<string, unknown>), requestId }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", [REQUEST_ID_HEADER]: requestId },
  });
}

interface Cursor { createdAt: string; id: string }

function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(atob(raw));
    if (typeof parsed.createdAt === "string" && typeof parsed.id === "string") {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor));
}

serve(async (req: Request) => {
  const requestId = resolveRequestId(req);
  const startedAt = Date.now();

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(requestId, { error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    logEvent("error", { requestId, operation: "list-accounts", outcome: "internal_error", errorCode: "missing_config", durationMs: Date.now() - startedAt });
    return jsonResponse(requestId, { error: "Server is not configured (missing required secrets)" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  function finish(status: number, outcome: string, body: Record<string, unknown>, extra?: { consumer?: string | null; errorCode?: string | null }): Response {
    const durationMs = Date.now() - startedAt;
    logEvent(status >= 500 ? "error" : status >= 400 ? "warn" : "info", {
      requestId, operation: "list-accounts", outcome, consumer: extra?.consumer, errorCode: extra?.errorCode, durationMs,
    });
    void writeAuditLog(admin, {
      requestId, operation: "list-accounts", outcome,
      consumer: extra?.consumer ?? null, errorCode: extra?.errorCode ?? null,
    });
    return jsonResponse(requestId, body, status);
  }

  let body: { secret?: string; limit?: number; cursor?: string };
  try {
    body = await req.json();
  } catch {
    return finish(400, "validation_failed", { error: "Invalid JSON body" }, { errorCode: "invalid_json" });
  }

  const secret = typeof body.secret === "string" ? body.secret : "";
  const authz = authorizeOperation(secret, "list-accounts");
  if (!authz.ok) {
    const outcome = authz.status === 401 ? "invalid_credential" : "forbidden_operation";
    return finish(authz.status, outcome, { error: authz.error }, { errorCode: outcome });
  }
  const consumer = authz.entry.consumer;

  const requestedLimit = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.floor(body.limit) : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIMIT);
  const cursor = decodeCursor(body.cursor);
  if (body.cursor !== undefined && !cursor) {
    return finish(400, "validation_failed", { error: "Invalid cursor" }, { consumer, errorCode: "invalid_cursor" });
  }

  let query = admin
    .from("wegn_accounts")
    .select("id, status, created_at, account_links(product_key, product_auth_user_id, created_at)")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  }

  const { data, error } = await query;

  if (error) {
    return finish(500, "internal_error", { error: "Read failed" }, { consumer, errorCode: "read_failed" });
  }

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const items = page.map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    links: (row.account_links ?? []).map((l: { product_key: string; product_auth_user_id: string; created_at: string }) => ({
      productKey: l.product_key,
      productAuthUserId: l.product_auth_user_id,
      linkedAt: l.created_at,
    })),
  }));

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

  return finish(200, "success", { ok: true, items, nextCursor, hasMore }, { consumer });
});
