// Supabase browser client setup is shared with sibling apps via the @mpoc/auth module.
// See shared-auth/README.md and shared-docs/AUTH-UNIFICATION-PLAN.md.
import { createMpocClient } from "@mpoc/auth/client.js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

let supabase = null;

function getClient() {
  if (supabase) return supabase;
  supabase = createMpocClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return supabase;
}

/**
 * Check SSO session and fetch profile name.
 * Returns { name, userId } or null if guest.
 */
export async function checkAuth() {
  const client = getClient();
  if (!client) return null;

  try {
    const {
      data: { session },
    } = await client.auth.getSession();
    if (!session) return null;

    const { data: profile } = await client
      .from("profiles")
      .select("name")
      .eq("id", session.user.id)
      .single();

    if (!profile?.name) return null;

    logAppVisit(client, session.user.id);
    return { name: profile.name, userId: session.user.id };
  } catch {
    return null;
  }
}

/** Fire-and-forget: log visit to app_visits (max 1 per hour via DB dedup) */
function logAppVisit(client, userId) {
  if (!client) return;
  client.from('app_visits').insert({
    user_id: userId,
    app_id: 'timetracker',
    user_agent: navigator.userAgent,
  }).then(() => {}).catch(() => {});
}

/**
 * Check admin/supervisor access for timetracker.
 * Returns { name, userId, role } or null if no access.
 */
export async function checkAdminAuth() {
  const client = getClient();
  if (!client) return null;

  try {
    const {
      data: { session },
    } = await client.auth.getSession();
    if (!session) return null;

    const [{ data: profile }, { data: access }] = await Promise.all([
      client.from("profiles").select("name").eq("id", session.user.id).single(),
      client
        .from("user_access")
        .select("role")
        .eq("app_id", "timetracker")
        .eq("user_id", session.user.id)
        .single(),
    ]);

    if (!access || !["admin", "supervisor"].includes(access.role)) return null;

    return {
      name: profile?.name || "Admin",
      userId: session.user.id,
      role: access.role,
    };
  } catch {
    return null;
  }
}

/**
 * Get Supabase client (for direct queries in admin dashboard).
 */
export function getSupabaseClient() {
  return getClient();
}
