export const API_VERSION = "2026-07-23";
export const KNOWN_PRODUCTS = [
  { productKey: "wegn-store", displayName: "WEGN Store" },
  { productKey: "qrwegn", displayName: "QRWegn" },
  { productKey: "qrbooker", displayName: "QRBooker" },
] as const;

export type HealthStatus = "healthy" | "needs_attention" | "unavailable" | "unknown";
export type SourceState = "fresh" | "stale" | "unavailable" | "unknown";

export type ProductLink = {
  product_key: string;
  external_business_id: string;
  verified_at: string;
};

export type RegistryBusiness = {
  id: string;
  display_name: string;
  business_type: string | null;
  country_code: string | null;
  lifecycle_status: "active" | "in_setup" | "suspended" | "archived" | "unknown";
  updated_at: string;
  role: "owner" | "administrator" | "member";
  productLinks: ProductLink[];
};

export type ProductAdapterBusiness = {
  externalBusinessId: string;
  sourceUpdatedAt: string | null;
  setup: { incomplete?: boolean; reasonCode?: string | null } | null;
  recentActivity: Array<{
    id: string;
    category: string;
    summary: string;
    occurredAt: string;
  }>;
};

export type WsmsTenant = {
  productKey: string;
  externalBusinessId: string;
  subscriptionStatus: string | null;
  serviceAccess: "available" | "restricted" | "suspended" | "unavailable" | "unknown";
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  gracePeriodEndsAt: string | null;
  cancelAtPeriodEnd: boolean | null;
  plan: string | null;
  billingInterval: string | null;
  amount: number | null;
  currency: string | null;
};

export type AdapterResult = {
  state: SourceState;
  asOf: string | null;
  businesses: Map<string, ProductAdapterBusiness>;
};

export type WsmsResult = {
  state: SourceState;
  asOf: string | null;
  tenants: Map<string, WsmsTenant>;
};

export type DestinationRow = {
  product_key: string;
  base_url: string;
  url_template: string | null;
};

type Attention = {
  code: "payment_due" | "trial_ending" | "service_suspended" | "setup_incomplete";
  severity: "critical" | "warning" | "information";
  summary: string;
  productKey: string;
  detectedAt: string;
  action: { kind: "manage_subscription" | "complete_setup"; destination: null; availability: "unavailable" };
};

const SUBSCRIPTION_MAP: Record<string, string> = {
  trialing: "trial",
  active: "active",
  grace_period: "grace_period",
  suspended: "suspended",
  cancelled: "cancelled",
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVITY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function productKey(productKey: string, externalBusinessId: string): string {
  return `${productKey}:${externalBusinessId}`;
}

function resolveLaunch(
  destinations: Map<string, DestinationRow>,
  productKey: string,
  externalBusinessId: string | null,
): { availability: "available" | "unavailable"; destination: string | null } {
  const row = destinations.get(productKey);
  if (!row) return { availability: "unavailable", destination: null };
  if (!row.url_template) return { availability: "available", destination: row.base_url };
  if (!externalBusinessId) return { availability: "unavailable", destination: null };
  return { availability: "available", destination: row.url_template.replaceAll("{externalBusinessId}", externalBusinessId) };
}

function attentionRank(attention: Attention[]): number {
  if (attention.some((item) => item.severity === "critical")) return 0;
  if (attention.some((item) => item.severity === "warning")) return 1;
  return 4;
}

export function normalizeBusiness(params: {
  business: RegistryBusiness;
  adapters: Map<string, AdapterResult>;
  wsms: WsmsResult;
  destinations: Map<string, DestinationRow>;
  now: Date;
}) {
  const { business, adapters, wsms, destinations, now } = params;
  const links = new Map(business.productLinks.map((link) => [link.product_key, link]));
  const attention: Attention[] = [];
  const activities: Array<{ id: string; category: string; summary: string; occurredAt: string; productKey: string }> = [];
  let requiredSourceUnavailable = false;
  let requiredSourceStale = false;
  let requiredValueUnknown = false;
  const sourceTimes = [now.toISOString()];

  const products = KNOWN_PRODUCTS.map((product) => {
    const link = links.get(product.productKey);
    if (!link) {
      return {
        productKey: product.productKey,
        displayName: product.displayName,
        connection: { status: "not_connected", verifiedAt: null },
        subscription: {
          status: "not_applicable", source: "wsms", sourceStatus: null, asOf: wsms.asOf,
          currentPeriodStart: null, currentPeriodEnd: null, gracePeriodEndsAt: null, cancelAtPeriodEnd: null,
          plan: null, billingInterval: null, amount: null, currency: null,
        },
        serviceAccess: { status: "not_applicable", source: "wsms", asOf: wsms.asOf },
        attention: [],
        activityAvailable: false,
        launch: { availability: "unavailable" as const, destination: null },
      };
    }

    const adapter = adapters.get(product.productKey);
    const productBusiness = adapter?.businesses.get(link.external_business_id);
    if (!adapter || adapter.state === "unavailable") requiredSourceUnavailable = true;
    else if (adapter.state === "stale") requiredSourceStale = true;
    else if (adapter.state === "unknown") requiredValueUnknown = true;
    else if (!productBusiness) requiredValueUnknown = true;
    if (adapter?.asOf) sourceTimes.push(adapter.asOf);

    const tenant = wsms.tenants.get(productKey(product.productKey, link.external_business_id));
    if (wsms.state === "unavailable") requiredSourceUnavailable = true;
    else if (wsms.state === "stale") requiredSourceStale = true;
    else if (wsms.state === "unknown") requiredValueUnknown = true;
    else if (!tenant || !tenant.subscriptionStatus) requiredValueUnknown = true;
    if (tenant?.serviceAccess === "unavailable") requiredSourceUnavailable = true;
    else if (tenant && tenant.serviceAccess !== "available") requiredValueUnknown = true;
    if (wsms.asOf) sourceTimes.push(wsms.asOf);

    const subscriptionStatus = tenant?.subscriptionStatus
      ? SUBSCRIPTION_MAP[tenant.subscriptionStatus] ?? "unknown"
      : wsms.state === "unavailable" ? "unavailable" : "unknown";
    const serviceAccess = wsms.state === "unavailable" ? "unavailable" : tenant?.serviceAccess ?? "unknown";
    const productAttention: Attention[] = [];
    const detectedAt = wsms.asOf ?? now.toISOString();

    if (tenant?.subscriptionStatus === "suspended" || tenant?.serviceAccess === "suspended") {
      productAttention.push({
        code: "service_suspended",
        severity: "critical",
        summary: `${product.displayName} service is suspended.`,
        productKey: product.productKey,
        detectedAt,
        action: { kind: "manage_subscription", destination: null, availability: "unavailable" },
      });
    } else if (tenant?.subscriptionStatus === "grace_period") {
      productAttention.push({
        code: "payment_due",
        severity: "warning",
        summary: `Payment is due for ${product.displayName}.`,
        productKey: product.productKey,
        detectedAt,
        action: { kind: "manage_subscription", destination: null, availability: "unavailable" },
      });
    }

    if (tenant?.subscriptionStatus === "trialing" && tenant.currentPeriodEnd) {
      const end = Date.parse(tenant.currentPeriodEnd);
      if (Number.isFinite(end) && end >= now.getTime() && end - now.getTime() <= SEVEN_DAYS_MS) {
        productAttention.push({
          code: "trial_ending",
          severity: "warning",
          summary: `${product.displayName} trial is ending soon.`,
          productKey: product.productKey,
          detectedAt,
          action: { kind: "manage_subscription", destination: null, availability: "unavailable" },
        });
      }
    }

    if (productBusiness?.setup?.incomplete === true) {
      productAttention.push({
        code: "setup_incomplete",
        severity: "warning",
        summary: `${product.displayName} setup is incomplete.`,
        productKey: product.productKey,
        detectedAt: adapter?.asOf ?? now.toISOString(),
        action: { kind: "complete_setup", destination: null, availability: "unavailable" },
      });
    }

    for (const activity of productBusiness?.recentActivity ?? []) {
      const occurred = Date.parse(activity.occurredAt);
      if (Number.isFinite(occurred) && occurred >= now.getTime() - ACTIVITY_WINDOW_MS) {
        activities.push({ ...activity, productKey: product.productKey });
      }
    }
    attention.push(...productAttention);

    return {
      productKey: product.productKey,
      displayName: product.displayName,
      connection: { status: "connected", verifiedAt: link.verified_at },
      subscription: {
        status: subscriptionStatus,
        source: "wsms",
        sourceStatus: tenant?.subscriptionStatus ?? null,
        asOf: wsms.asOf,
        currentPeriodStart: tenant?.currentPeriodStart ?? null,
        currentPeriodEnd: tenant?.currentPeriodEnd ?? null,
        gracePeriodEndsAt: tenant?.gracePeriodEndsAt ?? null,
        cancelAtPeriodEnd: tenant?.cancelAtPeriodEnd ?? null,
        plan: tenant?.plan ?? null,
        billingInterval: tenant?.billingInterval ?? null,
        amount: tenant?.amount ?? null,
        currency: tenant?.currency ?? null,
      },
      serviceAccess: { status: serviceAccess, source: "wsms", asOf: wsms.asOf },
      attention: productAttention,
      activityAvailable: !!productBusiness,
      launch: resolveLaunch(destinations, product.productKey, link.external_business_id),
    };
  });

  const hasConfirmedAttention = attention.length > 0 || business.lifecycle_status === "suspended";
  const health: HealthStatus =
    hasConfirmedAttention ? "needs_attention"
    : requiredSourceUnavailable ? "unavailable"
    : requiredSourceStale || requiredValueUnknown || business.lifecycle_status !== "active" ? "unknown"
    : "healthy";
  const healthReasons = [
    ...attention.map((item) => item.code),
    ...(business.lifecycle_status === "suspended" ? ["lifecycle_suspended"] : []),
    ...(requiredSourceUnavailable && !hasConfirmedAttention ? ["source_unavailable"] : []),
    ...(requiredValueUnknown && !hasConfirmedAttention && !requiredSourceUnavailable ? ["source_unknown"] : []),
  ];
  const latestAttentionAt = attention.map((item) => item.detectedAt).sort().at(-1) ?? null;
  const rank = health === "needs_attention"
    ? business.lifecycle_status === "suspended" ? 0 : attentionRank(attention)
    : health === "unavailable" ? 2 : health === "unknown" ? 3 : 4;
  const asOf = sourceTimes.sort().at(0) ?? business.updated_at;

  return {
    id: business.id,
    name: business.display_name,
    type: {
      value: business.business_type,
      label: business.business_type
        ? business.business_type.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
        : null,
      source: "business_registry",
      sourceValue: business.business_type,
    },
    country: business.country_code
      ? {
        code: business.country_code,
        label: new Intl.DisplayNames(["en"], { type: "region" }).of(business.country_code) ?? business.country_code,
        source: "business_registry",
      }
      : null,
    lifecycleStatus: business.lifecycle_status,
    access: { role: business.role },
    health: { status: health, evaluatedAt: now.toISOString(), reasons: healthReasons },
    products,
    recentActivity: activities
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, 3),
    freshness: {
      state: requiredSourceUnavailable ? "unavailable" : requiredSourceStale ? "stale" : requiredValueUnknown ? "unknown" : "fresh",
      asOf,
    },
    _sort: {
      rank,
      latestAttentionAt,
      normalizedName: business.display_name.toLocaleLowerCase("en"),
      id: business.id,
    },
  };
}

export function compareBusinesses(
  a: ReturnType<typeof normalizeBusiness>,
  b: ReturnType<typeof normalizeBusiness>,
): number {
  return a._sort.rank - b._sort.rank
    || (b._sort.latestAttentionAt ?? "").localeCompare(a._sort.latestAttentionAt ?? "")
    || a._sort.normalizedName.localeCompare(b._sort.normalizedName)
    || a.id.localeCompare(b.id);
}

export function cursorTuple(business: ReturnType<typeof normalizeBusiness>) {
  return business._sort;
}

export function canReturnConfirmedZero(params: {
  accountStatus: string;
  authoritativeMembershipReadSucceeded: boolean;
  authorizedBusinessCount: number;
}): boolean {
  return params.accountStatus === "ACTIVE"
    && params.authoritativeMembershipReadSucceeded
    && params.authorizedBusinessCount === 0;
}

export function returnedIdsStayWithinScope(requestedIds: Iterable<string>, returnedIds: Iterable<string>): boolean {
  const allowed = new Set(requestedIds);
  const seen = new Set<string>();
  for (const id of returnedIds) {
    if (!allowed.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}
