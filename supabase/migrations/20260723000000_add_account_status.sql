-- Task 2 preparation: adds exactly one field, per
-- docs/SPRINT2... Task 2 instructions. No other schema change, no new
-- tables. Additive and backward-compatible - every existing row (there
-- are none outside Task 1's already-cleaned-up test data) receives the
-- default, and account_links is untouched.
ALTER TABLE wegn_accounts
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE'
  CHECK (status IN ('ACTIVE', 'SUSPENDED', 'PENDING', 'DELETED'));
