-- ========================================
-- WEGN Identity Service - core schema, Task 1 (foundation only)
-- Scope: exactly two tables, per docs/SPRINT2_IDENTITY_IMPLEMENTATION_PLAN.md
-- Section 7. Deliberately minimal - no roles, no Business Membership, no
-- Business Registry, no Staff, no Partner data. Nothing here migrates,
-- modifies, or references any existing product's own data - every
-- account_links row is created only via link-account, one row at a
-- time, by a caller presenting a product's own auth_user_id.
--
-- Access model: mirrors wegn-wsms's own convention exactly (see that
-- repo's 20260720_wsms_core_schema.sql) - no end-user-facing login of
-- its own. RLS is enabled on both tables as defense in depth, but no
-- policy grants anon or authenticated anything - only the service_role
-- (used exclusively by link-account) can touch this data.
-- Rollback: see bottom of file
-- ========================================

CREATE TABLE wegn_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per (product, that product's own auth user) pairing. Links an
-- existing product account to a wegn_accounts row without copying,
-- modifying, or depending on that product's own data - product_key and
-- product_auth_user_id are opaque references, exactly like WSMS's own
-- tenants.external_business_id convention.
CREATE TABLE account_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wegn_account_id uuid NOT NULL REFERENCES wegn_accounts(id) ON DELETE CASCADE,
  product_key text NOT NULL,
  product_auth_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Idempotency for link-account: a retried call for the same product
  -- account returns the existing link instead of erroring or duplicating,
  -- the same natural-uniqueness pattern WSMS's self-register-subscription
  -- already uses (a database constraint, not a caller-supplied key).
  UNIQUE (product_key, product_auth_user_id)
);

CREATE INDEX idx_account_links_wegn_account_id ON account_links(wegn_account_id);

ALTER TABLE wegn_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_links ENABLE ROW LEVEL SECURITY;
-- No policies added - service_role bypasses RLS entirely and is the
-- only caller (via link-account's use of the service-role key). Nothing
-- for anon or authenticated to be granted yet, by design.

-- ========================================
-- Rollback:
--   DROP TABLE IF EXISTS account_links;
--   DROP TABLE IF EXISTS wegn_accounts;
-- ========================================
