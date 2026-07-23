/**
 * Sprint 2 Task 5 - per-consumer scoped credentials, replacing the single
 * shared IDENTITY_SERVICE_SECRET every caller used through Task 4.
 *
 * Per the task's own design requirement: a server-side registry mapping
 * credential -> consumer -> allowed operations -> allowed product key,
 * configured entirely from Supabase Edge Function secrets (never a
 * database table - there is no strong reason to persist these, and the
 * ecosystem's existing convention for shared-service secrets is already
 * env-based, e.g. WSMS's own per-product secrets).
 *
 * Cutover note: LEGACY_SHARED_SECRET keeps IDENTITY_SERVICE_SECRET valid,
 * unscoped (every operation, any productKey), only until every consumer
 * has been moved to its own scoped credential - see wegn-identity's
 * README.md "Security model" section. Once cutover is verified, delete
 * legacyEntry() and its env var entirely; do not leave it "just in case."
 */

export type Operation = "link-account" | "list-accounts";

export interface CredentialEntry {
  consumer: string;
  allowedOperations: Operation[];
  /** null = this credential is not restricted to a single productKey
   *  (used only by the legacy shared secret during cutover; every
   *  post-cutover scoped credential must set this). */
  allowedProductKey: string | null;
}

function legacyEntry(): CredentialEntry {
  return {
    consumer: "legacy-shared-secret",
    allowedOperations: ["link-account", "list-accounts"],
    allowedProductKey: null,
  };
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
    return { consumer: "platform-admin", allowedOperations: ["list-accounts"], allowedProductKey: null };
  }

  const legacy = Deno.env.get("IDENTITY_SERVICE_SECRET");
  if (legacy && secret === legacy) {
    return legacyEntry();
  }

  return null;
}

type AuthzResult = { ok: true; entry: CredentialEntry } | { ok: false; status: number; error: string };

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
    return { ok: false, status: 403, error: `This credential is not permitted to call ${operation}` };
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
