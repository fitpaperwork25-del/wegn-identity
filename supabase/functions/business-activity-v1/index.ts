import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyUserAuth } from "../_shared/verifyUserAuth.ts";
import { resolveRequestId, REQUEST_ID_HEADER } from "../_shared/requestId.ts";
import { logEvent } from "../_shared/logger.ts";
import { writeAuditLog } from "../_shared/auditLog.ts";
import { KNOWN_PRODUCTS, returnedIdsStayWithinScope } from "../_shared/portfolioContract.ts";

/**
 * Phase 2A-3 - paginated cross-product Activity Timeline for one
 * business, the full history behind Overview's frozen 3-item/90-day
 * summary. A new, separate read surface rather than a mode of
 * business-portfolio-v1 (design freeze §3, scr-activity): "a paginated
 * variant is new API surface, not new data collection." Re-verifies
 * membership itself rather than trusting a prior read, same principle
 * business-portfolio-v1 already applies to its own single-business path.
 *
 * The cursor here is a plain ISO timestamp, not the signed/HMAC cursor
 * portfolioCursor.ts uses for the account-scoped business list. That
 * cursor has to be tamper-proof because a forged one could skip the
 * server's own authorization-ordered pagination; this one can't - every
 * call re-checks membership independently of what the cursor says, and
 * a forged cursor only ever returns a different time-slice of data the
 * caller is already authorized to see.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-request-id, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": REQUEST_ID_HEADER,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const ADAPTER_TIMEOUT_MS = 5_000;

function jsonResponse(requestId: string, body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ requestId, ...body }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", [REQUEST_ID_HEADER]: requestId },
  });
}

function errorResponse(requestId: string, status: number, code: string, message: string): Response {
  logEvent(status >= 500 ? "error" : "warn", { requestId, operation: "business-activity-v1", outcome: "error", consumer: "wegn-home", errorCode: code });
  return jsonResponse(requestId, { error: { code, message } }, status);
}

function adapterConfig(productKey: string): { url: string; secret: string } | null {
  const prefix = productKey === "wegn-store" ? "WEGN_STORE"
    : productKey === "qrwegn" ? "QRWEGN"
    : productKey === "qrbooker" ? "QRBOOKER"
    : null;
  if (!prefix) return null;
  const url = Deno.env.get(`${prefix}_PORTFOLIO_URL`);
  const secret = Deno.env.get(`${prefix}_PORTFOLIO_SECRET`);
  return url && secret ? { url, secret } : null;
}

type ActivityItem = { id: string; category: string; summary: string; occurredAt: string; productKey: string };

async function loadProductActivityPage(
  productKey: string,
  externalBusinessId: string,
  cursor: string | null,
  limit: number,
  requestId: string,
  issuedAt: string,
  expiresAt: string,
): Promise<{ items: ActivityItem[]; sourceState: "fresh" | "unavailable"; hasMore: boolean }> {
  const config = adapterConfig(productKey);
  if (!config) return { items: [], sourceState: "unavailable", hasMore: false };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ADAPTER_TIMEOUT_MS);
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wegn-portfolio-secret": config.secret },
      body: JSON.stringify({
        productKey, requestId, issuedAt, expiresAt,
        externalBusinessIds: [externalBusinessId],
        activityCursor: cursor, activityLimit: limit,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`source_status_${response.status}`);
    const data = await response.json() as {
      productKey?: unknown; businesses?: unknown; nextCursor?: unknown;
    };
    if (data.productKey !== productKey) throw new Error("adapter_product_mismatch");
    const rows = Array.isArray(data.businesses) ? data.businesses as Array<{
      externalBusinessId?: unknown;
      recentActivity?: Array<{ id: string; category: string; summary: string; occurredAt: string }>;
    }> : [];
    const returnedIds = rows.map((row) => row.externalBusinessId).filter((id): id is string => typeof id === "string");
    if (!returnedIdsStayWithinScope([externalBusinessId], returnedIds)) throw new Error("adapter_scope_violation");
    const items = (rows[0]?.recentActivity ?? []).map((item) => ({ ...item, productKey }));
    return { items, sourceState: "fresh", hasMore: typeof data.nextCursor === "string" && !!data.nextCursor };
  } catch {
    return { items: [], sourceState: "unavailable", hasMore: false };
  } finally {
    clearTimeout(timeout);
  }
}

serve(async (req: Request) => {
  const requestId = resolveRequestId(req);
  const startedAt = Date.now();
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "GET") return errorResponse(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed.");

  const url = new URL(req.url);
  const businessId = url.searchParams.get("businessId") ?? "";
  const cursor = url.searchParams.get("cursor");
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? DEFAULT_LIMIT : Number(limitText);
  if (!UUID_PATTERN.test(businessId)) return errorResponse(requestId, 400, "INVALID_REQUEST", "A valid businessId is required.");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return errorResponse(requestId, 400, "INVALID_REQUEST", "limit is invalid.");
  if (cursor !== null && !Number.isFinite(Date.parse(cursor))) return errorResponse(requestId, 400, "INVALID_REQUEST", "cursor is invalid.");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) return errorResponse(requestId, 500, "INTERNAL_ERROR", "The activity service is not configured.");
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const verified = await verifyUserAuth({ supabaseUrl, supabaseAnonKey, authorizationHeader: req.headers.get("Authorization") });
  if (!verified?.email) return errorResponse(requestId, 401, "AUTHENTICATION_REQUIRED", "Authentication is required.");

  const email = verified.email.trim().toLowerCase();
  const { data: accountRows, error: accountError } = await admin.rpc("resolve_or_create_wegn_account", { p_email: email });
  const account = Array.isArray(accountRows) ? accountRows[0] : null;
  if (accountError || !account) return errorResponse(requestId, 503, "ACTIVITY_UNAVAILABLE", "The activity timeline is temporarily unavailable.");
  if (account.status !== "ACTIVE") return errorResponse(requestId, 403, "ACTIVITY_FORBIDDEN", "This account is not permitted to view this business.");

  const nowIso = new Date().toISOString();
  // Same "not found and not authorized look identical" principle as
  // business-portfolio-v1's own single-business path - a probing caller
  // gets an empty activity list either way, never a distinguishing error.
  const { data: linkRows, error: linkError } = await admin
    .from("wegn_business_memberships")
    .select("wegn_businesses!inner(wegn_business_product_links(product_key, external_business_id, link_status))")
    .eq("wegn_account_id", account.id)
    .eq("wegn_business_id", businessId)
    .eq("access_status", "active")
    .lte("valid_from", nowIso)
    .or(`valid_until.is.null,valid_until.gt.${nowIso}`)
    .limit(1);
  if (linkError) return errorResponse(requestId, 503, "ACTIVITY_UNAVAILABLE", "The activity timeline is temporarily unavailable.");

  const membership = (linkRows ?? [])[0] as unknown as {
    wegn_businesses: { wegn_business_product_links: Array<{ product_key: string; external_business_id: string; link_status: string }> }
      | { wegn_business_product_links: Array<{ product_key: string; external_business_id: string; link_status: string }> }[];
  } | undefined;
  const business = membership ? (Array.isArray(membership.wegn_businesses) ? membership.wegn_businesses[0] : membership.wegn_businesses) : null;
  const links = (business?.wegn_business_product_links ?? []).filter((link) => link.link_status === "active");

  const issuedAtMs = Date.now();
  const issuedAt = new Date(issuedAtMs).toISOString();
  const expiresAt = new Date(issuedAtMs + 5 * 60 * 1000).toISOString();

  const perProduct = await Promise.all(
    links
      .filter((link) => KNOWN_PRODUCTS.some((product) => product.productKey === link.product_key))
      .map((link) => loadProductActivityPage(link.product_key, link.external_business_id, cursor, limit, requestId, issuedAt, expiresAt)),
  );

  const merged = perProduct.flatMap((page) => page.items)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, limit);
  const hasMore = perProduct.some((page) => page.hasMore) || merged.length === limit && perProduct.some((page) => page.items.length === limit);
  const nextCursor = hasMore && merged.length > 0 ? merged[merged.length - 1].occurredAt : null;

  const sources = links
    .filter((link) => KNOWN_PRODUCTS.some((product) => product.productKey === link.product_key))
    .map((link, index) => ({ source: link.product_key, state: perProduct[index]?.sourceState ?? "unavailable" }));

  logEvent("info", { requestId, operation: "business-activity-v1", outcome: "success", consumer: "wegn-home", durationMs: Date.now() - startedAt });
  void writeAuditLog(admin, { requestId, operation: "business-activity-v1", outcome: "success", consumer: "wegn-home", wegnAccountId: account.id });

  return jsonResponse(requestId, { businessId, activity: merged, nextCursor, sources });
});
