import { createBrowserClient } from "@supabase/ssr";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// SSO: same cookie domain as Hub, WMS-Map, Report
// NOTE: this client setup is duplicated across mpoctools apps. To unify, see
// shared-docs/AUTH-UNIFICATION-PLAN.md. Pending decision on distribution
// mechanism (GitHub repo dependency vs npm publish vs vendoring).
const _cookieDomain = location.hostname.includes("mpoctools.com")
  ? ".mpoctools.com"
  : "";
const _isSecure = location.protocol === "https:";

let supabase = null;

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (supabase) return supabase;

  supabase = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () =>
        document.cookie
          .split(";")
          .map((c) => {
            const [name, ...rest] = c.trim().split("=");
            return { name, value: decodeURIComponent(rest.join("=")) };
          })
          .filter((c) => c.name),
      setAll: (cookies) => {
        cookies.forEach(({ name, value, options }) => {
          let cookie = `${name}=${encodeURIComponent(value)}`;
          cookie += `; path=${options?.path || "/"}`;
          if (options?.maxAge) cookie += `; max-age=${options.maxAge}`;
          if (_cookieDomain) cookie += `; domain=${_cookieDomain}`;
          cookie += "; samesite=lax";
          if (_isSecure) cookie += "; secure";
          document.cookie = cookie;
        });
      },
    },
    cookieOptions: {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 400,
    },
  });

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
