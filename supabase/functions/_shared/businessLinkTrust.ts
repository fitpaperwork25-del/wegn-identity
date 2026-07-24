const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_WINDOW_MS = 5 * 60 * 1000;

export type BusinessLinkEnvelope = {
  requestId: string;
  issuedAt: string;
  expiresAt: string;
  productKey: string;
  productAuthUserId: string;
  externalBusinessId: string;
  ownerConfirmed: true;
  displayName: string;
  businessType: string | null;
  countryCode: string | null;
  wegnBusinessId: string | null;
};

export function validateBusinessLinkEnvelope(params: {
  envelope: BusinessLinkEnvelope;
  headerRequestId: string | null;
  nowMs?: number;
}): boolean {
  const { envelope } = params;
  const issued = Date.parse(envelope.issuedAt);
  const expires = Date.parse(envelope.expiresAt);
  const now = params.nowMs ?? Date.now();
  return SAFE_REQUEST_ID.test(envelope.requestId)
    && params.headerRequestId === envelope.requestId
    && Number.isFinite(issued)
    && Number.isFinite(expires)
    && expires > issued
    && expires - issued <= MAX_WINDOW_MS
    && issued <= now + 30_000
    && expires >= now;
}

export async function fingerprintBusinessLinkEnvelope(envelope: BusinessLinkEnvelope): Promise<string> {
  const canonical = JSON.stringify({
    requestId: envelope.requestId,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    productKey: envelope.productKey,
    productAuthUserId: envelope.productAuthUserId,
    externalBusinessId: envelope.externalBusinessId,
    ownerConfirmed: envelope.ownerConfirmed,
    displayName: envelope.displayName,
    businessType: envelope.businessType,
    countryCode: envelope.countryCode,
    wegnBusinessId: envelope.wegnBusinessId,
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
