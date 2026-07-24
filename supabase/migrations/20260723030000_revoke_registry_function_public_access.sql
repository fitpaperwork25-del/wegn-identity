-- Sprint 5 Phase 1C staging security fix.
--
-- The REVOKE ALL ... FROM PUBLIC statements in
-- 20260723020000_business_registry_foundation.sql did not close off these
-- SECURITY DEFINER functions to anon/authenticated: Supabase provisions
-- every project with schema-level default privileges that grant EXECUTE on
-- new public-schema functions directly to anon and authenticated, and
-- REVOKE ... FROM PUBLIC does not remove a privilege a role holds by name.
-- Confirmed during staging smoke testing: an unauthenticated anon-key RPC
-- call to resolve_or_create_wegn_account succeeded and inserted a row.
--
-- This migration explicitly revokes from anon and authenticated as well,
-- leaving EXECUTE granted only to service_role, matching the original
-- intent ("No anon/authenticated policies. Only server-side service-role
-- functions access the canonical registry.").

REVOKE ALL ON FUNCTION resolve_or_create_wegn_account(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resolve_or_create_wegn_account(text) TO service_role;

REVOKE ALL ON FUNCTION create_wegn_business_with_owner(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_wegn_business_with_owner(uuid, text, text, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION register_wegn_business_product_link(
  text, text, timestamptz, timestamptz, text, uuid, text, uuid, boolean, text, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION register_wegn_business_product_link(
  text, text, timestamptz, timestamptz, text, uuid, text, uuid, boolean, text, text, text, uuid
) TO service_role;
