import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Sprint 4A - verifies a caller's own Supabase JWT against THIS project's
 * Auth (wegn-identity's own, used here for the first time for a real
 * end-user login - see dashboard-summary's own header). Mirrors the
 * verifyAuth.ts pattern already used by every product (QRWegn, Wegn
 * Store, QRBooker) exactly, pointed at this project instead of a
 * product's.
 *
 * This is a wholly different authentication model from
 * credentialRegistry.ts's per-consumer service secrets - those authorize
 * a PRODUCT acting as itself; this authorizes a PERSON acting as
 * themselves. dashboard-summary is the only operation that uses this.
 */
export type VerifiedUser = {
  authUserId: string;
  email: string | null;
};

export async function verifyUserAuth(params: {
  supabaseUrl: string;
  supabaseAnonKey: string;
  authorizationHeader: string | null;
}): Promise<VerifiedUser | null> {
  if (!params.authorizationHeader) return null;

  const supabase = createClient(params.supabaseUrl, params.supabaseAnonKey, {
    global: { headers: { Authorization: params.authorizationHeader } },
  });

  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;

  return { authUserId: data.user.id, email: data.user.email ?? null };
}
