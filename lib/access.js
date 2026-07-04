/**
 * Verdict — contrôle d'accès sans base de données (quota anonyme).
 *
 * Gratuit : 2 analyses et 1 comparaison, comptées dans des cookies signés
 * (HMAC) que le client ne peut pas forger.
 * Pro : jeton signé délivré par /api/activate après vérification du paiement
 * auprès de Stripe. Le jeton embarque l'ID d'abonnement et expire à la fin
 * de la période en cours (+ 3 jours de grâce) ; le front le fait
 * re-vérifier automatiquement auprès de Stripe à l'expiration.
 *
 * Limite assumée du zéro-DB : effacer ses cookies remet les compteurs
 * gratuits à zéro. Acceptable en MVP — un compte connecté rend le quota
 * nominatif en base (voir consume_comparison / consume_analysis côté Supabase).
 */

const crypto = require("node:crypto");

const FREE_LIMIT = 2;
const FREE_COMPARE_LIMIT = 1;
const QUOTA_COOKIE = "v_quota";
const COMPARE_COOKIE = "v_cmp";

/* Secret de signature : APP_SECRET dédié, sinon la clé Stripe (déjà secrète
   et présente en prod), sinon un secret éphémère par instance (dev sans .env :
   les jetons ne survivent pas au redémarrage, sans conséquence). */
const FALLBACK_SECRET = crypto.randomBytes(32).toString("hex");
const secret = () => process.env.APP_SECRET || process.env.STRIPE_SECRET_KEY || FALLBACK_SECRET;

const b64url = (s) => Buffer.from(s).toString("base64url");
const sign = (data) => crypto.createHmac("sha256", secret()).update(data).digest("base64url");

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/* ------------------------------------------------------------- jeton Pro */

/** Crée un jeton Pro : { sub, exp } signé. exp en ms epoch. */
function makeProToken(subscriptionId, expMs) {
  const payload = b64url(JSON.stringify({ sub: subscriptionId, exp: expMs }));
  return `${payload}.${sign(payload)}`;
}

/** Renvoie { sub, exp } si le jeton est valide et non expiré, sinon null. */
function verifyProToken(token) {
  if (typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sign(payload), sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.sub !== "string" || typeof data.exp !== "number") return null;
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

/** Extrait le jeton Bearer de l'en-tête Authorization. */
function bearerToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers?.authorization || "");
  return m ? m[1].trim() : null;
}

const isPro = (req) => verifyProToken(bearerToken(req)) !== null;

/* -------------------------------------------------------- quota gratuit */

/** Lit le compteur d'analyses gratuites depuis l'en-tête Cookie. */
function readQuota(cookieHeader) {
  const m = new RegExp(`(?:^|;\\s*)${QUOTA_COOKIE}=([^;]+)`).exec(cookieHeader || "");
  if (!m) return 0;
  const [count, sig] = decodeURIComponent(m[1]).split(".");
  if (!sig || !safeEqual(sign(`q${count}`), sig)) return 0; // cookie trafiqué → ignoré
  const n = parseInt(count, 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Set-Cookie signé pour un compteur donné (1 an, httpOnly). */
function quotaCookie(count) {
  const value = encodeURIComponent(`${count}.${sign(`q${count}`)}`);
  return `${QUOTA_COOKIE}=${value}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`;
}

/** Même mécanique que readQuota/quotaCookie, pour le compteur de comparaisons. */
function readCompareQuota(cookieHeader) {
  const m = new RegExp(`(?:^|;\\s*)${COMPARE_COOKIE}=([^;]+)`).exec(cookieHeader || "");
  if (!m) return 0;
  const [count, sig] = decodeURIComponent(m[1]).split(".");
  if (!sig || !safeEqual(sign(`c${count}`), sig)) return 0;
  const n = parseInt(count, 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function compareQuotaCookie(count) {
  const value = encodeURIComponent(`${count}.${sign(`c${count}`)}`);
  return `${COMPARE_COOKIE}=${value}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`;
}

/* ------------------------------------------------------------ décisions */

const sb = require("./supabase");

const quotaExhaustedError = () => ({
  status: 402,
  body: {
    error: `Tu as utilisé tes ${FREE_LIMIT} analyses gratuites. Passe en Pro pour analyser en illimité et comparer avec ton site.`,
    code: "quota_epuise",
  },
});

const proRequiredError = () => ({
  status: 402,
  body: {
    error: "Tu as utilisé ta comparaison gratuite. Passe en Pro pour comparer en illimité avec ton site.",
    code: "pro_requis",
  },
});

/* Un JWT Supabase a trois segments ; nos jetons Pro signés en ont deux.
   Exporté : réutilisé par lib/billing.js pour router vers le bon parcours. */
const looksLikeSupabaseJwt = (t) => typeof t === "string" && t.split(".").length === 3;

/**
 * Analyse — trois chemins, dans l'ordre :
 * 1. jeton Pro signé (paiement sans compte) → illimité ;
 * 2. session Supabase → quota nominatif en base (consommé tout de suite,
 *    rendu via refund() si l'analyse échoue) ;
 * 3. anonyme → cookie signé, consume() à appeler après succès.
 */
async function checkAnalyzeAccess(req) {
  const token = bearerToken(req);
  if (verifyProToken(token)) return { allowed: true, pro: true, mode: "token" };

  if (looksLikeSupabaseJwt(token)) {
    try {
      const q = await sb.rpc("consume_analysis", {}, token);
      if (!q.allowed) return { allowed: false, mode: "supabase", error: quotaExhaustedError() };
      return {
        allowed: true,
        pro: !!q.pro,
        remaining: q.remaining,
        mode: "supabase",
        refund: () => sb.rpc("refund_analysis", {}, token).catch(() => {}),
      };
    } catch (err) {
      // Jeton invalide/expiré ou Supabase injoignable → on retombe sur le
      // parcours anonyme plutôt que de bloquer l'utilisateur.
      console.error("quota supabase:", err.message);
    }
  }

  const used = readQuota(req.headers?.cookie);
  if (used >= FREE_LIMIT) {
    return { allowed: false, mode: "cookie", used, error: quotaExhaustedError() };
  }
  return { allowed: true, pro: false, used, mode: "cookie", consume: () => quotaCookie(used + 1) };
}

/**
 * Comparaison — même schéma à trois chemins que l'analyse, avec 1 essai
 * gratuit avant de nécessiter le passage en Pro :
 * 1. jeton Pro signé (paiement sans compte) → illimité ;
 * 2. session Supabase → quota nominatif en base (1 comparaison gratuite) ;
 * 3. anonyme → cookie signé dédié, consume() à appeler après succès.
 */
async function checkCompareAccess(req) {
  const token = bearerToken(req);
  if (verifyProToken(token)) return { allowed: true, pro: true };

  if (looksLikeSupabaseJwt(token)) {
    try {
      const q = await sb.rpc("consume_comparison", {}, token);
      if (!q.allowed) return { allowed: false, mode: "supabase", error: proRequiredError() };
      return {
        allowed: true,
        pro: !!q.pro,
        remaining: q.remaining,
        mode: "supabase",
        refund: () => sb.rpc("refund_comparison", {}, token).catch(() => {}),
      };
    } catch (err) {
      console.error("compare quota supabase:", err.message);
    }
  }

  const used = readCompareQuota(req.headers?.cookie);
  if (used >= FREE_COMPARE_LIMIT) {
    return { allowed: false, mode: "cookie", used, error: proRequiredError() };
  }
  return {
    allowed: true,
    pro: false,
    remaining: FREE_COMPARE_LIMIT - used - 1,
    mode: "cookie",
    consume: () => compareQuotaCookie(used + 1),
  };
}

module.exports = {
  FREE_LIMIT, FREE_COMPARE_LIMIT, makeProToken, verifyProToken, bearerToken, isPro,
  readQuota, quotaCookie, checkAnalyzeAccess, checkCompareAccess, looksLikeSupabaseJwt,
};
