-- Sprint 2 Task 6B: dedicated audit table for Identity operations
-- (link-account, list-accounts, health-summary), separate from the
-- product tables so retention/access policy can differ independently.
-- Never stores credential values, tokens, or passwords - see
-- _shared/auditLog.ts's own header for the exact fields it writes.

CREATE TABLE identity_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id text NOT NULL,
  consumer text,
  operation text NOT NULL,
  outcome text NOT NULL,
  product_key text,
  wegn_account_id uuid,
  account_link_id uuid,
  error_code text,
  metadata jsonb
);

-- Read pattern is "recent rows, optionally filtered by consumer/outcome" -
-- see health-summary's queries. No FK to wegn_accounts/account_links:
-- an audit row must survive even if the account it refers to is later
-- deleted (not possible today, but the audit trail's job is to outlive
-- the data it describes).
CREATE INDEX identity_audit_log_occurred_at_idx ON identity_audit_log (occurred_at DESC);
CREATE INDEX identity_audit_log_consumer_idx ON identity_audit_log (consumer);

ALTER TABLE identity_audit_log ENABLE ROW LEVEL SECURITY;
-- Zero grants, same as wegn_accounts/account_links - only the
-- service-role key (used exclusively server-side in Edge Functions)
-- can read or write this table.

-- Rollback: DROP TABLE identity_audit_log;
