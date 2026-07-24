import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeOperation, authorizeProductKey } from "../_shared/credentialRegistry.ts";
import { resolveRequestId, REQUEST_ID_HEADER } from "../_shared/requestId.ts";
import { logEvent } from "../_shared/logger.ts";
import { writeAuditLog } from "../_shared/auditLog.ts";
import {
  fingerprintBusinessLinkEnvelope,
  validateBusinessLinkEnvelope,
  type BusinessLinkEnvelope,
} from "../_shared/businessLinkTrust.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-request-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": REQUEST_ID_HEADER,
};

function response(requestId: string, body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ ...body, requestId }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", [REQUEST_ID_HEADER]: requestId },
  });
}

serve(async (req: Request) => {
  const requestId = resolveRequestId(req);
  const startedAt = Date.now();
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return response(requestId, { error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return response(requestId, { error: "Server is not configured" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey);

  let body: {
    secret?: unknown;
    productKey?: unknown;
    productAuthUserId?: unknown;
    externalBusinessId?: unknown;
    ownerConfirmed?: unknown;
    displayName?: unknown;
    businessType?: unknown;
    countryCode?: unknown;
    wegnBusinessId?: unknown;
    requestId?: unknown;
    issuedAt?: unknown;
    expiresAt?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return response(requestId, { error: "Invalid JSON body" }, 400);
  }

  const secret = typeof body.secret === "string" ? body.secret : "";
  const productKey = typeof body.productKey === "string" ? body.productKey.trim() : "";
  const productAuthUserId = typeof body.productAuthUserId === "string" ? body.productAuthUserId.trim() : "";
  const externalBusinessId = typeof body.externalBusinessId === "string" ? body.externalBusinessId.trim() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const businessType = typeof body.businessType === "string" ? body.businessType.trim() : null;
  const countryCode = typeof body.countryCode === "string" ? body.countryCode.trim().toUpperCase() : null;
  const wegnBusinessId = typeof body.wegnBusinessId === "string" ? body.wegnBusinessId.trim() : null;
  const bodyRequestId = typeof body.requestId === "string" ? body.requestId : "";
  const issuedAt = typeof body.issuedAt === "string" ? body.issuedAt : "";
  const expiresAt = typeof body.expiresAt === "string" ? body.expiresAt : "";

  const authz = authorizeOperation(secret, "register-business-link");
  if (!authz.ok) return response(requestId, { error: authz.error }, authz.status);
  if (!productKey) return response(requestId, { error: "productKey is required" }, 400);
  const productAuthz = authorizeProductKey(authz.entry, productKey);
  if (!productAuthz.ok) return response(requestId, { error: productAuthz.error }, productAuthz.status);

  if (!productKey || !UUID_PATTERN.test(productAuthUserId) || !UUID_PATTERN.test(externalBusinessId)
    || body.ownerConfirmed !== true || !displayName || displayName.length > 160
    || (wegnBusinessId !== null && !UUID_PATTERN.test(wegnBusinessId))
    || (countryCode !== null && !/^[A-Z]{2}$/.test(countryCode))) {
    return response(requestId, { error: "Invalid business link request" }, 400);
  }

  const envelope: BusinessLinkEnvelope = {
    requestId: bodyRequestId,
    issuedAt,
    expiresAt,
    productKey,
    productAuthUserId,
    externalBusinessId,
    ownerConfirmed: true,
    displayName,
    businessType,
    countryCode,
    wegnBusinessId,
  };
  if (!validateBusinessLinkEnvelope({
    envelope,
    headerRequestId: req.headers.get(REQUEST_ID_HEADER),
  }) || requestId !== bodyRequestId) {
    return response(requestId, { error: "Invalid or expired trust envelope" }, 400);
  }
  const requestFingerprint = await fingerprintBusinessLinkEnvelope(envelope);

  const { data: accountLink, error: accountLinkError } = await admin
    .from("account_links")
    .select("wegn_account_id")
    .eq("product_key", productKey)
    .eq("product_auth_user_id", productAuthUserId)
    .maybeSingle();
  if (accountLinkError) return response(requestId, { error: "Account link lookup failed" }, 500);
  if (!accountLink) return response(requestId, { error: "Product account is not linked to WEGN Identity" }, 409);

  const { data, error } = await admin.rpc("register_wegn_business_product_link", {
    p_request_id: requestId,
    p_consumer: authz.entry.consumer,
    p_issued_at: issuedAt,
    p_expires_at: expiresAt,
    p_request_fingerprint: requestFingerprint,
    p_wegn_account_id: accountLink.wegn_account_id,
    p_product_key: productKey,
    p_external_business_id: externalBusinessId,
    p_owner_confirmed: true,
    p_display_name: displayName,
    p_business_type: businessType,
    p_country_code: countryCode,
    p_wegn_business_id: wegnBusinessId,
  });

  if (error || !Array.isArray(data) || !data[0]) {
    logEvent("error", {
      requestId,
      operation: "register-business-link",
      outcome: "error",
      consumer: authz.entry.consumer,
      productKey,
      errorCode: "registry_link_failed",
      durationMs: Date.now() - startedAt,
    });
    void writeAuditLog(admin, {
      requestId,
      operation: "register-business-link",
      outcome: "error",
      consumer: authz.entry.consumer,
      productKey,
      wegnAccountId: accountLink.wegn_account_id,
      errorCode: "registry_link_failed",
    });
    const status = error?.code === "P0001" || error?.code === "23505" ? 409 : 500;
    return response(requestId, { error: "Business registry link failed" }, status);
  }

  const result = data[0] as {
    wegn_business_id: string;
    product_link_id: string;
    created_business: boolean;
    already_linked: boolean;
  };
  logEvent("info", {
    requestId,
    operation: "register-business-link",
    outcome: result.already_linked ? "already_linked" : "success",
    consumer: authz.entry.consumer,
    productKey,
    durationMs: Date.now() - startedAt,
  });
  void writeAuditLog(admin, {
    requestId,
    operation: "register-business-link",
    outcome: result.already_linked ? "already_linked" : "success",
    consumer: authz.entry.consumer,
    productKey,
    wegnAccountId: accountLink.wegn_account_id,
    metadata: {
      wegnBusinessId: result.wegn_business_id,
      productLinkId: result.product_link_id,
      createdBusiness: result.created_business,
    },
  });

  return response(requestId, {
    ok: true,
    wegnBusinessId: result.wegn_business_id,
    productLinkId: result.product_link_id,
    createdBusiness: result.created_business,
    alreadyLinked: result.already_linked,
  });
});
