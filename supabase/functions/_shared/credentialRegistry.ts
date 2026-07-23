/**
 * Sprint 2 Task 5 - per-consumer scoped credentials. Every consumer
 * (QRWegn, Wegn Store, Platform Admin) has been cut over and verified;
 * the old shared IDENTITY_SERVICE_SECRET is no longer accepted here, and
 * the secret itself has been deleted from every project that held it.
 *
 * A server-side registry mapping credential -> consumer -> allowed
 * operations -> allowed product key, configured entirely from Supabase
 * Edge Function secrets (never a database table - there is no strong
 * reason to persist these, and the ecosystem's existing convention for
 * shared-service secrets is already env-based, e.g. WSMS's own
 * per-product secrets).
 */

export type Operation = "link-account" | "list-accounts" | "health-summary";

export interface CredentialEntry {
  consumer: string;
  allowedOperations: Operation[];
  /** The single productKey this credential may use with link-account.
   *  Every credential in this registry is consumer-specific, so this is
   *  always set (list-accounts credentials just never consult it). */
  allowedProductKey: string | null;
}

/**
 * Resolves a submitted secret to its credential entry, or null if the
 * secret matches nothing configured. Never logs or returns the secret
 * value itself - only ever the resolved consumer name.
 */
export function resolveCredential(secret: string): CredentialEntry | null {
  if (!secret) return null;

  const qrwegn = Deno.env.get("IDENTITY_CREDENTIAL_QRWEGN");
  if (qrwegn && secret === qrwegn) {
    return { consumer: "qrwegn", allowedOperations: ["link-account"], allowedProductKey: "qrwegn" };
  }

  const wegnStore = Deno.env.get("IDENTITY_CREDENTIAL_WEGN_STORE");
  if (wegnStore && secret === wegnStore) {
    return { consumer: "wegn-store", allowedOperations: ["link-account"], allowedProductKey: "wegn-store" };
  }

  const platformAdmin = Deno.env.get("IDENTITY_CREDENTIAL_PLATFORM_ADMIN");
  if (platformAdmin && secret === platformAdmin) {
    // Sprint 2 Task 6B: health-summary added to the same read-only
    // credential - it is operational visibility, not a new capability,
    // and Platform Admin is the only consumer this task's health
    // summary is for. Still cannot call link-account.
    return { consumer: "platform-admin", allowedOperations: ["list-accounts", "health-summary"], allowedProductKey: null };
  }

  return null;
}

type AuthzResult =
  | { ok: true; entry: CredentialEntry }
  // entry is present on a 403 (the credential resolved to a real
  // consumer, just not this operation) so callers can still audit which
  // consumer attempted it - absent on a 401, where there is genuinely no
  // known consumer to attribute the attempt to.
  | { ok: false; status: number; error: string; entry?: CredentialEntry };

/**
 * Step 1: is this secret valid, and is it allowed to call this operation
 * at all? Deliberately separate from the productKey scope check below -
 * callers should run their own required-field validation (400s) between
 * the two, so a request with a genuinely missing productKey gets a clear
 * "field required" error rather than being misreported as a productKey
 * scope violation.
 */
export function authorizeOperation(secret: string, operation: Operation): AuthzResult {
  const entry = resolveCredential(secret);
  if (!entry) {
    return { ok: false, status: 401, error: "Invalid credentials" };
  }
  if (!entry.allowedOperations.includes(operation)) {
    return { ok: false, status: 403, error: `This credential is not permitted to call ${operation}`, entry };
  }
  return { ok: true, entry };
}

/** Step 2, link-account only: does this credential's scope permit the
 *  specific productKey being requested? Call only after confirming
 *  productKey itself is present. */
export function authorizeProductKey(entry: CredentialEntry, productKey: string): AuthzResult {
  if (entry.allowedProductKey && productKey !== entry.allowedProductKey) {
    return { ok: false, status: 403, error: "This credential is not permitted to use the requested productKey" };
  }
  return { ok: true, entry };
}
