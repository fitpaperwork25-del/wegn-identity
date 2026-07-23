import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeOperation } from "../_shared/credentialRegistry.ts";
import { resolveRequestId, REQUEST_ID_HEADER } from "../_shared/requestId.ts";
import { logEvent } from "../_shared/logger.ts";
import { writeAuditLog } from "../_shared/auditLog.ts";

/**
 * Sprint 2 Task 6B - minimal operational health visibility for Platform
 * Admin, derived entirely from identity_audit_log (no new tracking
 * table). Read-only: no write controls, no account management, no
 * credential values anywhere in the response.
 *
 * Authorization: Platform Admin's existing scoped credential (the same
 * one used for list-accounts) - see credentialRegistry.ts. Cannot call
 * link-account.
 */

const RECENT_WINDOW_HOURS = 24;

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

serve(async (req: Request) => {
  const requestId = resolveRequestId(req);
  const startedAt = Date.now();

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(requestId, { error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    logEvent("error", { requestId, operation: "health-summary", outcome: "internal_error", errorCode: "missing_config", durationMs: Date.now() - startedAt });
    return jsonResponse(requestId, { error: "Server is not configured (missing required secrets)" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  function finish(status: number, outcome: string, body: Record<string, unknown>, extra?: { consumer?: string | null; errorCode?: string | null }): Response {
    const durationMs = Date.now() - startedAt;
    logEvent(status >= 500 ? "error" : status >= 400 ? "warn" : "info", {
      requestId, operation: "health-summary", outcome, consumer: extra?.consumer, errorCode: extra?.errorCode, durationMs,
    });
    void writeAuditLog(admin, {
      requestId, operation: "health-summary", outcome,
      consumer: extra?.consumer ?? null, errorCode: extra?.errorCode ?? null,
    });
    return jsonResponse(requestId, body, status);
  }

  let body: { secret?: string };
  try {
    body = await req.json();
  } catch {
    return finish(400, "validation_failed", { error: "Invalid JSON body" }, { errorCode: "invalid_json" });
  }

  const secret = typeof body.secret === "string" ? body.secret : "";
  const authz = authorizeOperation(secret, "health-summary");
  if (!authz.ok) {
    const outcome = authz.status === 401 ? "invalid_credential" : "forbidden_operation";
    return finish(authz.status, outcome, { error: authz.error }, { errorCode: outcome });
  }
  const consumer = authz.entry.consumer;

  const windowStart = new Date(Date.now() - RECENT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const [lastSuccess, lastFailure, successCount, failureCount, recentRows] = await Promise.all([
    admin.from("identity_audit_log").select("occurred_at").eq("outcome", "success").order("occurred_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("identity_audit_log").select("occurred_at").neq("outcome", "success").order("occurred_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("identity_audit_log").select("*", { count: "exact", head: true }).eq("outcome", "success").gte("occurred_at", windowStart),
    admin.from("identity_audit_log").select("*", { count: "exact", head: true }).neq("outcome", "success").gte("occurred_at", windowStart),
    admin.from("identity_audit_log").select("consumer").gte("occurred_at", windowStart).limit(1000),
  ]);

  const anyError = lastSuccess.error || lastFailure.error || successCount.error || failureCount.error || recentRows.error;
  if (anyError) {
    return finish(500, "internal_error", { error: "Read failed" }, { consumer, errorCode: "read_failed" });
  }

  const byConsumer = new Map<string, number>();
  for (const row of recentRows.data ?? []) {
    const key = row.consumer ?? "unknown";
    byConsumer.set(key, (byConsumer.get(key) ?? 0) + 1);
  }
  const recentOperationsByConsumer = Array.from(byConsumer.entries())
    .map(([consumerName, operationCount]) => ({ consumer: consumerName, operationCount }))
    .sort((a, b) => b.operationCount - a.operationCount);

  return finish(200, "success", {
    ok: true,
    serviceReachable: true,
    lastSuccessfulRequestAt: lastSuccess.data?.occurred_at ?? null,
    lastFailedRequestAt: lastFailure.data?.occurred_at ?? null,
    recentWindowHours: RECENT_WINDOW_HOURS,
    recentSuccessCount: successCount.count ?? 0,
    recentFailureCount: failureCount.count ?? 0,
    recentOperationsByConsumer,
  }, { consumer });
});
