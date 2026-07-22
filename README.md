# wegn-identity

The WEGN Identity Service — the platform's first shared service outside
of WSMS. Pure Supabase backend (migrations + Edge Functions), no
frontend, mirroring `wegn-wsms`'s own shape exactly, per
`docs/SPRINT2_IDENTITY_IMPLEMENTATION_PLAN.md` (in the `qrwegn` repo).

**Status: Task 1 (foundation) only.** This repository currently
establishes one capability — linking an existing product's own account
to a WEGN Account — and nothing else. No product is connected to it yet.
No existing product's authentication, login flow, or data is touched by
anything in this repository.

## Scope, as of Task 1

**In scope:**
- `wegn_accounts` — one row per real WEGN Account (id, email,
  created_at). Deliberately minimal — no roles, no business data.
- `account_links` — records that a given product's own `auth_user_id`
  belongs to a given WEGN Account.
- `link-account` — the one Edge Function that creates/finds a WEGN
  Account and records a link, idempotently.

**Explicitly out of scope for this repository, until a later, separately
approved task:** Business Membership, Business Registry, Staff tables,
Partner tables, any identity/account migration, Single Sign-On, JWT
replacement, cross-product login, and integration with Platform Admin,
WSMS, QRWegn, or Wegn Store. See
`docs/SPRINT2_IDENTITY_IMPLEMENTATION_PLAN.md` for the full sequencing.

## Why this repository exists, and why it's separate

Per the Identity Architecture and Sprint 2 planning documents: WEGN has
five independent Supabase Auth projects today and no shared identity
concept. This service is architecturally identical in shape to
`wegn-wsms` — its own repository, its own Supabase project, a narrow
contract — rather than being folded into Platform Admin (an internal-only
admin tool, the wrong trust domain for public-facing identity) or WSMS
(explicitly, permanently scoped to subscription lifecycle only, per its
own ADR-0001).

## Security model (Task 1, bootstrap phase)

A single shared secret (`IDENTITY_SERVICE_SECRET`, a Supabase Edge
Function secret — never a database row, never committed) authorizes
calls to `link-account`. This is a deliberate, documented simplification
for this foundation task, not an oversight: per-product secrets (the
pattern WSMS uses) require more than one real consumer to be worth the
added complexity, and no product is connected yet. Migrating to
per-product secrets is the natural first hardening step once a second
real consumer exists — the same "don't extract before a second consumer
proves the abstraction" principle already governing this ecosystem's
other shared services.

## Local development

```
supabase functions serve link-account --env-file .env.local
```

No `config.toml` is committed (matching `wegn-wsms`'s own convention) —
the project is linked via `supabase link` locally, not via a versioned
config file.
