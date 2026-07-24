-- Run only against a disposable local/staging database after applying the
-- Phase 1B Foundation migration. The surrounding transaction guarantees
-- that test records are rolled back.
BEGIN;

DO $$
DECLARE
  account_a uuid;
  account_b uuid;
  business_id uuid;
  last_owner_business_id uuid;
  membership_id uuid;
  replay_result record;
  external_id uuid := '423e4567-e89b-42d3-a456-426614174000';
BEGIN
  INSERT INTO wegn_accounts (email) VALUES ('phase1b-a@example.invalid') RETURNING id INTO account_a;
  INSERT INTO wegn_accounts (email) VALUES ('phase1b-b@example.invalid') RETURNING id INTO account_b;

  last_owner_business_id := create_wegn_business_with_owner(account_b, 'Last Owner Test', 'test', 'ET', 'active', 'wegn-store');
  BEGIN
    UPDATE wegn_business_memberships
    SET access_status = 'suspended'
    WHERE wegn_business_id = last_owner_business_id
      AND wegn_account_id = account_b;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'last_owner_suspension_was_not_rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%business_requires_active_owner%' THEN RAISE; END IF;
  END;

  business_id := create_wegn_business_with_owner(account_a, 'Security Test', 'test', 'ET', 'active', 'wegn-store');
  INSERT INTO wegn_business_memberships (wegn_business_id, wegn_account_id, role)
  VALUES (business_id, account_b, 'owner');

  SELECT id INTO membership_id
  FROM wegn_business_memberships
  WHERE wegn_business_id = business_id AND wegn_account_id = account_a AND access_status = 'active';

  UPDATE wegn_business_memberships SET access_status = 'revoked' WHERE id = membership_id;

  BEGIN
    UPDATE wegn_business_memberships SET access_status = 'active' WHERE id = membership_id;
    RAISE EXCEPTION 'revoked_to_active_was_not_rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%revoked_membership_is_immutable%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE wegn_business_memberships SET access_status = 'suspended' WHERE id = membership_id;
    RAISE EXCEPTION 'revoked_to_suspended_was_not_rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%revoked_membership_is_immutable%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE wegn_business_memberships SET access_status = 'pending' WHERE id = membership_id;
    RAISE EXCEPTION 'revoked_to_pending_was_not_rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%revoked_membership_is_immutable%' THEN RAISE; END IF;
  END;

  INSERT INTO wegn_business_memberships (wegn_business_id, wegn_account_id, role, access_status)
  VALUES (business_id, account_a, 'owner', 'active');

  IF (SELECT count(*) FROM wegn_business_memberships
      WHERE wegn_business_id = business_id AND wegn_account_id = account_a) <> 2 THEN
    RAISE EXCEPTION 'regrant_did_not_preserve_revoked_history';
  END IF;

  SELECT * INTO replay_result
  FROM register_wegn_business_product_link(
    'phase1b_replay_1', 'wegn-store-registry',
    now() - interval '1 second', now() + interval '4 minutes', 'fingerprint-a',
    account_a, 'wegn-store', external_id, true, 'Security Test', 'test', 'ET', business_id
  );

  SELECT * INTO replay_result
  FROM register_wegn_business_product_link(
    'phase1b_replay_1', 'wegn-store-registry',
    now() - interval '1 second', now() + interval '4 minutes', 'fingerprint-a',
    account_a, 'wegn-store', external_id, true, 'Security Test', 'test', 'ET', business_id
  );

  IF replay_result.wegn_business_id <> business_id THEN
    RAISE EXCEPTION 'idempotent_replay_did_not_return_original_result';
  END IF;

  BEGIN
    PERFORM * FROM register_wegn_business_product_link(
      'phase1b_replay_1', 'wegn-store-registry',
      now() - interval '1 second', now() + interval '4 minutes', 'fingerprint-b',
      account_a, 'wegn-store', external_id, true, 'Security Test', 'test', 'ET', business_id
    );
    RAISE EXCEPTION 'request_id_reuse_was_not_rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%request_id_reuse_conflict%' THEN RAISE; END IF;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM business_registry_audit_log
    WHERE wegn_business_id = business_id
      AND operation = 'wegn_business_memberships-update'
  ) THEN
    RAISE EXCEPTION 'membership_mutation_was_not_audited';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM business_registry_audit_log
    WHERE request_id = 'phase1b_replay_1'
      AND outcome = 'idempotent_replay'
  ) THEN
    RAISE EXCEPTION 'idempotent_replay_was_not_audited';
  END IF;
END;
$$;

DO $$
DECLARE
  policy_count integer;
BEGIN
  SELECT count(*) INTO policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN (
      'wegn_businesses',
      'wegn_business_memberships',
      'wegn_business_product_links',
      'business_registry_audit_log',
      'business_registry_requests'
    );
  IF policy_count <> 0 THEN
    RAISE EXCEPTION 'browser_facing_registry_policy_exists';
  END IF;

  IF has_function_privilege(
    'anon',
    'register_wegn_business_product_link(text,text,timestamptz,timestamptz,text,uuid,text,uuid,boolean,text,text,text,uuid)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'register_wegn_business_product_link(text,text,timestamptz,timestamptz,text,uuid,text,uuid,boolean,text,text,text,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'browser_role_can_execute_registry_link';
  END IF;
END;
$$;

ROLLBACK;
