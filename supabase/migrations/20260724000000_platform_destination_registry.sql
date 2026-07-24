-- Sprint 5 Phase 1E: Platform Destination Registry.
-- Per SPRINT5_PHASE1E_DESTINATION_REGISTRY_DESIGN_FREEZE.md (wegn-home
-- repo). Purely additive: no existing table, function, or trigger is
-- touched. No foreign key to or from any existing table.

CREATE TABLE wegn_product_destinations (
  product_key text PRIMARY KEY,
  base_url text NOT NULL,
  url_template text,
  supports_tenant_deep_link boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (product_key IN ('wegn-store', 'qrwegn', 'qrbooker')),
  CHECK (base_url ~ '^https://'),
  CHECK (url_template IS NULL OR url_template ~ '^https://'),
  CHECK (supports_tenant_deep_link = (url_template IS NOT NULL))
);

ALTER TABLE wegn_product_destinations ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies. Only business-portfolio-v1's
-- service-role client reads this table; nothing writes to it at
-- runtime - rows are maintained by migration, same as KNOWN_PRODUCTS.

-- Seed values are already-public production URLs, already displayed in
-- wegn-home/src/lib/products.ts today - not new or invented data.
-- url_template stays null for all three: WEGN Store has no confirmed
-- tenant-deep-link capability (no URL routing in wegn-store-app), and
-- QRWegn/QRBooker's capability is unconfirmed (repos unavailable for
-- inspection). Becoming tenant-deep-linkable later is a data change to
-- these rows, not a schema or code change.
INSERT INTO wegn_product_destinations (product_key, base_url) VALUES
  ('wegn-store', 'https://wegn-store-app.vercel.app'),
  ('qrwegn', 'https://qrserve-v3.vercel.app/register'),
  ('qrbooker', 'https://www.qrbooker.app');
