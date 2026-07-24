import assert from "node:assert/strict";
import test from "node:test";
import {
  canReturnConfirmedZero,
  compareBusinesses,
  normalizeBusiness,
  returnedIdsStayWithinScope,
  type AdapterResult,
  type DestinationRow,
  type RegistryBusiness,
  type WsmsResult,
} from "../supabase/functions/_shared/portfolioContract.ts";

const now = new Date("2026-07-23T18:30:00Z");

function business(overrides: Partial<RegistryBusiness> = {}): RegistryBusiness {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    display_name: "Markato Grocery",
    business_type: "grocery",
    country_code: "ET",
    lifecycle_status: "active",
    updated_at: "2026-07-23T18:29:00Z",
    role: "owner",
    productLinks: [{
      product_key: "wegn-store",
      external_business_id: "00000000-0000-0000-0000-000000000101",
      verified_at: "2026-07-23T17:00:00Z",
    }],
    ...overrides,
  };
}

function adapters(state: "fresh" | "unavailable" = "fresh"): Map<string, AdapterResult> {
  return new Map([["wegn-store", {
    state,
    asOf: state === "fresh" ? "2026-07-23T18:29:30Z" : null,
    businesses: state === "fresh"
      ? new Map([["00000000-0000-0000-0000-000000000101", {
        externalBusinessId: "00000000-0000-0000-0000-000000000101",
        sourceUpdatedAt: "2026-07-23T18:00:00Z",
        setup: null,
        recentActivity: [],
      }]])
      : new Map(),
  }]]);
}

function wsms(
  status = "active",
  state: "fresh" | "unavailable" = "fresh",
  serviceAccess?: "available" | "restricted" | "suspended" | "unavailable" | "unknown",
): WsmsResult {
  return {
    state,
    asOf: state === "fresh" ? "2026-07-23T18:29:45Z" : null,
    tenants: state === "fresh"
      ? new Map([["wegn-store:00000000-0000-0000-0000-000000000101", {
        productKey: "wegn-store",
        externalBusinessId: "00000000-0000-0000-0000-000000000101",
        subscriptionStatus: status,
        serviceAccess: serviceAccess ?? (status === "grace_period" ? "restricted" : status === "suspended" ? "suspended" : "available"),
        currentPeriodStart: null,
        currentPeriodEnd: null,
        gracePeriodEndsAt: null,
        cancelAtPeriodEnd: false,
        plan: "Growth",
        billingInterval: "monthly",
        amount: 1200,
        currency: "ETB",
      }]])
      : new Map(),
  };
}

function destinations(rows: DestinationRow[] = [{ product_key: "wegn-store", base_url: "https://wegn-store-app.vercel.app", url_template: null }]): Map<string, DestinationRow> {
  return new Map(rows.map((row) => [row.product_key, row]));
}

test("healthy requires current product and WSMS truth", () => {
  const result = normalizeBusiness({ business: business(), adapters: adapters(), wsms: wsms(), destinations: destinations(), now });
  assert.equal(result.health.status, "healthy");
});

test("source outage never becomes healthy or attention", () => {
  const result = normalizeBusiness({ business: business(), adapters: adapters("unavailable"), wsms: wsms(), destinations: destinations(), now });
  assert.equal(result.health.status, "unavailable");
  assert.deepEqual(result.health.reasons, ["source_unavailable"]);
  assert.equal(result.products[0].attention.length, 0);
});

test("unknown WSMS record never defaults to healthy", () => {
  const unavailableSubscription: WsmsResult = {
    state: "fresh",
    asOf: "2026-07-23T18:29:45Z",
    tenants: new Map(),
  };
  const result = normalizeBusiness({ business: business(), adapters: adapters(), wsms: unavailableSubscription, destinations: destinations(), now });
  assert.equal(result.health.status, "unknown");
});

test("explicitly available service access is required for healthy", () => {
  const result = normalizeBusiness({ business: business(), adapters: adapters(), wsms: wsms("active", "fresh", "available"), destinations: destinations(), now });
  assert.equal(result.health.status, "healthy");
});

test("restricted service access without a confirmed attention reason is not healthy", () => {
  const result = normalizeBusiness({ business: business(), adapters: adapters(), wsms: wsms("active", "fresh", "restricted"), destinations: destinations(), now });
  assert.equal(result.health.status, "unknown");
});

test("suspended service access is needs attention", () => {
  const result = normalizeBusiness({ business: business(), adapters: adapters(), wsms: wsms("active", "fresh", "suspended"), destinations: destinations(), now });
  assert.equal(result.health.status, "needs_attention");
});

test("unknown service access is never healthy", () => {
  const result = normalizeBusiness({ business: business(), adapters: adapters(), wsms: wsms("active", "fresh", "unknown"), destinations: destinations(), now });
  assert.equal(result.health.status, "unknown");
});

test("unavailable service access is unavailable, never healthy", () => {
  const result = normalizeBusiness({ business: business(), adapters: adapters(), wsms: wsms("active", "fresh", "unavailable"), destinations: destinations(), now });
  assert.equal(result.health.status, "unavailable");
});

test("grace period produces payment due without changing subscription vocabulary", () => {
  const result = normalizeBusiness({ business: business(), adapters: adapters(), wsms: wsms("grace_period"), destinations: destinations(), now });
  assert.equal(result.health.status, "needs_attention");
  assert.equal(result.products[0].subscription.status, "grace_period");
  assert.equal(result.products[0].attention[0]?.code, "payment_due");
});

test("confirmed suspension outranks a simultaneous source outage", () => {
  const result = normalizeBusiness({
    business: business(),
    adapters: adapters("unavailable"),
    wsms: wsms("suspended"),
    destinations: destinations(),
    now,
  });
  assert.equal(result.health.status, "needs_attention");
  assert.equal(result.products[0].attention[0]?.severity, "critical");
});

test("attention-first sorting is deterministic", () => {
  const healthy = normalizeBusiness({
    business: business({ id: "00000000-0000-0000-0000-000000000002", display_name: "Alpha" }),
    adapters: adapters(),
    wsms: wsms(),
    destinations: destinations(),
    now,
  });
  const attention = normalizeBusiness({
    business: business({ id: "00000000-0000-0000-0000-000000000003", display_name: "Zulu" }),
    adapters: adapters(),
    wsms: wsms("suspended"),
    destinations: destinations(),
    now,
  });
  assert.deepEqual([healthy, attention].sort(compareBusinesses).map((item) => item.id), [attention.id, healthy.id]);
});

test("unlinked products remain not connected and do not borrow account links", () => {
  const result = normalizeBusiness({
    business: business({ productLinks: [] }),
    adapters: new Map(),
    wsms: { state: "fresh", asOf: now.toISOString(), tenants: new Map() },
    destinations: destinations(),
    now,
  });
  assert.ok(result.products.every((product) => product.connection.status === "not_connected"));
});

test("confirmed zero requires a current authoritative active-account evaluation", () => {
  assert.equal(canReturnConfirmedZero({
    accountStatus: "ACTIVE",
    authoritativeMembershipReadSucceeded: true,
    authorizedBusinessCount: 0,
  }), true);
  assert.equal(canReturnConfirmedZero({
    accountStatus: "ACTIVE",
    authoritativeMembershipReadSucceeded: false,
    authorizedBusinessCount: 0,
  }), false);
  assert.equal(canReturnConfirmedZero({
    accountStatus: "SUSPENDED",
    authoritativeMembershipReadSucceeded: true,
    authorizedBusinessCount: 0,
  }), false);
});

test("launch resolves to the product's base URL when no tenant template exists", () => {
  const result = normalizeBusiness({ business: business(), adapters: adapters(), wsms: wsms(), destinations: destinations(), now });
  assert.deepEqual(result.products[0].launch, { availability: "available", destination: "https://wegn-store-app.vercel.app" });
});

test("launch is unavailable when the product has no destination registry row", () => {
  const result = normalizeBusiness({ business: business(), adapters: adapters(), wsms: wsms(), destinations: new Map(), now });
  assert.deepEqual(result.products[0].launch, { availability: "unavailable", destination: null });
});

test("launch is unavailable for a not-connected product regardless of the registry", () => {
  const result = normalizeBusiness({ business: business({ productLinks: [] }), adapters: new Map(), wsms: { state: "fresh", asOf: now.toISOString(), tenants: new Map() }, destinations: destinations(), now });
  assert.deepEqual(result.products[0].launch, { availability: "unavailable", destination: null });
});

test("launch substitutes the caller's own verified externalBusinessId into a tenant template", () => {
  const templated = destinations([{ product_key: "wegn-store", base_url: "https://wegn-store-app.vercel.app", url_template: "https://wegn-store-app.vercel.app/business/{externalBusinessId}" }]);
  const result = normalizeBusiness({ business: business(), adapters: adapters(), wsms: wsms(), destinations: templated, now });
  assert.deepEqual(result.products[0].launch, {
    availability: "available",
    destination: "https://wegn-store-app.vercel.app/business/00000000-0000-0000-0000-000000000101",
  });
});

test("adapter results fail tenant isolation for extra or duplicate ids", () => {
  const requested = ["business-a", "business-b"];
  assert.equal(returnedIdsStayWithinScope(requested, ["business-a"]), true);
  assert.equal(returnedIdsStayWithinScope(requested, ["business-a", "business-c"]), false);
  assert.equal(returnedIdsStayWithinScope(requested, ["business-a", "business-a"]), false);
});
