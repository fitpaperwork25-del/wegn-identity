-- Phase 2A-4: Business Settings write path + Notifications preferences.
--
-- Settings: the frozen Business Registry contract states canonical
-- profile fields are set once at registration and only change via "an
-- authenticated, audited Business Registry command" that had never been
-- built until now (design freeze §3, scr-settings). Only display_name
-- and country_code are editable - business_type and lifecycle_status
-- are deliberately excluded (§11: lifecycle changes are already frozen
-- as requiring their own bigger authenticated command, not a settings
-- form field). Owner-only, same conservative default already applied
-- to Team in 20260724010000, since §8 leaves administrator write parity
-- for Settings undecided too.
--
-- Notifications: preferences only - no sending capability exists
-- anywhere in the ecosystem yet (§3, scr-notifications), so this table
-- only ever answers "would this business want alert X on channel Y,"
-- never "was alert X actually sent." alert_code reuses the exact four
-- values already frozen in portfolioContract.ts's Attention type
-- (payment_due, trial_ending, service_suspended, setup_incomplete) -
-- existing vocabulary, not a new taxonomy. A missing row means "default
-- (enabled)," so no backfill is needed for existing businesses.
--
-- Rollback: see bottom of file.

ALTER TABLE wegn_businesses ADD COLUMN profile_updated_by_wegn_account_id uuid REFERENCES wegn_accounts(id);

CREATE OR REPLACE FUNCTION update_business_settings(
  p_request_id text,
  p_consumer text,
  p_actor_wegn_account_id uuid,
  p_wegn_business_id uuid,
  p_display_name text,
  p_country_code text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  normalized_name text := btrim(p_display_name);
  normalized_country text := CASE WHEN p_country_code IS NULL THEN NULL ELSE upper(btrim(p_country_code)) END;
BEGIN
  IF length(normalized_name) < 1 OR length(normalized_name) > 160 THEN
    RAISE EXCEPTION 'invalid_display_name';
  END IF;
  IF normalized_country IS NOT NULL AND normalized_country !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'invalid_country_code';
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

  IF NOT EXISTS (SELECT 1 FROM wegn_businesses WHERE id = p_wegn_business_id) THEN
    RAISE EXCEPTION 'business_not_found';
  END IF;

  PERFORM set_config('app.business_registry_request_id', p_request_id, true);
  PERFORM set_config('app.business_registry_actor_account_id', p_actor_wegn_account_id::text, true);
  PERFORM set_config('app.business_registry_consumer', p_consumer, true);

  UPDATE wegn_businesses
  SET display_name = normalized_name,
      country_code = normalized_country,
      profile_updated_by_wegn_account_id = p_actor_wegn_account_id
  WHERE id = p_wegn_business_id;
END;
$$;

REVOKE ALL ON FUNCTION update_business_settings(text, text, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION update_business_settings(text, text, uuid, uuid, text, text) TO service_role;

CREATE TABLE wegn_business_notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wegn_business_id uuid NOT NULL REFERENCES wegn_businesses(id) ON DELETE RESTRICT,
  alert_code text NOT NULL CHECK (alert_code IN ('payment_due', 'trial_ending', 'service_suspended', 'setup_incomplete')),
  channel text NOT NULL CHECK (channel IN ('email')),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_wegn_account_id uuid REFERENCES wegn_accounts(id),
  UNIQUE (wegn_business_id, alert_code, channel)
);

CREATE INDEX wegn_business_notification_preferences_business_idx
  ON wegn_business_notification_preferences (wegn_business_id);

CREATE TRIGGER wegn_business_notification_preferences_set_updated_at
  BEFORE UPDATE ON wegn_business_notification_preferences
  FOR EACH ROW EXECUTE FUNCTION set_business_registry_updated_at();

-- Extend the same shared audit trigger every other registry mutation
-- already uses (wegn_businesses, memberships, product_links, invites).
ALTER TABLE business_registry_audit_log ADD COLUMN notification_preference_id uuid;

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
  notification_preference_id uuid;
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
  ELSIF TG_TABLE_NAME = 'wegn_business_notification_preferences' THEN
    business_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.wegn_business_id ELSE NEW.wegn_business_id END;
    notification_preference_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
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
    notification_preference_id,
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
    notification_preference_id,
    old_row,
    new_row
  );

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wegn_business_notification_preferences_audit_mutation
  AFTER INSERT OR UPDATE ON wegn_business_notification_preferences
  FOR EACH ROW EXECUTE FUNCTION audit_business_registry_mutation();

CREATE OR REPLACE FUNCTION set_business_notification_preference(
  p_request_id text,
  p_consumer text,
  p_actor_wegn_account_id uuid,
  p_wegn_business_id uuid,
  p_alert_code text,
  p_channel text,
  p_enabled boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_alert_code NOT IN ('payment_due', 'trial_ending', 'service_suspended', 'setup_incomplete') THEN
    RAISE EXCEPTION 'invalid_alert_code';
  END IF;
  IF p_channel NOT IN ('email') THEN
    RAISE EXCEPTION 'invalid_channel';
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

  PERFORM set_config('app.business_registry_request_id', p_request_id, true);
  PERFORM set_config('app.business_registry_actor_account_id', p_actor_wegn_account_id::text, true);
  PERFORM set_config('app.business_registry_consumer', p_consumer, true);

  INSERT INTO wegn_business_notification_preferences (
    wegn_business_id, alert_code, channel, enabled, updated_by_wegn_account_id
  )
  VALUES (
    p_wegn_business_id, p_alert_code, p_channel, p_enabled, p_actor_wegn_account_id
  )
  ON CONFLICT (wegn_business_id, alert_code, channel)
  DO UPDATE SET enabled = p_enabled, updated_by_wegn_account_id = p_actor_wegn_account_id, updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION set_business_notification_preference(text, text, uuid, uuid, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_business_notification_preference(text, text, uuid, uuid, text, text, boolean) TO service_role;

ALTER TABLE wegn_business_notification_preferences ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies - same service-role-only model as every other table in this registry.

-- Rollback:
-- DROP FUNCTION IF EXISTS set_business_notification_preference(text, text, uuid, uuid, text, text, boolean);
-- DROP TRIGGER IF EXISTS wegn_business_notification_preferences_audit_mutation ON wegn_business_notification_preferences;
-- DROP TRIGGER IF EXISTS wegn_business_notification_preferences_set_updated_at ON wegn_business_notification_preferences;
-- ALTER TABLE business_registry_audit_log DROP COLUMN IF EXISTS notification_preference_id;
-- DROP TABLE IF EXISTS wegn_business_notification_preferences;
-- DROP FUNCTION IF EXISTS update_business_settings(text, text, uuid, uuid, text, text);
-- ALTER TABLE wegn_businesses DROP COLUMN IF EXISTS profile_updated_by_wegn_account_id;
