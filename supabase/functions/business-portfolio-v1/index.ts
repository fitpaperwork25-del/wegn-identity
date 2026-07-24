import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyUserAuth } from "../_shared/verifyUserAuth.ts";
import { resolveRequestId, REQUEST_ID_HEADER } from "../_shared/requestId.ts";
import { logEvent } from "../_shared/logger.ts";
import { writeAuditLog } from "../_shared/auditLog.ts";
import {
  API_VERSION,
  KNOWN_PRODUCTS,
  compareBusinesses,
  canReturnConfirmedZero,
  cursorTuple,
  normalizeBusiness,
  returnedIdsStayWithinScope,
  type AdapterResult,
  type ProductAdapterBusiness,
  type RegistryBusiness,
  type SourceState,
  type WsmsResult,
  type WsmsTenant,
} from "../_shared/portfolioContract.ts";
import {
  CURSOR_TTL_MS,
  createPortfolioCursor,
  parsePortfolioCursor,
  resolveCursorStartIndex,
} from "../_shared/portfolioCursor.ts";
import { collectAllPages } from "../_shared/collectPages.ts";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const ADAPTER_TIMEOUT_MS = 5_000;
const MEMBERSHIP_PAGE_SIZE = 500;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-request-id, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": REQUEST_ID_HEADER,
};

function jsonResponse(requestId: string, body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ apiVersion: API_VERSION, requestId, ...body }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", [REQUEST_ID_HEADER]: requestId },
  });
}

function errorResponse(requestId: string, status: number, code: string, message: string, retryable: boolean): Response {
  logEvent(status >= 500 ? "error" : "warn", {
    requestId,
    operation: "business-portfolio-v1",
    outcome: "error",
    consumer: "wegn-home",
    errorCode: code,
  });
  return jsonResponse(requestId, { error: { code, message, retryable } }, status);
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

async function fetchJson(url: string, secret: string, body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ADAPTER_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wegn-portfolio-secret": secret },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`source_status_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function sourceState(asOf: string | null): SourceState {
  if (!asOf) return "unknown";
  const age = Date.now() - Date.parse(asOf);
  if (!Number.isFinite(age)) return "unknown";
  if (age < -30_000) return "unknown";
  if (age <= 5 * 60 * 1000) return "fresh";
  if (age <= 24 * 60 * 60 * 1000) return "stale";
  return "unavailable";
}

async function loadProductAdapter(
  productKey: string,
  externalBusinessIds: string[],
  requestId: string,
  issuedAt: string,
  expiresAt: string,
): Promise<AdapterResult> {
  if (externalBusinessIds.length === 0) {
    return { state: "fresh", asOf: issuedAt, businesses: new Map() };
  }
  const config = adapterConfig(productKey);
  if (!config) return { state: "unavailable", asOf: null, businesses: new Map() };
  try {
    const chunks = Array.from(
      { length: Math.ceil(externalBusinessIds.length / MAX_LIMIT) },
      (_, index) => externalBusinessIds.slice(index * MAX_LIMIT, (index + 1) * MAX_LIMIT),
    );
    const responses = await Promise.all(chunks.map((chunk) => fetchJson(config.url, config.secret, {
      productKey, requestId, issuedAt, expiresAt, externalBusinessIds: chunk,
    }))) as Array<{
      productKey?: unknown;
      asOf?: unknown;
      businesses?: unknown;
    }>;
    const asOfValues = responses
      .map((data) => typeof data.asOf === "string" ? data.asOf : null)
      .filter((value): value is string => !!value)
      .sort();
    const asOf = asOfValues[0] ?? null;
    const allowed = new Set(externalBusinessIds);
    const businesses = new Map<string, ProductAdapterBusiness>();
    for (const data of responses) {
      if (data.productKey !== productKey) throw new Error("adapter_product_mismatch");
      const rows = Array.isArray(data.businesses) ? data.businesses as ProductAdapterBusiness[] : [];
      const returnedIds: string[] = [];
      for (const row of rows) {
        if (!row || typeof row.externalBusinessId !== "string") throw new Error("adapter_scope_violation");
        returnedIds.push(row.externalBusinessId);
      }
      if (!returnedIdsStayWithinScope(allowed, returnedIds)) {
        throw new Error("adapter_scope_violation");
      }
      for (const row of rows) {
        if (businesses.has(row.externalBusinessId)) throw new Error("adapter_scope_violation");
        businesses.set(row.externalBusinessId, row);
      }
    }
    return { state: sourceState(asOf), asOf, businesses };
  } catch {
    return { state: "unavailable", asOf: null, businesses: new Map() };
  }
}

async function loadWsms(
  links: Array<{ productKey: string; externalBusinessId: string }>,
  requestId: string,
  issuedAt: string,
  expiresAt: string,
): Promise<WsmsResult> {
  if (links.length === 0) return { state: "fresh", asOf: issuedAt, tenants: new Map() };
  const url = Deno.env.get("WSMS_PORTFOLIO_URL");
  const secret = Deno.env.get("WSMS_PORTFOLIO_SECRET");
  if (!url || !secret) return { state: "unavailable", asOf: null, tenants: new Map() };
  try {
    const chunks = Array.from(
      { length: Math.ceil(links.length / MAX_LIMIT) },
      (_, index) => links.slice(index * MAX_LIMIT, (index + 1) * MAX_LIMIT),
    );
    const responses = await Promise.all(chunks.map((chunk) =>
      fetchJson(url, secret, { requestId, issuedAt, expiresAt, tenants: chunk })
    )) as Array<{
      asOf?: unknown;
      tenants?: unknown;
    }>;
    const asOfValues = responses
      .map((data) => typeof data.asOf === "string" ? data.asOf : null)
      .filter((value): value is string => !!value)
      .sort();
    const asOf = asOfValues[0] ?? null;
    const allowed = new Set(links.map((link) => `${link.productKey}:${link.externalBusinessId}`));
    const tenants = new Map<string, WsmsTenant>();
    for (const data of responses) {
      for (const tenant of Array.isArray(data.tenants) ? data.tenants as WsmsTenant[] : []) {
        const key = `${tenant.productKey}:${tenant.externalBusinessId}`;
        if (!allowed.has(key) || tenants.has(key)) throw new Error("wsms_scope_violation");
        tenants.set(key, tenant);
      }
    }
    return { state: sourceState(asOf), asOf, tenants };
  } catch {
    return { state: "unavailable", asOf: null, tenants: new Map() };
  }
}

serve(async (req: Request) => {
  const requestId = resolveRequestId(req);
  const startedAt = Date.now();
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "GET") return errorResponse(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed.", false);

  const url = new URL(req.url);
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? DEFAULT_LIMIT : Number(limitText);
  const cursorText = url.searchParams.get("cursor");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return errorResponse(requestId, 400, "INVALID_REQUEST", "The portfolio request is invalid.", false);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const cursorSecret = Deno.env.get("PORTFOLIO_CURSOR_SECRET");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey || !cursorSecret) {
    return errorResponse(requestId, 500, "INTERNAL_ERROR", "The portfolio service is not configured.", false);
  }
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const verified = await verifyUserAuth({
    supabaseUrl,
    supabaseAnonKey,
    authorizationHeader: req.headers.get("Authorization"),
  });
  if (!verified?.email) {
    return errorResponse(requestId, 401, "AUTHENTICATION_REQUIRED", "Authentication is required.", false);
  }

  const email = verified.email.trim().toLowerCase();
  const { data: accountRows, error: accountError } = await admin.rpc("resolve_or_create_wegn_account", {
    p_email: email,
  });
  const account = Array.isArray(accountRows) ? accountRows[0] : null;
  if (accountError || !account) {
    return errorResponse(requestId, 503, "PORTFOLIO_UNAVAILABLE", "The business portfolio is temporarily unavailable.", true);
  }
  if (account.status !== "ACTIVE") {
    return errorResponse(requestId, 403, "PORTFOLIO_FORBIDDEN", "This account is not permitted to access the business portfolio.", false);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const { data: memberships, error: membershipError } = await collectAllPages({
    pageSize: MEMBERSHIP_PAGE_SIZE,
    fetchPage: async (from, to) => {
      const result = await admin
        .from("wegn_business_memberships")
        .select(`
          role,
          wegn_businesses!inner(
            id, display_name, business_type, country_code, lifecycle_status, updated_at,
            wegn_business_product_links(product_key, external_business_id, verified_at, link_status)
          )
        `)
        .eq("wegn_account_id", account.id)
        .eq("access_status", "active")
        .lte("valid_from", nowIso)
        .or(`valid_until.is.null,valid_until.gt.${nowIso}`)
        .order("wegn_business_id", { ascending: true })
        .range(from, to);
      return { data: result.data, error: result.error };
    },
  });

  if (membershipError) {
    return errorResponse(requestId, 503, "PORTFOLIO_UNAVAILABLE", "The business portfolio is temporarily unavailable.", true);
  }

  const registryBusinesses: RegistryBusiness[] = (memberships ?? []).map((membership) => {
    const business = membership.wegn_businesses as unknown as {
      id: string;
      display_name: string;
      business_type: string | null;
      country_code: string | null;
      lifecycle_status: RegistryBusiness["lifecycle_status"];
      updated_at: string;
      wegn_business_product_links: Array<{
        product_key: string;
        external_business_id: string;
        verified_at: string;
        link_status: string;
      }>;
    };
    return {
      id: business.id,
      display_name: business.display_name,
      business_type: business.business_type,
      country_code: business.country_code,
      lifecycle_status: business.lifecycle_status,
      updated_at: business.updated_at,
      role: membership.role,
      productLinks: (business.wegn_business_product_links ?? [])
        .filter((link) => link.link_status === "active")
        .map((link) => ({
          product_key: link.product_key,
          external_business_id: link.external_business_id,
          verified_at: link.verified_at,
        })),
    };
  });

  if (canReturnConfirmedZero({
    accountStatus: account.status,
    authoritativeMembershipReadSucceeded: true,
    authorizedBusinessCount: registryBusinesses.length,
  })) {
    const generatedAt = new Date().toISOString();
    void writeAuditLog(admin, {
      requestId, operation: "business-portfolio-v1", outcome: "confirmed_zero",
      consumer: "wegn-home", wegnAccountId: account.id,
    });
    return jsonResponse(requestId, {
      state: "fresh",
      generatedAt,
      freshness: { state: "fresh", oldestRequiredSourceAt: generatedAt },
      kpis: { totalBusinesses: 0, healthyBusinesses: 0, businessesNeedingAttention: 0 },
      businesses: [],
      sources: [{ source: "business_registry", state: "fresh", asOf: generatedAt }],
      page: { limit, nextCursor: null },
    });
  }

  const issuedAtMs = Date.now();
  const issuedAt = new Date(issuedAtMs).toISOString();
  const expiresAt = new Date(issuedAtMs + 5 * 60 * 1000).toISOString();
  const idsByProduct = new Map<string, string[]>();
  const allLinks: Array<{ productKey: string; externalBusinessId: string }> = [];
  for (const business of registryBusinesses) {
    for (const link of business.productLinks) {
      allLinks.push({ productKey: link.product_key, externalBusinessId: link.external_business_id });
      const ids = idsByProduct.get(link.product_key) ?? [];
      ids.push(link.external_business_id);
      idsByProduct.set(link.product_key, ids);
    }
  }

  const [adapterEntries, wsms, destinationRows] = await Promise.all([
    Promise.all(KNOWN_PRODUCTS.map(async ({ productKey }) => [
      productKey,
      await loadProductAdapter(productKey, idsByProduct.get(productKey) ?? [], requestId, issuedAt, expiresAt),
    ] as const)),
    loadWsms(allLinks, requestId, issuedAt, expiresAt),
    admin.from("wegn_product_destinations").select("product_key, base_url, url_template"),
  ]);
  const adapters = new Map(adapterEntries);
  const destinations = new Map((destinationRows.data ?? []).map((row) => [row.product_key, row]));

  const normalized = registryBusinesses
    .map((business) => normalizeBusiness({ business, adapters, wsms, destinations, now }))
    .sort(compareBusinesses);

  let startIndex = 0;
  if (cursorText) {
    const cursor = await parsePortfolioCursor({
      secret: cursorSecret,
      value: cursorText,
      accountId: account.id,
      limit,
    });
    if (!cursor) return errorResponse(requestId, 400, "INVALID_REQUEST", "The portfolio cursor is invalid or expired.", false);
    const resolvedIndex = resolveCursorStartIndex(cursor, normalized);
    if (resolvedIndex === null) return errorResponse(requestId, 400, "INVALID_REQUEST", "The portfolio cursor is no longer valid.", false);
    startIndex = resolvedIndex;
  }

  const pageBusinesses = normalized.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < normalized.length;
  const last = pageBusinesses.at(-1);
  const nextCursor = hasMore && last
    ? await createPortfolioCursor(cursorSecret, {
      accountId: account.id,
      limit,
      lastBusinessId: last.id,
      lastSort: cursorTuple(last),
      expiresAt: Date.now() + CURSOR_TTL_MS,
    })
    : null;

  const sourceRows = [
    { source: "business_registry", state: "fresh", asOf: nowIso },
    { source: "wsms", state: wsms.state, asOf: wsms.asOf },
    ...KNOWN_PRODUCTS
      .filter(({ productKey }) => (idsByProduct.get(productKey)?.length ?? 0) > 0)
      .map(({ productKey }) => {
        const source = adapters.get(productKey);
        return { source: productKey, state: source?.state ?? "unavailable", asOf: source?.asOf ?? null };
      }),
  ];
  const hasUnavailable = sourceRows.some((source) => source.state === "unavailable" || source.state === "unknown");
  const hasStale = sourceRows.some((source) => source.state === "stale");
  const state = hasUnavailable ? "partial" : hasStale ? "stale" : "fresh";
  const generatedAt = new Date().toISOString();
  const sourceDates = sourceRows.map((source) => source.asOf).filter((value): value is string => !!value).sort();

  logEvent("info", {
    requestId,
    operation: "business-portfolio-v1",
    outcome: state,
    consumer: "wegn-home",
    durationMs: Date.now() - startedAt,
  });
  void writeAuditLog(admin, {
    requestId, operation: "business-portfolio-v1", outcome: state,
    consumer: "wegn-home", wegnAccountId: account.id,
    metadata: { totalBusinesses: normalized.length, returnedBusinesses: pageBusinesses.length },
  });

  return jsonResponse(requestId, {
    state,
    generatedAt,
    freshness: { state, oldestRequiredSourceAt: sourceDates[0] ?? null },
    kpis: {
      totalBusinesses: normalized.length,
      healthyBusinesses: normalized.filter((business) => business.health.status === "healthy").length,
      businessesNeedingAttention: normalized.filter((business) => business.health.status === "needs_attention").length,
    },
    businesses: pageBusinesses.map(({ _sort: _discard, ...business }) => business),
    sources: sourceRows,
    page: { limit, nextCursor },
  });
});
