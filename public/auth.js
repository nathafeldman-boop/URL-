/**
 * Verdict — authentification Supabase, deux méthodes :
 * - email → code à 6 chiffres (zéro dépendance, appels REST directs —
 *   pas de lien à cliquer : plus fiable, compatible avec un paiement en
 *   cours dans le même onglet)
 * - Google (OAuth) : redirection vers Supabase qui gère l'échange avec
 *   Google, puis retour sur /app avec les jetons dans le fragment d'URL
 *   (seule méthode possible pour l'OAuth — ce n'est pas un email, donc pas
 *   le problème de lien pré-chargé qui affectait le lien magique)
 * Gère la session (stockage, rafraîchissement) et l'historique/quota
 * synchronisés côté serveur pour les comptes connectés. Chargé avant
 * app.js, qui consomme ces fonctions.
 *
 * La clé "anon" ci-dessous est publique par conception (protégée par les
 * politiques RLS côté base) — ce n'est pas un secret.
 */

/* window.__VERDICT_SUPABASE_* : point d'injection pour les tests (permet de
   rediriger vers un faux serveur sans toucher au code). En production, les
   valeurs par défaut ci-dessous s'appliquent. */
const SUPABASE_URL = window.__VERDICT_SUPABASE_URL || "https://fjrkpatehqtkiojpnzja.supabase.co";
const SUPABASE_ANON_KEY =
  window.__VERDICT_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqcmtwYXRlaHF0a2lvanBuemphIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwODAzNDEsImV4cCI6MjA5ODY1NjM0MX0.hdyQeIrU6VWjs8AYJWj4FeiX58fyRBvXoFY_fuMnxZI";

const SB_SESSION_KEY = "verdict_sb_session";

function getSbSession() {
  try {
    return JSON.parse(localStorage.getItem(SB_SESSION_KEY)) || null;
  } catch {
    return null;
  }
}

function setSbSession(session) {
  localStorage.setItem(SB_SESSION_KEY, JSON.stringify(session));
}

function clearSbSession() {
  localStorage.removeItem(SB_SESSION_KEY);
}

function isLoggedIn() {
  return !!getSbSession()?.access_token;
}

/** Rafraîchit le jeton s'il expire dans moins de 2 minutes. Renvoie la session à jour ou null. */
async function ensureFreshSession() {
  const s = getSbSession();
  if (!s) return null;
  if (s.expires_at - Date.now() > 2 * 60 * 1000) return s;

  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (!resp.ok) throw new Error("refresh échoué");
    const data = await resp.json();
    const next = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      user: s.user,
    };
    setSbSession(next);
    return next;
  } catch {
    clearSbSession();
    return null;
  }
}

/** En-têtes Authorization pour appeler notre propre API (/api/analyze…). */
async function sbAuthHeaders() {
  const s = await ensureFreshSession();
  return s ? { Authorization: "Bearer " + s.access_token } : {};
}

/** Envoie un code de connexion à 6 chiffres par email. */
async function requestOtp(email) {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, create_user: true }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 429) throw new Error("Trop de tentatives. Réessaie dans quelques minutes.");
    throw new Error(data.msg || data.error_description || "Impossible d'envoyer le code. Réessaie.");
  }
}

/** Valide le code à 6 chiffres reçu par email et ouvre la session. */
async function verifyOtp(email, code) {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, token: code.trim(), type: "email" }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.msg || data.error_description || "Code invalide ou expiré.");
  setSbSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    user: data.user,
  });
  return data;
}

/* ------------------------------------------------------------------ OAuth
   Google (et tout futur provider OAuth) : redirection obligatoire, il n'y a
   pas d'équivalent "code à taper" pour ce protocole. */

/** Démarre la connexion Google — redirige vers Supabase qui gère l'échange OAuth,
    puis revient sur la page d'où l'appel a été fait (/app, /dashboard.html…). */
function signInWithGoogle() {
  const redirect = encodeURIComponent(location.origin + location.pathname);
  location.href = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${redirect}`;
}

/** Repère les jetons dans l'URL au retour d'un provider OAuth, ouvre la session. */
async function consumeOAuthRedirect() {
  if (!location.hash.includes("access_token")) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  const expires_in = Number(params.get("expires_in") || 3600);
  if (!access_token) return false;

  history.replaceState(null, "", location.pathname + location.search);

  const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + access_token },
  });
  const user = resp.ok ? await resp.json() : null;
  setSbSession({ access_token, refresh_token, expires_at: Date.now() + expires_in * 1000, user });
  return true;
}

async function signOut() {
  const s = getSbSession();
  if (s) {
    fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + s.access_token },
    }).catch(() => {});
  }
  clearSbSession();
}

/* ---------------------------------------------------------- quota & Pro */

/** Statut du compte connecté : { pro, pro_until, remaining }, ou null. */
async function fetchQuotaStatus() {
  const s = await ensureFreshSession();
  if (!s) return null;
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/quota_status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + s.access_token,
    },
    body: "{}",
  });
  return resp.ok ? resp.json() : null;
}

/* -------------------------------------------------------------- historique
   Pour un compte connecté, l'historique vit dans la table Supabase
   `analyses` (RLS : chacun ne voit que le sien) au lieu du localStorage. */

async function fetchRemoteHistory() {
  const s = await ensureFreshSession();
  if (!s) return null;
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/analyses?select=id,url,report,technologies,metrics,created_at&order=created_at.desc&limit=20`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + s.access_token } }
  );
  return resp.ok ? resp.json() : null;
}

async function insertRemoteHistory(entry) {
  const s = await ensureFreshSession();
  if (!s) return;
  await fetch(`${SUPABASE_URL}/rest/v1/analyses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + s.access_token,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_id: s.user?.id,
      url: entry.url,
      report: entry.report,
      technologies: entry.technologies || [],
      metrics: entry.metrics || {},
    }),
  }).catch(() => {});
}

async function deleteRemoteHistory(id) {
  const s = await ensureFreshSession();
  if (!s) return;
  await fetch(`${SUPABASE_URL}/rest/v1/analyses?id=eq.${id}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + s.access_token },
  }).catch(() => {});
}

async function clearRemoteHistory() {
  const s = await ensureFreshSession();
  if (!s) return;
  await fetch(`${SUPABASE_URL}/rest/v1/analyses?user_id=eq.${s.user?.id}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + s.access_token },
  }).catch(() => {});
}
