import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeOperation, authorizeProductKey } from "../_shared/credentialRegistry.ts";

/**
 * Task 1 foundation capability - the only thing this service does so
 * far. Links an existing product's own account (its own auth_user_id)
 * to a WEGN Account, creating the WEGN Account if this email has never
 * been seen before. Does not touch, modify, or read anything in the
 * calling product's own database - the caller supplies its own
 * auth_user_id and email; this function never verifies them against
 * that product directly (that would require a cross-project connection,
 * exactly what WSMS's own architecture deliberately avoids - see
 * docs/WSMS_DEPENDENCY_MAP.md in wegn-platform-admin. The calling
 * product is responsible for only ever invoking this from its own
 * server-side code, after its own auth has already verified the caller).
 *
 * Authorization (Sprint 2 Task 5): a per-consumer scoped credential via
 * ../_shared/credentialRegistry.ts - each credential is restricted to
 * link-account only and to its own productKey. The old shared bootstrap
 * secret (IDENTITY_SERVICE_SECRET) is still honored, unscoped, only until
 * every consumer has cut over - see credentialRegistry.ts's own header.
 *
 * Idempotent by design, not just by convention: a repeated call for the
 * same (productKey, productAuthUserId) pair returns the existing link
 * (alreadyLinked: true) instead of erroring - safe to retry after a
 * network failure, mirroring wegn-wsms's self-register-subscription
 * exactly.
 *
 * Explicitly, deliberately does NOT: create Business Membership, create
 * Staff or Partner records, replace or modify any product's own login,
 * issue any cross-product session or token, or send any invitation.
 * Those are later, separately approved tasks.
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

  let body: { secret?: string; productKey?: string; productAuthUserId?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const secret = typeof body.secret === "string" ? body.secret : "";
  const productKey = typeof body.productKey === "string" ? body.productKey.trim() : "";
  const productAuthUserId = typeof body.productAuthUserId === "string" ? body.productAuthUserId.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  const authz = authorizeOperation(secret, "link-account");
  if (!authz.ok) {
    return jsonResponse({ error: authz.error }, authz.status);
  }
  if (!productKey || !productAuthUserId || !email) {
    return jsonResponse({ error: "productKey, productAuthUserId, and email are required" }, 400);
  }
  const scopeCheck = authorizeProductKey(authz.entry, productKey);
  if (!scopeCheck.ok) {
    return jsonResponse({ error: scopeCheck.error }, scopeCheck.status);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  // Idempotency check first: if this exact (product, product_auth_user_id)
  // pair is already linked, return the existing link rather than
  // attempting an insert that would fail the UNIQUE constraint.
  const { data: existingLink, error: existingLinkErr } = await admin
    .from("account_links")
    .select("id, wegn_account_id")
    .eq("product_key", productKey)
    .eq("product_auth_user_id", productAuthUserId)
    .maybeSingle();
  if (existingLinkErr) {
    console.error("[link-account] existing-link lookup failed:", existingLinkErr);
    return jsonResponse({ error: "Lookup failed" }, 500);
  }
  if (existingLink) {
    return jsonResponse({ ok: true, alreadyLinked: true, wegnAccountId: existingLink.wegn_account_id });
  }

  // Find or create the WEGN Account by email. Two products' owners who
  // share an email become the same WEGN Account, by design - that is
  // the entire point of this service.
  const { data: existingAccount, error: accountLookupErr } = await admin
    .from("wegn_accounts")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (accountLookupErr) {
    console.error("[link-account] account lookup failed:", accountLookupErr);
    return jsonResponse({ error: "Lookup failed" }, 500);
  }

  let wegnAccountId = existingAccount?.id as string | undefined;
  if (!wegnAccountId) {
    const { data: newAccount, error: createErr } = await admin
      .from("wegn_accounts")
      .insert({ email })
      .select("id")
      .single();
    if (createErr) {
      console.error("[link-account] account creation failed:", createErr);
      return jsonResponse({ error: "Account creation failed" }, 500);
    }
    wegnAccountId = newAccount.id;
  }

  const { error: linkErr } = await admin.from("account_links").insert({
    wegn_account_id: wegnAccountId,
    product_key: productKey,
    product_auth_user_id: productAuthUserId,
  });
  if (linkErr) {
    console.error("[link-account] link creation failed:", linkErr);
    return jsonResponse({ error: "Link creation failed" }, 500);
  }

  return jsonResponse({ ok: true, alreadyLinked: false, wegnAccountId });
});
