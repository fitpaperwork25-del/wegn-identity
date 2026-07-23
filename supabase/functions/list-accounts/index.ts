import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeOperation } from "../_shared/credentialRegistry.ts";

/**
 * Sprint 2 Task 3 - read-only operational visibility for Platform Admin.
 * Returns every WEGN Account with its linked products. No filtering/
 * sorting/pagination here - the current data volume doesn't need it, and
 * the requesting page (Platform Admin's read-only Identity view) already
 * does that client-side. This function performs no writes and never will
 * - it is the read counterpart to link-account, not a replacement for it.
 *
 * Authorization (Sprint 2 Task 5): Platform Admin's own scoped credential
 * via ../_shared/credentialRegistry.ts - permitted to call list-accounts
 * only, never link-account. The old shared bootstrap secret is still
 * honored, unscoped, only until every consumer has cut over.
 *
 * Deliberately does NOT return wegn_accounts.email - the requesting
 * page's spec has no email column, and there is no reason for this
 * endpoint to carry a personal identifier its only caller never displays.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server is not configured (missing required secrets)" }, 500);
  }

  let body: { secret?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const secret = typeof body.secret === "string" ? body.secret : "";
  const authz = authorizeOperation(secret, "list-accounts");
  if (!authz.ok) {
    return jsonResponse({ error: authz.error }, authz.status);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  const { data, error } = await admin
    .from("wegn_accounts")
    .select("id, status, created_at, account_links(product_key, product_auth_user_id, created_at)")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[list-accounts] read failed:", error);
    return jsonResponse({ error: "Read failed" }, 500);
  }

  const accounts = (data ?? []).map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    links: (row.account_links ?? []).map((l: { product_key: string; product_auth_user_id: string; created_at: string }) => ({
      productKey: l.product_key,
      productAuthUserId: l.product_auth_user_id,
      linkedAt: l.created_at,
    })),
  }));

  return jsonResponse({ ok: true, accounts });
});
