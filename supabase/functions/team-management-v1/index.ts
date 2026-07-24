import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyUserAuth } from "../_shared/verifyUserAuth.ts";
import { resolveRequestId, REQUEST_ID_HEADER } from "../_shared/requestId.ts";
import { logEvent } from "../_shared/logger.ts";
import { writeAuditLog } from "../_shared/auditLog.ts";

/**
 * Phase 2A-3 - Team & Staff write surface: invite / accept / role_change
 * / revoke, one operation per call. All four RPCs
 * (20260724010000_business_registry_team_invites.sql) already carry the
 * real authorization, invariant, and audit logic - this function's job
 * is auth (who is calling), request shape validation, and mapping the
 * RPC's Postgres exception codes onto clean HTTP responses. It does not
 * reimplement any of the checks the RPCs already perform.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-request-id, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": REQUEST_ID_HEADER,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jsonResponse(requestId: string, body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ requestId, ...body }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", [REQUEST_ID_HEADER]: requestId },
  });
}

function errorResponse(requestId: string, status: number, code: string, message: string): Response {
  logEvent(status >= 500 ? "error" : "warn", {
    requestId, operation: "team-management-v1", outcome: "error", consumer: "wegn-home", errorCode: code,
  });
  return jsonResponse(requestId, { error: { code, message } }, status);
}

// Postgres RAISE EXCEPTION messages from the migration's RPCs, mapped to
// the HTTP status/code a caller can act on. Anything not in this table
// is a genuine server-side failure (500), not a caller mistake.
const KNOWN_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  owner_authorization_required: { status: 403, code: "OWNER_REQUIRED", message: "Only the business owner can do this." },
  invalid_invite_role: { status: 400, code: "INVALID_ROLE", message: "Invites can only grant administrator or member." },
  already_a_member: { status: 409, code: "ALREADY_A_MEMBER", message: "This person already has access to this business." },
  invite_already_pending: { status: 409, code: "INVITE_ALREADY_PENDING", message: "There is already a pending invite for this email." },
  invite_not_found: { status: 404, code: "INVITE_NOT_FOUND", message: "This invite doesn't exist." },
  invite_is_no_longer_pending: { status: 409, code: "INVITE_NOT_PENDING", message: "This invite has already been accepted or revoked." },
  invite_expired: { status: 409, code: "INVITE_EXPIRED", message: "This invite has expired." },
  invite_email_mismatch: { status: 403, code: "INVITE_EMAIL_MISMATCH", message: "This invite was sent to a different email address." },
  active_account_required: { status: 403, code: "ACCOUNT_NOT_ACTIVE", message: "Your account isn't active." },
  invalid_target_role: { status: 400, code: "INVALID_ROLE", message: "Role must be administrator or member." },
  membership_not_found: { status: 404, code: "MEMBER_NOT_FOUND", message: "This team member wasn't found." },
  membership_not_active: { status: 409, code: "MEMBER_NOT_ACTIVE", message: "This team member's access is no longer active." },
  cannot_change_owner_role_here: { status: 400, code: "CANNOT_MODIFY_OWNER", message: "The owner's role can't be changed here." },
  cannot_revoke_owner_here: { status: 400, code: "CANNOT_MODIFY_OWNER", message: "The owner's access can't be revoked here." },
};

function mapRpcError(requestId: string, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  const known = KNOWN_ERRORS[message];
  if (known) return errorResponse(requestId, known.status, known.code, known.message);
  logEvent("error", { requestId, operation: "team-management-v1", outcome: "error", consumer: "wegn-home", errorCode: "unknown_rpc_error" });
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
    return errorResponse(requestId, 500, "INTERNAL_ERROR", "The team service is not configured.");
  }
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const verified = await verifyUserAuth({ supabaseUrl, supabaseAnonKey, authorizationHeader: req.headers.get("Authorization") });
  if (!verified?.email) return errorResponse(requestId, 401, "AUTHENTICATION_REQUIRED", "Authentication is required.");

  const email = verified.email.trim().toLowerCase();
  const { data: accountRows, error: accountError } = await admin.rpc("resolve_or_create_wegn_account", { p_email: email });
  const account = Array.isArray(accountRows) ? accountRows[0] : null;
  if (accountError || !account) return errorResponse(requestId, 503, "TEAM_UNAVAILABLE", "The team service is temporarily unavailable.");
  if (account.status !== "ACTIVE") return errorResponse(requestId, 403, "TEAM_FORBIDDEN", "This account is not permitted to manage team access.");

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return errorResponse(requestId, 400, "INVALID_REQUEST", "Invalid JSON body.");
  }

  const operation = typeof body.operation === "string" ? body.operation : "";
  const consumer = "wegn-home";

  try {
    if (operation === "invite") {
      const businessId = typeof body.businessId === "string" ? body.businessId : "";
      const targetEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const role = typeof body.role === "string" ? body.role : "";
      if (!UUID_PATTERN.test(businessId) || !EMAIL_PATTERN.test(targetEmail) || !role) {
        return errorResponse(requestId, 400, "INVALID_REQUEST", "businessId, email, and role are required.");
      }
      const { data, error } = await admin.rpc("create_business_team_invite", {
        p_request_id: requestId, p_consumer: consumer, p_actor_wegn_account_id: account.id,
        p_wegn_business_id: businessId, p_email: targetEmail, p_role: role,
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      void writeAuditLog(admin, { requestId, operation: "team-management-v1.invite", outcome: "success", consumer, wegnAccountId: account.id });
      return jsonResponse(requestId, { inviteId: row.invite_id, expiresAt: row.expires_at });
    }

    if (operation === "accept") {
      const inviteId = typeof body.inviteId === "string" ? body.inviteId : "";
      if (!UUID_PATTERN.test(inviteId)) return errorResponse(requestId, 400, "INVALID_REQUEST", "inviteId is required.");
      const { data, error } = await admin.rpc("accept_business_team_invite", {
        p_request_id: requestId, p_consumer: consumer, p_actor_wegn_account_id: account.id, p_invite_id: inviteId,
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      void writeAuditLog(admin, { requestId, operation: "team-management-v1.accept", outcome: "success", consumer, wegnAccountId: account.id });
      return jsonResponse(requestId, { businessId: row.wegn_business_id, membershipId: row.membership_id, role: row.role });
    }

    if (operation === "revoke_invite") {
      const inviteId = typeof body.inviteId === "string" ? body.inviteId : "";
      if (!UUID_PATTERN.test(inviteId)) return errorResponse(requestId, 400, "INVALID_REQUEST", "inviteId is required.");
      const { error } = await admin.rpc("revoke_business_team_invite", {
        p_request_id: requestId, p_consumer: consumer, p_actor_wegn_account_id: account.id, p_invite_id: inviteId,
      });
      if (error) throw new Error(error.message);
      void writeAuditLog(admin, { requestId, operation: "team-management-v1.revoke_invite", outcome: "success", consumer, wegnAccountId: account.id });
      return jsonResponse(requestId, { revoked: true });
    }

    if (operation === "role_change") {
      const businessId = typeof body.businessId === "string" ? body.businessId : "";
      const membershipId = typeof body.membershipId === "string" ? body.membershipId : "";
      const newRole = typeof body.role === "string" ? body.role : "";
      if (!UUID_PATTERN.test(businessId) || !UUID_PATTERN.test(membershipId) || !newRole) {
        return errorResponse(requestId, 400, "INVALID_REQUEST", "businessId, membershipId, and role are required.");
      }
      const { error } = await admin.rpc("change_business_team_member_role", {
        p_request_id: requestId, p_consumer: consumer, p_actor_wegn_account_id: account.id,
        p_wegn_business_id: businessId, p_membership_id: membershipId, p_new_role: newRole,
      });
      if (error) throw new Error(error.message);
      void writeAuditLog(admin, { requestId, operation: "team-management-v1.role_change", outcome: "success", consumer, wegnAccountId: account.id });
      return jsonResponse(requestId, { updated: true });
    }

    if (operation === "revoke_member") {
      const businessId = typeof body.businessId === "string" ? body.businessId : "";
      const membershipId = typeof body.membershipId === "string" ? body.membershipId : "";
      if (!UUID_PATTERN.test(businessId) || !UUID_PATTERN.test(membershipId)) {
        return errorResponse(requestId, 400, "INVALID_REQUEST", "businessId and membershipId are required.");
      }
      const { error } = await admin.rpc("revoke_business_team_member", {
        p_request_id: requestId, p_consumer: consumer, p_actor_wegn_account_id: account.id,
        p_wegn_business_id: businessId, p_membership_id: membershipId,
      });
      if (error) throw new Error(error.message);
      void writeAuditLog(admin, { requestId, operation: "team-management-v1.revoke_member", outcome: "success", consumer, wegnAccountId: account.id });
      return jsonResponse(requestId, { revoked: true });
    }

    return errorResponse(requestId, 400, "INVALID_REQUEST", "Unknown operation.");
  } catch (err) {
    return mapRpcError(requestId, err);
  }
});
