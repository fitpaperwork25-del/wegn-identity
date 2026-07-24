-- Sprint 5 Phase 1B Foundation: canonical WEGN Business Registry.
-- This schema owns only platform business identity, canonical portfolio
-- profile/lifecycle, WEGN-wide membership, and product mappings.
-- Product operational data remains product-owned; subscription and
-- entitlement remain WSMS-owned.

CREATE TABLE wegn_businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  business_type text,
  country_code text CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  lifecycle_status text NOT NULL DEFAULT 'in_setup'
    CHECK (lifecycle_status IN ('active', 'in_setup', 'suspended', 'archived', 'unknown')),
  profile_source_product_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wegn_business_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wegn_business_id uuid NOT NULL REFERENCES wegn_businesses(id) ON DELETE RESTRICT,
  wegn_account_id uuid NOT NULL REFERENCES wegn_accounts(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner', 'administrator', 'member')),
  access_status text NOT NULL DEFAULT 'active'
    CHECK (access_status IN ('active', 'suspended', 'revoked')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  granted_at timestamptz NOT NULL DEFAULT now(),
  suspended_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (role <> 'owner' OR valid_until IS NULL),
  CHECK ((access_status = 'suspended') = (suspended_at IS NOT NULL)),
  CHECK ((access_status = 'revoked') = (revoked_at IS NOT NULL))
);

-- One current grant per account/business. Revoked rows remain immutable
-- history, and a future regrant creates a new row rather than rewriting
-- the revoked record.
CREATE UNIQUE INDEX wegn_business_memberships_current_grant_uidx
  ON wegn_business_memberships (wegn_business_id, wegn_account_id)
  WHERE access_status <> 'revoked';

CREATE TABLE wegn_business_product_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wegn_business_id uuid NOT NULL REFERENCES wegn_businesses(id) ON DELETE RESTRICT,
  product_key text NOT NULL CHECK (length(btrim(product_key)) BETWEEN 1 AND 80),
  external_business_id uuid NOT NULL,
  link_status text NOT NULL DEFAULT 'active' CHECK (link_status IN ('active', 'removed')),
  verified_at timestamptz NOT NULL,
  removed_at timestamptz,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((link_status = 'removed') = (removed_at IS NOT NULL))
);

CREATE UNIQUE INDEX wegn_business_product_links_active_external_uidx
  ON wegn_business_product_links (product_key, external_business_id)
  WHERE link_status = 'active';

CREATE UNIQUE INDEX wegn_business_product_links_active_business_product_uidx
  ON wegn_business_product_links (wegn_business_id, product_key)
  WHERE link_status = 'active';

CREATE INDEX wegn_business_memberships_account_idx
  ON wegn_business_memberships (wegn_account_id, access_status);

CREATE INDEX wegn_business_product_links_business_idx
  ON wegn_business_product_links (wegn_business_id, link_status);

CREATE TABLE business_registry_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id text NOT NULL,
  actor_wegn_account_id uuid,
  actor_consumer text,
  operation text NOT NULL,
  outcome text NOT NULL,
  wegn_business_id uuid,
  membership_id uuid,
  product_link_id uuid,
  reason text,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb
);

CREATE INDEX business_registry_audit_log_business_idx
  ON business_registry_audit_log (wegn_business_id, occurred_at DESC);

CREATE TABLE business_registry_requests (
  request_id text PRIMARY KEY,
  consumer text NOT NULL,
  product_key text NOT NULL,
  request_fingerprint text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  response jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(request_id) BETWEEN 1 AND 100),
  CHECK (expires_at > issued_at),
  CHECK (expires_at - issued_at <= interval '5 minutes')
);

CREATE INDEX business_registry_requests_expires_at_idx
  ON business_registry_requests (expires_at);

CREATE OR REPLACE FUNCTION set_business_registry_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER wegn_businesses_set_updated_at
  BEFORE UPDATE ON wegn_businesses
  FOR EACH ROW EXECUTE FUNCTION set_business_registry_updated_at();

CREATE TRIGGER wegn_business_memberships_set_updated_at
  BEFORE UPDATE ON wegn_business_memberships
  FOR EACH ROW EXECUTE FUNCTION set_business_registry_updated_at();

CREATE TRIGGER wegn_business_product_links_set_updated_at
  BEFORE UPDATE ON wegn_business_product_links
  FOR EACH ROW EXECUTE FUNCTION set_business_registry_updated_at();

CREATE OR REPLACE FUNCTION maintain_membership_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.access_status = 'revoked' THEN
    RAISE EXCEPTION 'revoked_membership_is_immutable';
  END IF;

  IF ROW(NEW.role, NEW.access_status, NEW.valid_from, NEW.valid_until)
     IS DISTINCT FROM
     ROW(OLD.role, OLD.access_status, OLD.valid_from, OLD.valid_until)
  THEN
    NEW.revision = OLD.revision + 1;
  END IF;

  IF NEW.access_status = 'suspended' AND OLD.access_status IS DISTINCT FROM 'suspended' THEN
    NEW.suspended_at = now();
  ELSIF NEW.access_status <> 'suspended' THEN
    NEW.suspended_at = NULL;
  END IF;

  IF NEW.access_status = 'revoked' AND OLD.access_status IS DISTINCT FROM 'revoked' THEN
    NEW.revoked_at = now();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER wegn_business_memberships_maintain_revision
  BEFORE UPDATE ON wegn_business_memberships
  FOR EACH ROW EXECUTE FUNCTION maintain_membership_revision();

CREATE OR REPLACE FUNCTION preserve_revoked_membership_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.access_status = 'revoked' THEN
    RAISE EXCEPTION 'revoked_membership_is_immutable';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER wegn_business_memberships_preserve_revoked_delete
  BEFORE DELETE ON wegn_business_memberships
  FOR EACH ROW EXECUTE FUNCTION preserve_revoked_membership_history();

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
    old_row,
    new_row
  );

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wegn_businesses_audit_mutation
  AFTER INSERT OR UPDATE OR DELETE ON wegn_businesses
  FOR EACH ROW EXECUTE FUNCTION audit_business_registry_mutation();

CREATE TRIGGER wegn_business_memberships_audit_mutation
  AFTER INSERT OR UPDATE OR DELETE ON wegn_business_memberships
  FOR EACH ROW EXECUTE FUNCTION audit_business_registry_mutation();

CREATE TRIGGER wegn_business_product_links_audit_mutation
  AFTER INSERT OR UPDATE OR DELETE ON wegn_business_product_links
  FOR EACH ROW EXECUTE FUNCTION audit_business_registry_mutation();

CREATE OR REPLACE FUNCTION enforce_business_active_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_business_id uuid;
BEGIN
  target_business_id := COALESCE(NEW.wegn_business_id, OLD.wegn_business_id);

  IF EXISTS (SELECT 1 FROM wegn_businesses WHERE id = target_business_id)
     AND NOT EXISTS (
       SELECT 1
       FROM wegn_business_memberships membership
       JOIN wegn_accounts account ON account.id = membership.wegn_account_id
       WHERE membership.wegn_business_id = target_business_id
         AND membership.role = 'owner'
         AND membership.access_status = 'active'
         AND membership.valid_from <= now()
         AND (membership.valid_until IS NULL OR membership.valid_until > now())
         AND account.status = 'ACTIVE'
     )
  THEN
    RAISE EXCEPTION 'business_requires_active_owner';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER wegn_business_memberships_require_owner
  AFTER INSERT OR UPDATE OR DELETE ON wegn_business_memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_business_active_owner();

CREATE OR REPLACE FUNCTION enforce_new_business_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM wegn_business_memberships membership
    JOIN wegn_accounts account ON account.id = membership.wegn_account_id
    WHERE membership.wegn_business_id = NEW.id
      AND membership.role = 'owner'
      AND membership.access_status = 'active'
      AND membership.valid_from <= now()
      AND (membership.valid_until IS NULL OR membership.valid_until > now())
      AND account.status = 'ACTIVE'
  )
  THEN
    RAISE EXCEPTION 'business_requires_active_owner';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER wegn_businesses_require_owner
  AFTER INSERT ON wegn_businesses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_new_business_owner();

CREATE OR REPLACE FUNCTION prevent_last_owner_account_deactivation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE' AND EXISTS (
    SELECT 1
    FROM wegn_business_memberships membership
    WHERE membership.wegn_account_id = NEW.id
      AND membership.role = 'owner'
      AND membership.access_status = 'active'
      AND membership.valid_from <= now()
      AND NOT EXISTS (
        SELECT 1
        FROM wegn_business_memberships replacement
        JOIN wegn_accounts replacement_account ON replacement_account.id = replacement.wegn_account_id
        WHERE replacement.wegn_business_id = membership.wegn_business_id
          AND replacement.wegn_account_id <> NEW.id
          AND replacement.role = 'owner'
          AND replacement.access_status = 'active'
          AND replacement.valid_from <= now()
          AND replacement_account.status = 'ACTIVE'
      )
  ) THEN
    RAISE EXCEPTION 'cannot_deactivate_last_active_owner';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wegn_accounts_preserve_business_owner
  BEFORE UPDATE OF status ON wegn_accounts
  FOR EACH ROW EXECUTE FUNCTION prevent_last_owner_account_deactivation();

CREATE OR REPLACE FUNCTION resolve_or_create_wegn_account(p_email text)
RETURNS TABLE (id uuid, status text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO wegn_accounts (email)
  VALUES (lower(btrim(p_email)))
  ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
  RETURNING wegn_accounts.id, wegn_accounts.status;
$$;

REVOKE ALL ON FUNCTION resolve_or_create_wegn_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_or_create_wegn_account(text) TO service_role;

CREATE OR REPLACE FUNCTION create_wegn_business_with_owner(
  p_wegn_account_id uuid,
  p_display_name text,
  p_business_type text DEFAULT NULL,
  p_country_code text DEFAULT NULL,
  p_lifecycle_status text DEFAULT 'in_setup',
  p_profile_source_product_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  business_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM wegn_accounts
    WHERE id = p_wegn_account_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'active_account_required';
  END IF;

  INSERT INTO wegn_businesses (
    display_name, business_type, country_code, lifecycle_status, profile_source_product_key
  )
  VALUES (
    btrim(p_display_name), NULLIF(btrim(p_business_type), ''),
    CASE WHEN p_country_code IS NULL THEN NULL ELSE upper(btrim(p_country_code)) END,
    p_lifecycle_status, NULLIF(btrim(p_profile_source_product_key), '')
  )
  RETURNING id INTO business_id;

  INSERT INTO wegn_business_memberships (
    wegn_business_id, wegn_account_id, role, access_status
  )
  VALUES (business_id, p_wegn_account_id, 'owner', 'active');

  RETURN business_id;
END;
$$;

REVOKE ALL ON FUNCTION create_wegn_business_with_owner(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_wegn_business_with_owner(uuid, text, text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION register_wegn_business_product_link(
  p_request_id text,
  p_consumer text,
  p_issued_at timestamptz,
  p_expires_at timestamptz,
  p_request_fingerprint text,
  p_wegn_account_id uuid,
  p_product_key text,
  p_external_business_id uuid,
  p_owner_confirmed boolean,
  p_display_name text,
  p_business_type text DEFAULT NULL,
  p_country_code text DEFAULT NULL,
  p_wegn_business_id uuid DEFAULT NULL
)
RETURNS TABLE (
  wegn_business_id uuid,
  product_link_id uuid,
  created_business boolean,
  already_linked boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_business_id uuid;
  target_link_id uuid;
  existing_business_id uuid;
  did_create boolean := false;
  request_claimed integer := 0;
  existing_request business_registry_requests%ROWTYPE;
  response_body jsonb;
BEGIN
  IF p_issued_at > now() + interval '30 seconds'
     OR p_expires_at < now()
     OR p_expires_at <= p_issued_at
     OR p_expires_at - p_issued_at > interval '5 minutes'
  THEN
    RAISE EXCEPTION 'invalid_or_expired_request';
  END IF;
  IF NOT p_owner_confirmed THEN
    RAISE EXCEPTION 'explicit_owner_confirmation_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM wegn_accounts
    WHERE id = p_wegn_account_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'active_account_required';
  END IF;

  PERFORM set_config('app.business_registry_request_id', p_request_id, true);
  PERFORM set_config('app.business_registry_actor_account_id', p_wegn_account_id::text, true);
  PERFORM set_config('app.business_registry_consumer', p_consumer, true);

  INSERT INTO business_registry_requests (
    request_id, consumer, product_key, request_fingerprint, issued_at, expires_at
  )
  VALUES (
    p_request_id, p_consumer, p_product_key, p_request_fingerprint, p_issued_at, p_expires_at
  )
  ON CONFLICT (request_id) DO NOTHING;
  GET DIAGNOSTICS request_claimed = ROW_COUNT;

  IF request_claimed = 0 THEN
    SELECT * INTO existing_request
    FROM business_registry_requests
    WHERE request_id = p_request_id;
    IF existing_request.request_fingerprint <> p_request_fingerprint
       OR existing_request.consumer <> p_consumer
       OR existing_request.product_key <> p_product_key
    THEN
      RAISE EXCEPTION 'request_id_reuse_conflict';
    END IF;
    IF existing_request.response IS NULL THEN
      RAISE EXCEPTION 'request_in_progress';
    END IF;

    INSERT INTO business_registry_audit_log (
      request_id, actor_wegn_account_id, actor_consumer, operation, outcome,
      wegn_business_id, product_link_id, metadata
    )
    VALUES (
      p_request_id, p_wegn_account_id, p_consumer,
      'register-business-product-link', 'idempotent_replay',
      (existing_request.response->>'wegnBusinessId')::uuid,
      (existing_request.response->>'productLinkId')::uuid,
      jsonb_build_object('requestFingerprint', p_request_fingerprint)
    );

    RETURN QUERY SELECT
      (existing_request.response->>'wegnBusinessId')::uuid,
      (existing_request.response->>'productLinkId')::uuid,
      (existing_request.response->>'createdBusiness')::boolean,
      (existing_request.response->>'alreadyLinked')::boolean;
    RETURN;
  END IF;

  SELECT link.wegn_business_id, link.id
    INTO existing_business_id, target_link_id
  FROM wegn_business_product_links link
  WHERE link.product_key = p_product_key
    AND link.external_business_id = p_external_business_id
    AND link.link_status = 'active';

  IF existing_business_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM wegn_business_memberships membership
      WHERE membership.wegn_business_id = existing_business_id
        AND membership.wegn_account_id = p_wegn_account_id
        AND membership.role IN ('owner', 'administrator')
        AND membership.access_status = 'active'
        AND membership.valid_from <= now()
        AND (membership.valid_until IS NULL OR membership.valid_until > now())
    ) THEN
      RAISE EXCEPTION 'existing_link_not_authorized';
    END IF;
    IF p_wegn_business_id IS NOT NULL AND p_wegn_business_id <> existing_business_id THEN
      RAISE EXCEPTION 'existing_link_conflicts_with_business';
    END IF;
    response_body := jsonb_build_object(
      'wegnBusinessId', existing_business_id,
      'productLinkId', target_link_id,
      'createdBusiness', false,
      'alreadyLinked', true
    );
    UPDATE business_registry_requests
    SET response = response_body, completed_at = now()
    WHERE request_id = p_request_id;
    INSERT INTO business_registry_audit_log (
      request_id, actor_wegn_account_id, actor_consumer, operation, outcome,
      wegn_business_id, product_link_id, metadata
    )
    VALUES (
      p_request_id, p_wegn_account_id, p_consumer,
      'register-business-product-link', 'already_linked',
      existing_business_id, target_link_id,
      jsonb_build_object('requestFingerprint', p_request_fingerprint)
    );
    RETURN QUERY SELECT existing_business_id, target_link_id, false, true;
    RETURN;
  END IF;

  IF p_wegn_business_id IS NULL THEN
    target_business_id := create_wegn_business_with_owner(
      p_wegn_account_id,
      p_display_name,
      p_business_type,
      p_country_code,
      'active',
      p_product_key
    );
    did_create := true;
  ELSE
    target_business_id := p_wegn_business_id;
    IF NOT EXISTS (
      SELECT 1 FROM wegn_business_memberships membership
      WHERE membership.wegn_business_id = target_business_id
        AND membership.wegn_account_id = p_wegn_account_id
        AND membership.role IN ('owner', 'administrator')
        AND membership.access_status = 'active'
        AND membership.valid_from <= now()
        AND (membership.valid_until IS NULL OR membership.valid_until > now())
    ) THEN
      RAISE EXCEPTION 'target_business_not_authorized';
    END IF;
  END IF;

  INSERT INTO wegn_business_product_links (
    wegn_business_id,
    product_key,
    external_business_id,
    link_status,
    verified_at,
    provenance
  )
  VALUES (
    target_business_id,
    btrim(p_product_key),
    p_external_business_id,
    'active',
    now(),
    jsonb_build_object('consumer', p_consumer, 'ownerConfirmed', true)
  )
  RETURNING id INTO target_link_id;

  response_body := jsonb_build_object(
    'wegnBusinessId', target_business_id,
    'productLinkId', target_link_id,
    'createdBusiness', did_create,
    'alreadyLinked', false
  );
  UPDATE business_registry_requests
  SET response = response_body, completed_at = now()
  WHERE request_id = p_request_id;

  RETURN QUERY SELECT target_business_id, target_link_id, did_create, false;
END;
$$;

REVOKE ALL ON FUNCTION register_wegn_business_product_link(
  text, text, timestamptz, timestamptz, text, uuid, text, uuid, boolean, text, text, text, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_wegn_business_product_link(
  text, text, timestamptz, timestamptz, text, uuid, text, uuid, boolean, text, text, text, uuid
) TO service_role;

ALTER TABLE wegn_businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE wegn_business_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE wegn_business_product_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_registry_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_registry_requests ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies. Only server-side service-role functions
-- access the canonical registry.
