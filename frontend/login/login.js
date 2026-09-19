/* Pantry login page. Talks to Supabase through ../shared/supabase.js. */
import { configured, getClient, getSession, onAuthChange, providerEnabled, exitDemo } from '../shared/supabase.js';

const $ = s => document.querySelector(s);
const el = {
  title: $('#auth-title'),
  lede: $('#auth-lede'),
  notConfigured: $('#not-configured'),
  form: $('#auth-form'),
  fields: $('#auth-fields'),
  modeSignin: $('#mode-signin'),
  modeSignup: $('#mode-signup'),
  email: $('#email'),
  password: $('#password'),
  error: $('#form-error'),
  btnContinue: $('#btn-continue'),
  btnGoogle: $('#btn-google'),
  btnMagic: $('#btn-magic'),
  sent: $('#sent'),
  sentTitle: $('#sent-title'),
  sentText: $('#sent-text'),
  sentBack: $('#btn-sent-back'),
};

const APP_URL = location.origin + '/app/';
let mode = 'signin';
let navigating = false;

/* ---------- where to go afterwards ---------- */

function nextPath() {
  const raw = new URLSearchParams(location.search).get('next');
  if (!raw) return '../app/';
  try {
    const u = new URL(raw, location.origin);
    const ownPath = location.pathname.replace(/\/[^/]*$/, '/');
    if (u.origin !== location.origin) return '../app/';
    if (u.pathname.startsWith(ownPath)) return '../app/';      // never bounce back onto the login page
    return u.pathname + u.search + u.hash;
  } catch {
    return '../app/';
  }
}

function goToApp() {
  if (navigating) return;
  navigating = true;
  exitDemo();   // a real account takes over from any "try the demo" session
  location.replace(nextPath());
}

/* ---------- ui helpers ---------- */

function setError(msg) {
  if (!msg) { el.error.hidden = true; el.error.textContent = ''; return; }
  el.error.textContent = msg;
  el.error.hidden = false;
}

function setBusy(btn, busy) {
  btn.classList.toggle('busy', busy);
  btn.disabled = busy;
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function setMode(next) {
  mode = next;
  const signup = mode === 'signup';
  el.modeSignin.setAttribute('aria-pressed', String(!signup));
  el.modeSignup.setAttribute('aria-pressed', String(signup));
  el.title.textContent = signup ? 'Create your account' : 'Welcome back';
  el.lede.textContent = signup ? 'One account, every device, the same pantry.' : 'Sign in and your pantry follows you.';
  el.password.autocomplete = signup ? 'new-password' : 'current-password';
  el.btnContinue.querySelector('.label').textContent = signup ? 'Create account' : 'Continue';
  setError('');
}

function showSent(title, html) {
  el.sentTitle.textContent = title;
  el.sentText.innerHTML = html;
  el.form.hidden = true;
  el.sent.hidden = false;
  el.sentBack.focus();
}

function showForm() {
  el.sent.hidden = true;
  el.form.hidden = false;
  el.email.focus();
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function friendly(err) {
  const m = (err && err.message) || 'Something went wrong. Please try again.';
  if (/invalid login credentials/i.test(m)) return 'That email and password don’t match.';
  if (/email not confirmed/i.test(m)) return 'Confirm your email first, then sign in. Check your inbox for the link.';
  if (/already registered/i.test(m)) return 'There’s already an account with that email. Try signing in.';
  if (/provider is not enabled|unsupported provider/i.test(m)) return 'Google sign-in isn’t switched on for this project yet. Use your email and password or a magic link instead.';
  if (/rate limit/i.test(m)) return 'Too many attempts. Give it a minute and try again.';
  if (/failed to fetch|network/i.test(m)) return 'Couldn’t reach the sign-in service. Check your connection and try again.';
  return m;
}

function validEmail() {
  const ok = el.email.checkValidity() && el.email.value.trim().length > 3;
  el.email.setAttribute('aria-invalid', ok ? 'false' : 'true');
  if (!ok) { setError('Enter a valid email address.'); el.email.focus(); }
  return ok;
}

function validPassword() {
  const ok = el.password.value.length >= 6;
  el.password.setAttribute('aria-invalid', ok ? 'false' : 'true');
  if (!ok) { setError('Your password needs at least 6 characters.'); el.password.focus(); }
  return ok;
}

/* ---------- auth actions ---------- */

async function submit(e) {
  e.preventDefault();
  setError('');
  if (!validEmail() || !validPassword()) return;
  const email = el.email.value.trim();
  const password = el.password.value;
  setBusy(el.btnContinue, true);
  try {
    const client = await getClient();
    if (mode === 'signup') {
      const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: APP_URL } });
      if (error) throw error;
      if (data.session) { goToApp(); return; }
      showSent('Confirm your email', `We sent a confirmation link to <b>${escapeHtml(email)}</b>. Open it and you’ll land in your pantry.`);
    } else {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      goToApp();
    }
  } catch (err) {
    setError(friendly(err));
  } finally {
    if (!navigating) setBusy(el.btnContinue, false);
  }
}

async function google() {
  setError('');
  setBusy(el.btnGoogle, true);
  try {
    const client = await getClient();
    // signInWithOAuth navigates away without checking, so Supabase would answer with a
    // bare JSON error page if the provider is off. Check first and fail in place instead.
    if (!(await providerEnabled('google'))) {
      throw new Error('Google sign-in isn’t switched on for this project yet. Use your email and password or a magic link instead.');
    }
    const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: APP_URL } });
    if (error) throw error;
    // The browser is now leaving for Google; keep the button busy.
  } catch (err) {
    setError(friendly(err));
    setBusy(el.btnGoogle, false);
  }
}

async function magicLink() {
  setError('');
  if (!validEmail()) return;
  const email = el.email.value.trim();
  el.btnMagic.disabled = true;
  el.btnMagic.textContent = 'Sending…';
  try {
    const client = await getClient();
    const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: APP_URL } });
    if (error) throw error;
    showSent('Check your inbox', `We sent a sign-in link to <b>${escapeHtml(email)}</b>. Open it on this device to continue.`);
  } catch (err) {
    setError(friendly(err));
  } finally {
    el.btnMagic.disabled = false;
    el.btnMagic.textContent = 'Email me a magic link';
  }
}

/* ---------- wire up ---------- */

el.modeSignin.addEventListener('click', () => setMode('signin'));
el.modeSignup.addEventListener('click', () => setMode('signup'));
el.form.addEventListener('submit', submit);
el.btnGoogle.addEventListener('click', google);
el.btnMagic.addEventListener('click', magicLink);
el.sentBack.addEventListener('click', showForm);
[el.email, el.password].forEach(i => i.addEventListener('input', () => { i.setAttribute('aria-invalid', 'false'); setError(''); }));

if (new URLSearchParams(location.search).get('mode') === 'signup') setMode('signup');

if (!configured) {
  el.notConfigured.hidden = false;
  el.fields.disabled = true;
  el.lede.textContent = 'Demo mode keeps your pantry in this browser only.';
} else {
  // Already signed in? Straight through. Also catch the session landing via a
  // magic link or OAuth redirect that ends up on this page.
  getSession().then(session => { if (session) goToApp(); });
  onAuthChange((event, session) => { if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) goToApp(); });
}
