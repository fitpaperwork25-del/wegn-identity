# Credential Rotation Runbook

Sprint 2 Task 6B. Covers rotating any one of the three per-consumer
scoped credentials (`IDENTITY_CREDENTIAL_QRWEGN`,
`IDENTITY_CREDENTIAL_WEGN_STORE`, `IDENTITY_CREDENTIAL_PLATFORM_ADMIN`)
without an outage. Do not rotate a production credential just to
rehearse this document — only when there is a real reason (suspected
exposure, scheduled rotation policy, offboarding, incident response).

Every step below operates on `supabase/functions/_shared/credentialRegistry.ts`
and the two projects involved (wegn-identity, and the one consumer being
rotated). Nothing here touches `wegn_accounts` or `account_links` — a
credential rotation is purely an authorization-layer change.

## 0. Before you start

- Confirm which consumer you are rotating: QRWegn, Wegn Store, or Platform Admin.
- Confirm you have deploy access to wegn-identity and to that one consumer's project.
- Record the current time and the reason for rotation (see "Evidence to capture" below).

## 1. Generate a new credential

Generate a fresh random secret — the same shape as the existing ones (32 random bytes, hex-encoded):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Do not reuse, derive from, or pattern-match the old value. Store it only
in your working secrets manager for the duration of this rotation, never
in a file that gets committed.

## 2. Temporarily accept both the old and new credential for this one consumer

`resolveCredential()` currently checks exactly one env var per consumer
(e.g. `IDENTITY_CREDENTIAL_QRWEGN`). To dual-accept during rotation,
add a second, temporary check for that same consumer immediately below
the existing one, reading a second env var suffixed `_NEXT`:

```ts
const qrwegnNext = Deno.env.get("IDENTITY_CREDENTIAL_QRWEGN_NEXT");
if (qrwegnNext && secret === qrwegnNext) {
  return { consumer: "qrwegn", allowedOperations: ["link-account"], allowedProductKey: "qrwegn" };
}
```

Set `IDENTITY_CREDENTIAL_QRWEGN_NEXT` (or the equivalent `_NEXT` suffix
for whichever consumer you're rotating) on wegn-identity to the new
value from Step 1:

```bash
supabase secrets set IDENTITY_CREDENTIAL_QRWEGN_NEXT=<new-value> --project-ref qzljgmjjiglkmpdeoicl
```

Deploy `link-account` and `list-accounts` (and `health-summary`, if
rotating Platform Admin) so the dual-accept code is live. At this point
the OLD credential still works unchanged — nothing has been asked to
stop using it yet.

## 3. Update the consumer to use the new credential

In that one consumer's own project, set its `IDENTITY_CREDENTIAL` secret
(or Vercel env var, for Platform Admin) to the new value, then deploy:

```bash
# QRWegn or Wegn Store:
supabase secrets set IDENTITY_CREDENTIAL=<new-value> --project-ref <consumer-project-ref>
supabase functions deploy link-identity-account --project-ref <consumer-project-ref> --no-verify-jwt

# Platform Admin:
vercel env rm IDENTITY_CREDENTIAL production --yes
echo -n "<new-value>" | vercel env add IDENTITY_CREDENTIAL production
vercel --prod --yes
```

## 4. Verify allowed and forbidden behavior

Using the **new** credential, confirm:
- The consumer's allowed operation still succeeds (e.g. QRWegn can still `link-account` with `productKey: "qrwegn"`).
- Every forbidden case still correctly fails (wrong productKey → 403, wrong operation → 403).

Using the **old** credential, confirm it still works too (expected during the dual-accept window — this is not yet the point where it's cut off).

Trigger a real request from the consumer itself (e.g. an actual owner login) rather than only a synthetic call, and confirm a matching `identity_audit_log` row appears with `outcome: "success"` and the correct `consumer`.

## 5. Remove the old credential

Once the new credential has been live and verified for a reasonable bake period (a few hours to a day, depending on traffic):

1. Remove the `_NEXT`-suffixed dual-accept branch from `credentialRegistry.ts` (delete the temporary code block from Step 2).
2. Deploy `link-account`/`list-accounts`/`health-summary` again.
3. Delete the old value from wegn-identity: `supabase secrets unset IDENTITY_CREDENTIAL_QRWEGN_NEXT --project-ref qzljgmjjiglkmpdeoicl` (the `_NEXT` var is no longer needed — the new value now lives under the primary name once you also update the primary check to read the value that was in `_NEXT`, or simply set the primary env var to the new value and skip keeping `_NEXT` around at all).
4. Confirm the old credential value is now rejected with a clean `401`.

## 6. Rollback

If the new credential causes unexpected failures after Step 3: revert
that one consumer back to the old credential value (still valid, since
the dual-accept window in Step 2 is still live) and redeploy that
consumer only. No change to wegn-identity is needed to roll back — the
old credential was never removed until Step 5, so rollback is just
"point the consumer back."

If something goes wrong *after* Step 5 (old credential already removed)
and the new credential turns out to be bad: generate a fresh credential
and repeat this runbook from Step 1. Do not attempt to un-delete the old
value — none is retained anywhere, by design.

## 7. Emergency revocation (suspected compromise)

If a credential is suspected to be exposed or compromised, do not wait
for a graceful rotation:

1. Immediately `supabase secrets unset IDENTITY_CREDENTIAL_<CONSUMER>` on wegn-identity — this alone makes the credential stop working everywhere, instantly, even before the affected consumer has a replacement.
2. Confirm the consumer's real traffic is now failing closed: `link-account`/`list-accounts` calls from that consumer return `401`, and — critically — the consumer's own login flow is unaffected, because linking is fire-and-forget and never blocks login (see `identityClient.ts` in each consumer repo).
3. Generate a new credential (Step 1) and restore service for that consumer as quickly as possible (Steps 2–4, but you can skip the dual-accept bake period given the urgency — go straight to setting the new value as the primary env var on both sides).
4. Review `identity_audit_log` for the revoked credential's `consumer` name over the suspected exposure window, looking for any `outcome: "success"` rows you cannot account for.

## Evidence to capture during any rotation

- Reason for rotation, and who requested/approved it.
- Timestamp the old credential was generated (if known) and timestamp of this rotation.
- The `request_id` of at least one successful post-rotation call per allowed operation, for the audit trail.
- Confirmation (screenshot or copied response) that the old credential returns `401` after Step 5.
- Do not capture or store the credential value itself anywhere in this evidence.
