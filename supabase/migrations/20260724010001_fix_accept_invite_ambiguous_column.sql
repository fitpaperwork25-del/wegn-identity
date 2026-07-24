-- Fixes an ambiguous column reference in accept_business_team_invite,
-- caught during Phase 2A-3 staging verification: RETURNS TABLE declares
-- an implicit OUT parameter named wegn_business_id, which collided with
-- the bare (unqualified) wegn_business_id column reference in the
-- already-a-member check. Every other function in
-- 20260724010000_business_registry_team_invites.sql already qualifies
-- its column references for this exact reason; this one didn't.

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
