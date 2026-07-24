import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { collectAllPages } from "../supabase/functions/_shared/collectPages.ts";
import {
  fingerprintBusinessLinkEnvelope,
  validateBusinessLinkEnvelope,
  type BusinessLinkEnvelope,
} from "../supabase/functions/_shared/businessLinkTrust.ts";
import {
  authorizeProductKey,
  resolveCredentialFromEnv,
} from "../supabase/functions/_shared/credentialRegistry.ts";

const nowMs = Date.parse("2026-07-23T18:30:00Z");
const envelope: BusinessLinkEnvelope = {
  requestId: "request_1",
  issuedAt: "2026-07-23T18:29:00Z",
  expiresAt: "2026-07-23T18:31:00Z",
  productKey: "wegn-store",
  productAuthUserId: "123e4567-e89b-42d3-a456-426614174000",
  externalBusinessId: "223e4567-e89b-42d3-a456-426614174000",
  ownerConfirmed: true,
  displayName: "Markato Grocery",
  businessType: "grocery",
  countryCode: "ET",
  wegnBusinessId: null,
};

test("business-link envelope requires matching request id and live five-minute window", () => {
  assert.equal(validateBusinessLinkEnvelope({ envelope, headerRequestId: "request_1", nowMs }), true);
  assert.equal(validateBusinessLinkEnvelope({ envelope, headerRequestId: "request_2", nowMs }), false);
  assert.equal(validateBusinessLinkEnvelope({ envelope, headerRequestId: "request_1", nowMs: Date.parse("2026-07-23T18:31:01Z") }), false);
});

test("business-link fingerprint is deterministic and changes with semantics", async () => {
  const fingerprint = await fingerprintBusinessLinkEnvelope(envelope);
  assert.equal(fingerprint, await fingerprintBusinessLinkEnvelope(envelope));
  assert.notEqual(fingerprint, await fingerprintBusinessLinkEnvelope({ ...envelope, externalBusinessId: "323e4567-e89b-42d3-a456-426614174000" }));
});

test("account and registry credentials are separated and product scoped", () => {
  const env = new Map([
    ["IDENTITY_CREDENTIAL_WEGN_STORE", "store-account"],
    ["IDENTITY_REGISTRY_CREDENTIAL_WEGN_STORE", "store-registry"],
    ["IDENTITY_REGISTRY_CREDENTIAL_QRWEGN", "qrwegn-registry"],
  ]);
  const read = (name: string) => env.get(name);
  const account = resolveCredentialFromEnv("store-account", read);
  const registry = resolveCredentialFromEnv("store-registry", read);
  const otherProduct = resolveCredentialFromEnv("qrwegn-registry", read);
  assert.deepEqual(account?.allowedOperations, ["link-account"]);
  assert.deepEqual(registry?.allowedOperations, ["register-business-link"]);
  assert.equal(registry?.allowedProductKey, "wegn-store");
  assert.equal(otherProduct?.allowedProductKey, "qrwegn");
  assert.notEqual(registry?.allowedProductKey, otherProduct?.allowedProductKey);
  assert.equal(registry ? authorizeProductKey(registry, "qrwegn").ok : true, false);
  assert.equal(otherProduct ? authorizeProductKey(otherProduct, "wegn-store").ok : true, false);
});

test("complete-set collection exhausts normal response limits", async () => {
  const source = Array.from({ length: 1_205 }, (_, index) => index);
  const result = await collectAllPages({
    pageSize: 500,
    fetchPage: async (from, to) => ({ data: source.slice(from, to + 1), error: null }),
  });
  assert.equal(result.error, null);
  assert.equal(result.data?.length, 1_205);
  assert.equal(result.data?.at(-1), 1_204);
});

test("database source enforces immutable revocation, history, replay, auditing, atomic accounts, and browser denial", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/20260723020000_business_registry_foundation.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /revoked_membership_is_immutable/);
  assert.match(sql, /WHERE access_status <> 'revoked'/);
  assert.match(sql, /business_registry_requests/);
  assert.match(sql, /request_id_reuse_conflict/);
  assert.match(sql, /idempotent_replay/);
  assert.match(sql, /audit_business_registry_mutation/);
  assert.match(sql, /ON CONFLICT \(email\) DO UPDATE/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/g);
  assert.doesNotMatch(sql, /CREATE POLICY/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION register_wegn_business_product_link/);
});

test("endpoint source filters active effective memberships by the resolved account", () => {
  const source = readFileSync(
    new URL("../supabase/functions/business-portfolio-v1/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /\.eq\("wegn_account_id", account\.id\)/);
  assert.match(source, /\.eq\("access_status", "active"\)/);
  assert.match(source, /\.lte\("valid_from", nowIso\)/);
  assert.match(source, /valid_until\.is\.null,valid_until\.gt/);
});
