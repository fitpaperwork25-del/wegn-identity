-- Phase 2A-3: Team & Staff write surface.
--
-- The first mutation surface on wegn_business_memberships outside the
-- original owner-creation path (create_wegn_business_with_owner). Per
-- the Business Workspace design freeze §11 ("Team is a new write
-- surface on a registry that's never had one"), every function here
-- calls into the existing invariants already enforced by trigger
-- (enforce_business_active_owner, maintain_membership_revision,
-- preserve_revoked_membership_history) rather than reimplementing them,
-- and follows the exact SECURITY DEFINER / audit-context / idempotent-
-- consumer pattern already established by register_wegn_business_product_link
-- in 20260723020000_business_registry_foundation.sql.
--
-- Permission model (design freeze §8's own recommendation, taken as the
-- launch default since the doc leaves administrator write parity
-- "undecided" rather than settled): invite, role-change, and revoke are
-- owner-only. Accept is self-service by the invited email's own account
-- - nobody else can accept on their behalf. Ownership itself is never
-- granted or removed through these functions; that is a bigger decision
-- than Team & Staff's scope covers.
--
-- Rollback: see bottom of file.

CREATE TABLE wegn_business_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wegn_business_id uuid NOT NULL REFERENCES wegn_businesses(id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320),
  role text NOT NULL CHECK (role IN ('administrator', 'member')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by_wegn_account_id uuid NOT NULL REFERENCES wegn_accounts(id) ON DELETE RESTRICT,
  invited_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by_wegn_account_id uuid REFERENCES wegn_accounts(id),
  revoked_at timestamptz,
  CHECK (expires_at > invited_at),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL AND accepted_by_wegn_account_id IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

-- One pending invite per (business, email) at a time - mirrors the
-- membership table's own "one current grant" shape. A revoked or
-- accepted invite doesn't block a fresh one; it stays as immutable
-- history instead of being reused.
CREATE UNIQUE INDEX wegn_business_invites_pending_uidx
  ON wegn_business_invites (wegn_business_id, email)
  WHERE status = 'pending';

CREATE INDEX wegn_business_invites_business_idx
  ON wegn_business_invites (wegn_business_id, status);

CREATE INDEX wegn_business_invites_email_idx
  ON wegn_business_invites (email, status);

-- Once an invite leaves 'pending' it is immutable, same discipline as
-- preserve_revoked_membership_history for memberships.
CREATE OR REPLACE FUNCTION preserve_terminal_invite_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'invite_is_no_longer_pending';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wegn_business_invites_preserve_terminal_state
  BEFORE UPDATE ON wegn_business_invites
  FOR EACH ROW EXECUTE FUNCTION preserve_terminal_invite_state();

-- Extend the existing audit trigger (not a new one) so invite mutations
-- land in the same business_registry_audit_log as every other registry
-- write, using the same app.business_registry_* session context.
ALTER TABLE business_registry_audit_log ADD COLUMN invite_id uuid;

CREATE OR REPLACE FUNCTION audit_business_registry_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
  business_id uuid;
  membership_id uuid;
  link_id uuid;
  invite_id uuid;
  request_id text;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  request_id := NULLIF(current_setting('app.business_registry_request_id', true), '');
  IF request_id IS NULL THEN
    request_id := 'database-' || txid_current()::text || '-' || TG_TABLE_NAME;
  END IF;

  IF TG_TABLE_NAME = 'wegn_businesses' THEN
    business_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSIF TG_TABLE_NAME = 'wegn_business_memberships' THEN
    business_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.wegn_business_id ELSE NEW.wegn_business_id END;
    membership_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSIF TG_TABLE_NAME = 'wegn_business_product_links' THEN
    business_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.wegn_business_id ELSE NEW.wegn_business_id END;
    link_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSIF TG_TABLE_NAME = 'wegn_business_invites' THEN
    business_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.wegn_business_id ELSE NEW.wegn_business_id END;
    invite_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  END IF;

  INSERT INTO business_registry_audit_log (
    request_id,
    actor_wegn_account_id,
    actor_consumer,
    operation,
    outcome,
    wegn_business_id,
    membership_id,
    product_link_id,
    invite_id,
    before_state,
    after_state
  )
  VALUES (
    request_id,
    NULLIF(current_setting('app.business_registry_actor_account_id', true), '')::uuid,
    NULLIF(current_setting('app.business_registry_consumer', true), ''),
    TG_TABLE_NAME || '-' || lower(TG_OP),
    'success',
    business_id,
    membership_id,
    link_id,
    invite_id,
    old_row,
    new_row
  );

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wegn_business_invites_audit_mutation
  AFTER INSERT OR UPDATE ON wegn_business_invites
  FOR EACH ROW EXECUTE FUNCTION audit_business_registry_mutation();

-- Shared owner-authorization shape, inlined identically in every
-- function below (matching this file's existing style of inlining
-- rather than a shared helper, e.g. register_wegn_business_product_link's
-- own repeated authorization checks).

CREATE OR REPLACE FUNCTION create_business_team_invite(
  p_request_id text,
  p_consumer text,
  p_actor_wegn_account_id uuid,
  p_wegn_business_id uuid,
  p_email text,
  p_role text
)
RETURNS TABLE (invite_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  normalized_email text := lower(btrim(p_email));
  new_invite_id uuid;
  new_expires_at timestamptz := now() + interval '7 days';
BEGIN
  IF p_role NOT IN ('administrator', 'member') THEN
    RAISE EXCEPTION 'invalid_invite_role';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM wegn_business_memberships membership
    JOIN wegn_accounts account ON account.id = membership.wegn_account_id
    WHERE membership.wegn_business_id = p_wegn_business_id
      AND membership.wegn_account_id = p_actor_wegn_account_id
      AND membership.role = 'owner'
      AND membership.access_status = 'active'
      AND membership.valid_from <= now()
      AND (membership.valid_until IS NULL OR membership.valid_until > now())
      AND account.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'owner_authorization_required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM wegn_business_memberships membership
    JOIN wegn_accounts account ON account.id = membership.wegn_account_id
    WHERE membership.wegn_business_id = p_wegn_business_id
      AND account.email = normalized_email
      AND membership.access_status = 'active'
      AND membership.valid_from <= now()
      AND (membership.valid_until IS NULL OR membership.valid_until > now())
  ) THEN
    RAISE EXCEPTION 'already_a_member';
  END IF;

  IF EXISTS (
    SELECT 1 FROM wegn_business_invites
    WHERE wegn_business_id = p_wegn_business_id
      AND email = normalized_email
      AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'invite_already_pending';
  END IF;

  PERFORM set_config('app.business_registry_request_id', p_request_id, true);
  PERFORM set_config('app.business_registry_actor_account_id', p_actor_wegn_account_id::text, true);
  PERFORM set_config('app.business_registry_consumer', p_consumer, true);

  INSERT INTO wegn_business_invites (
    wegn_business_id, email, role, invited_by_wegn_account_id, expires_at
  )
  VALUES (
    p_wegn_business_id, normalized_email, p_role, p_actor_wegn_account_id, new_expires_at
  )
  RETURNING id INTO new_invite_id;

  RETURN QUERY SELECT new_invite_id, new_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION create_business_team_invite(text, text, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_business_team_invite(text, text, uuid, uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION accept_business_team_invite(
  p_request_id text,
  p_consumer text,
  p_actor_wegn_account_id uuid,
  p_invite_id uuid
)
RETURNS TABLE (wegn_business_id uuid, membership_id uuid, role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_invite wegn_business_invites%ROWTYPE;
  actor_email text;
  new_membership_id uuid;
BEGIN
  SELECT * INTO target_invite FROM wegn_business_invites WHERE id = p_invite_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invite_not_found';
  END IF;
  IF target_invite.status <> 'pending' THEN
    RAISE EXCEPTION 'invite_is_no_longer_pending';
  END IF;
  IF target_invite.expires_at <= now() THEN
    RAISE EXCEPTION 'invite_expired';
  END IF;

  SELECT email INTO actor_email FROM wegn_accounts
  WHERE id = p_actor_wegn_account_id AND status = 'ACTIVE';
  IF actor_email IS NULL THEN
    RAISE EXCEPTION 'active_account_required';
  END IF;
  IF actor_email <> target_invite.email THEN
    RAISE EXCEPTION 'invite_email_mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM wegn_business_memberships membership
    WHERE membership.wegn_business_id = target_invite.wegn_business_id
      AND membership.wegn_account_id = p_actor_wegn_account_id
      AND membership.access_status = 'active'
  ) THEN
    RAISE EXCEPTION 'already_a_member';
  END IF;

  PERFORM set_config('app.business_registry_request_id', p_request_id, true);
  PERFORM set_config('app.business_registry_actor_account_id', p_actor_wegn_account_id::text, true);
  PERFORM set_config('app.business_registry_consumer', p_consumer, true);

  INSERT INTO wegn_business_memberships (
    wegn_business_id, wegn_account_id, role, access_status
  )
  VALUES (
    target_invite.wegn_business_id, p_actor_wegn_account_id, target_invite.role, 'active'
  )
  RETURNING id INTO new_membership_id;

  UPDATE wegn_business_invites
  SET status = 'accepted', accepted_at = now(), accepted_by_wegn_account_id = p_actor_wegn_account_id
  WHERE id = p_invite_id;

  RETURN QUERY SELECT target_invite.wegn_business_id, new_membership_id, target_invite.role;
END;
$$;

REVOKE ALL ON FUNCTION accept_business_team_invite(text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_business_team_invite(text, text, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION revoke_business_team_invite(
  p_request_id text,
  p_consumer text,
  p_actor_wegn_account_id uuid,
  p_invite_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_invite wegn_business_invites%ROWTYPE;
BEGIN
  SELECT * INTO target_invite FROM wegn_business_invites WHERE id = p_invite_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invite_not_found';
  END IF;
  IF target_invite.status <> 'pending' THEN
    RAISE EXCEPTION 'invite_is_no_longer_pending';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM wegn_business_memberships membership
    JOIN wegn_accounts account ON account.id = membership.wegn_account_id
    WHERE membership.wegn_business_id = target_invite.wegn_business_id
      AND membership.wegn_account_id = p_actor_wegn_account_id
      AND membership.role = 'owner'
      AND membership.access_status = 'active'
      AND membership.valid_from <= now()
      AND (membership.valid_until IS NULL OR membership.valid_until > now())
      AND account.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'owner_authorization_required';
  END IF;

  PERFORM set_config('app.business_registry_request_id', p_request_id, true);
  PERFORM set_config('app.business_registry_actor_account_id', p_actor_wegn_account_id::text, true);
  PERFORM set_config('app.business_registry_consumer', p_consumer, true);

  UPDATE wegn_business_invites SET status = 'revoked', revoked_at = now() WHERE id = p_invite_id;
END;
$$;

REVOKE ALL ON FUNCTION revoke_business_team_invite(text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_business_team_invite(text, text, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION change_business_team_member_role(
  p_request_id text,
  p_consumer text,
  p_actor_wegn_account_id uuid,
  p_wegn_business_id uuid,
  p_membership_id uuid,
  p_new_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_role text;
  target_status text;
BEGIN
  IF p_new_role NOT IN ('administrator', 'member') THEN
    RAISE EXCEPTION 'invalid_target_role';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM wegn_business_memberships membership
    JOIN wegn_accounts account ON account.id = membership.wegn_account_id
    WHERE membership.wegn_business_id = p_wegn_business_id
      AND membership.wegn_account_id = p_actor_wegn_account_id
      AND membership.role = 'owner'
      AND membership.access_status = 'active'
      AND membership.valid_from <= now()
      AND (membership.valid_until IS NULL OR membership.valid_until > now())
      AND account.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'owner_authorization_required';
  END IF;

  SELECT role, access_status INTO target_role, target_status
  FROM wegn_business_memberships
  WHERE id = p_membership_id AND wegn_business_id = p_wegn_business_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership_not_found';
  END IF;
  IF target_status <> 'active' THEN
    RAISE EXCEPTION 'membership_not_active';
  END IF;
  IF target_role = 'owner' THEN
    RAISE EXCEPTION 'cannot_change_owner_role_here';
  END IF;

  PERFORM set_config('app.business_registry_request_id', p_request_id, true);
  PERFORM set_config('app.business_registry_actor_account_id', p_actor_wegn_account_id::text, true);
  PERFORM set_config('app.business_registry_consumer', p_consumer, true);

  UPDATE wegn_business_memberships SET role = p_new_role
  WHERE id = p_membership_id AND wegn_business_id = p_wegn_business_id;
END;
$$;

REVOKE ALL ON FUNCTION change_business_team_member_role(text, text, uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION change_business_team_member_role(text, text, uuid, uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION revoke_business_team_member(
  p_request_id text,
  p_consumer text,
  p_actor_wegn_account_id uuid,
  p_wegn_business_id uuid,
  p_membership_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_role text;
  target_status text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM wegn_business_memberships membership
    JOIN wegn_accounts account ON account.id = membership.wegn_account_id
    WHERE membership.wegn_business_id = p_wegn_business_id
      AND membership.wegn_account_id = p_actor_wegn_account_id
      AND membership.role = 'owner'
      AND membership.access_status = 'active'
      AND membership.valid_from <= now()
      AND (membership.valid_until IS NULL OR membership.valid_until > now())
      AND account.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'owner_authorization_required';
  END IF;

  SELECT role, access_status INTO target_role, target_status
  FROM wegn_business_memberships
  WHERE id = p_membership_id AND wegn_business_id = p_wegn_business_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership_not_found';
  END IF;
  IF target_status <> 'active' THEN
    RAISE EXCEPTION 'membership_not_active';
  END IF;
  IF target_role = 'owner' THEN
    RAISE EXCEPTION 'cannot_revoke_owner_here';
  END IF;

  PERFORM set_config('app.business_registry_request_id', p_request_id, true);
  PERFORM set_config('app.business_registry_actor_account_id', p_actor_wegn_account_id::text, true);
  PERFORM set_config('app.business_registry_consumer', p_consumer, true);

  UPDATE wegn_business_memberships SET access_status = 'revoked'
  WHERE id = p_membership_id AND wegn_business_id = p_wegn_business_id;
END;
$$;

REVOKE ALL ON FUNCTION revoke_business_team_member(text, text, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_business_team_member(text, text, uuid, uuid, uuid) TO service_role;

ALTER TABLE wegn_business_invites ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies - only the service-role-backed
-- functions above and the service-role client (Edge Functions) touch
-- this table, matching every other table in this registry.

-- Rollback:
-- DROP FUNCTION IF EXISTS revoke_business_team_member(text, text, uuid, uuid, uuid);
-- DROP FUNCTION IF EXISTS change_business_team_member_role(text, text, uuid, uuid, uuid, text);
-- DROP FUNCTION IF EXISTS revoke_business_team_invite(text, text, uuid, uuid);
-- DROP FUNCTION IF EXISTS accept_business_team_invite(text, text, uuid, uuid);
-- DROP FUNCTION IF EXISTS create_business_team_invite(text, text, uuid, uuid, text, text);
-- DROP TRIGGER IF EXISTS wegn_business_invites_audit_mutation ON wegn_business_invites;
-- DROP TRIGGER IF EXISTS wegn_business_invites_preserve_terminal_state ON wegn_business_invites;
-- DROP FUNCTION IF EXISTS preserve_terminal_invite_state();
-- ALTER TABLE business_registry_audit_log DROP COLUMN IF EXISTS invite_id;
-- DROP TABLE IF EXISTS wegn_business_invites;
