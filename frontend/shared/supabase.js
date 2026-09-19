/* Pantry — Supabase auth layer (ES module).
   Expects shared/config.js to have run first as a classic script; works without it
   (everything degrades to "not configured" and the app runs in demo mode).

   The supabase-js client is loaded lazily from the CDN the first time it is needed,
   so pages that never touch auth never pay for the download. */

const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const config = (typeof window !== 'undefined' && window.PANTRY_CONFIG) || {};

export const configured = Boolean(
  typeof config.supabaseUrl === 'string' && config.supabaseUrl.trim() &&
  typeof config.supabaseAnonKey === 'string' && config.supabaseAnonKey.trim()
);

let clientPromise = null;

/** Memoised client. Resolves to null when the project isn't configured.
    Rejects if the CDN import fails, so callers can surface a real error. */
export async function getClient() {
  if (!configured) return null;
  if (!clientPromise) {
    clientPromise = import(CDN)
      .then(({ createClient }) => createClient(config.supabaseUrl.trim(), config.supabaseAnonKey.trim(), {
        auth: { persistSession: true, detectSessionInUrl: true },
      }))
      .catch(err => { clientPromise = null; throw err; });
  }
  return clientPromise;
}

/** Whether Supabase has the given OAuth provider ("google", "github", …) switched on.
    Reads the project's public auth settings. Resolves to true when the check itself
    fails, so a flaky network never blocks a sign-in that might have worked. */
export async function providerEnabled(provider) {
  if (!configured) return false;
  try {
    const res = await fetch(config.supabaseUrl.trim().replace(/\/$/, '') + '/auth/v1/settings', {
      headers: { apikey: config.supabaseAnonKey.trim() },
    });
    if (!res.ok) return true;
    const { external } = await res.json();
    return Boolean(external && external[provider]);
  } catch (err) {
    console.warn('[pantry] providerEnabled could not read auth settings', err);
    return true;
  }
}

/** Current session, or null (also null when not configured or when the client can't load). */
export async function getSession() {
  if (!configured) return null;
  try {
    const client = await getClient();
    const { data, error } = await client.auth.getSession();
    if (error) { console.warn('[pantry] getSession failed', error); return null; }
    return data.session || null;
  } catch (err) {
    console.warn('[pantry] getSession failed', err);
    return null;
  }
}

/** Current user, or null. */
export async function getUser() {
  if (!configured) return null;
  try {
    const client = await getClient();
    const { data, error } = await client.auth.getUser();
    if (error) return null;
    return data.user || null;
  } catch (err) {
    console.warn('[pantry] getUser failed', err);
    return null;
  }
}

/** Sign the current user out. No-op when not configured. */
export async function signOut() {
  if (!configured) return;
  try {
    const client = await getClient();
    const { error } = await client.auth.signOut();
    if (error) console.warn('[pantry] signOut failed', error);
  } catch (err) {
    console.warn('[pantry] signOut failed', err);
  }
}

/* ---------- demo mode ----------
   "Try the demo" links open the app with ?demo. That switches the page to run
   without an account (localStorage only) and is remembered for the tab, so a
   reload or in-app navigation doesn't bounce to the login page. A real session,
   when there is one, always wins over the flag. */
const DEMO_KEY = 'pantry.demo';

export function isDemo() {
  try {
    if (new URLSearchParams(location.search).has('demo')) {
      sessionStorage.setItem(DEMO_KEY, '1');
      return true;
    }
    return sessionStorage.getItem(DEMO_KEY) === '1';
  } catch {
    return false;
  }
}

/** Forget the demo flag (call once the user actually signs in). */
export function exitDemo() {
  try { sessionStorage.removeItem(DEMO_KEY); } catch { /* ignore */ }
}

/** Gate a page behind sign-in. When the project is configured and there is no
    session, sends the browser to the login page with ?next=<this path> and
    resolves to null. In demo mode (see isDemo) it resolves to null without bouncing. Otherwise resolves to the session (or null in demo mode). */
export async function requireAuth(loginPath = '../login/') {
  if (!configured) return null;
  let session = null;
  try {
    const client = await getClient();
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    session = data.session || null;
  } catch (err) {
    // Couldn't reach the auth layer at all: don't bounce to a login page that
    // would fail the same way. Let the page run without a session.
    console.warn('[pantry] requireAuth could not check the session', err);
    return null;
  }
  if (!session && !isDemo()) {
    location.replace(loginPath + '?next=' + encodeURIComponent(location.pathname));
  }
  return session;
}

/** Subscribe to auth changes: cb(event, session). Returns an unsubscribe function.
    No-op when not configured. */
export function onAuthChange(cb) {
  if (!configured || typeof cb !== 'function') return () => {};
  let subscription = null;
  let cancelled = false;
  getClient()
    .then(client => {
      if (cancelled) return;
      const { data } = client.auth.onAuthStateChange((event, session) => {
        try { cb(event, session); } catch (err) { console.warn('[pantry] onAuthChange handler threw', err); }
      });
      subscription = data && data.subscription;
      if (cancelled && subscription) subscription.unsubscribe();
    })
    .catch(err => console.warn('[pantry] onAuthChange could not attach', err));
  return () => {
    cancelled = true;
    if (subscription) subscription.unsubscribe();
  };
}
