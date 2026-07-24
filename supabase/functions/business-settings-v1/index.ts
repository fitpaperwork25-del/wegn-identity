import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyUserAuth } from "../_shared/verifyUserAuth.ts";
import { resolveRequestId, REQUEST_ID_HEADER } from "../_shared/requestId.ts";
import { logEvent } from "../_shared/logger.ts";
import { writeAuditLog } from "../_shared/auditLog.ts";

/**
 * Phase 2A-4 - Business Settings and Notification preferences write
 * surface. Two small, related, owner-only operations
 * (update_profile / update_notification_preference) in one function,
 * same shape as team-management-v1: the RPCs
 * (20260724020000_business_settings_and_notification_preferences.sql)
 * already carry the real authorization and validation logic, this
 * function only handles auth, request shape, and error mapping.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-request-id, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": REQUEST_ID_HEADER,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(requestId: string, body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ requestId, ...body }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", [REQUEST_ID_HEADER]: requestId },
  });
}

function errorResponse(requestId: string, status: number, code: string, message: string): Response {
  logEvent(status >= 500 ? "error" : "warn", { requestId, operation: "business-settings-v1", outcome: "error", consumer: "wegn-home", errorCode: code });
  return jsonResponse(requestId, { error: { code, message } }, status);
}

const KNOWN_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  owner_authorization_required: { status: 403, code: "OWNER_REQUIRED", message: "Only the business owner can do this." },
  invalid_display_name: { status: 400, code: "INVALID_DISPLAY_NAME", message: "Business name must be between 1 and 160 characters." },
  invalid_country_code: { status: 400, code: "INVALID_COUNTRY", message: "Country must be a valid 2-letter code." },
  business_not_found: { status: 404, code: "BUSINESS_NOT_FOUND", message: "This business wasn't found." },
  invalid_alert_code: { status: 400, code: "INVALID_ALERT_CODE", message: "Unknown alert type." },
  invalid_channel: { status: 400, code: "INVALID_CHANNEL", message: "Unknown notification channel." },
  active_account_required: { status: 403, code: "ACCOUNT_NOT_ACTIVE", message: "Your account isn't active." },
};

function mapRpcError(requestId: string, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  const known = KNOWN_ERRORS[message];
  if (known) return errorResponse(requestId, known.status, known.code, known.message);
  logEvent("error", { requestId, operation: "business-settings-v1", outcome: "error", consumer: "wegn-home", errorCode: "unknown_rpc_error" });
  return errorResponse(requestId, 502, "OPERATION_FAILED", "The operation could not be completed.");
}

serve(async (req: Request) => {
  const requestId = resolveRequestId(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return errorResponse(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed.");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return errorResponse(requestId, 500, "INTERNAL_ERROR", "The settings service is not configured.");
  }
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const verified = await verifyUserAuth({ supabaseUrl, supabaseAnonKey, authorizationHeader: req.headers.get("Authorization") });
  if (!verified?.email) return errorResponse(requestId, 401, "AUTHENTICATION_REQUIRED", "Authentication is required.");

  const email = verified.email.trim().toLowerCase();
  const { data: accountRows, error: accountError } = await admin.rpc("resolve_or_create_wegn_account", { p_email: email });
  const account = Array.isArray(accountRows) ? accountRows[0] : null;
  if (accountError || !account) return errorResponse(requestId, 503, "SETTINGS_UNAVAILABLE", "The settings service is temporarily unavailable.");
  if (account.status !== "ACTIVE") return errorResponse(requestId, 403, "SETTINGS_FORBIDDEN", "This account is not permitted to manage business settings.");

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return errorResponse(requestId, 400, "INVALID_REQUEST", "Invalid JSON body.");
  }

  const operation = typeof body.operation === "string" ? body.operation : "";
  const consumer = "wegn-home";

  try {
    if (operation === "update_profile") {
      const businessId = typeof body.businessId === "string" ? body.businessId : "";
      const displayName = typeof body.displayName === "string" ? body.displayName : "";
      const countryCode = typeof body.countryCode === "string" && body.countryCode ? body.countryCode : null;
      if (!UUID_PATTERN.test(businessId) || !displayName) {
        return errorResponse(requestId, 400, "INVALID_REQUEST", "businessId and displayName are required.");
      }
      const { error } = await admin.rpc("update_business_settings", {
        p_request_id: requestId, p_consumer: consumer, p_actor_wegn_account_id: account.id,
        p_wegn_business_id: businessId, p_display_name: displayName, p_country_code: countryCode,
      });
      if (error) throw new Error(error.message);
      void writeAuditLog(admin, { requestId, operation: "business-settings-v1.update_profile", outcome: "success", consumer, wegnAccountId: account.id });
      return jsonResponse(requestId, { updated: true });
    }

    if (operation === "update_notification_preference") {
      const businessId = typeof body.businessId === "string" ? body.businessId : "";
      const alertCode = typeof body.alertCode === "string" ? body.alertCode : "";
      const channel = typeof body.channel === "string" ? body.channel : "email";
      const enabled = typeof body.enabled === "boolean" ? body.enabled : null;
      if (!UUID_PATTERN.test(businessId) || !alertCode || enabled === null) {
        return errorResponse(requestId, 400, "INVALID_REQUEST", "businessId, alertCode, and enabled are required.");
      }
      const { error } = await admin.rpc("set_business_notification_preference", {
        p_request_id: requestId, p_consumer: consumer, p_actor_wegn_account_id: account.id,
        p_wegn_business_id: businessId, p_alert_code: alertCode, p_channel: channel, p_enabled: enabled,
      });
      if (error) throw new Error(error.message);
      void writeAuditLog(admin, { requestId, operation: "business-settings-v1.update_notification_preference", outcome: "success", consumer, wegnAccountId: account.id });
      return jsonResponse(requestId, { updated: true });
    }

    return errorResponse(requestId, 400, "INVALID_REQUEST", "Unknown operation.");
  } catch (err) {
    return mapRpcError(requestId, err);
  }
});
