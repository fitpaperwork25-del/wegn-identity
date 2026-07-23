import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Sprint 2 Task 6B - writes one row to identity_audit_log per Identity
 * operation, success or rejection alike. Best-effort by design: if the
 * insert itself fails, that is logged (via logger.ts) and swallowed -
 * an audit-logging problem must never turn into a failure of the real
 * operation it was trying to record, mirroring every other
 * fire-and-forget contract in this ecosystem.
 *
 * Never pass email, a credential value, a token, or a full request body
 * into `metadata` - only small, already-safe identifiers belong there
 * (e.g. a validation field name). This module does not scrub its input.
 */

export interface AuditEntry {
  requestId: string;
  consumer: string | null;
  operation: string;
  outcome: string;
  productKey?: string | null;
  wegnAccountId?: string | null;
  accountLinkId?: string | null;
  errorCode?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function writeAuditLog(admin: SupabaseClient, entry: AuditEntry): Promise<void> {
  try {
    const { error } = await admin.from("identity_audit_log").insert({
      request_id: entry.requestId,
      consumer: entry.consumer,
      operation: entry.operation,
      outcome: entry.outcome,
      product_key: entry.productKey ?? null,
      wegn_account_id: entry.wegnAccountId ?? null,
      account_link_id: entry.accountLinkId ?? null,
      error_code: entry.errorCode ?? null,
      metadata: entry.metadata ?? null,
    });
    if (error) {
      console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", request_id: entry.requestId, message: "audit log insert failed (non-blocking)", db_error: error.message }));
    }
  } catch (err) {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", request_id: entry.requestId, message: "audit log insert threw (non-blocking)", error: err instanceof Error ? err.message : String(err) }));
  }
}
