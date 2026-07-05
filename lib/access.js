/**
 * Verdict — contrôle d'accès.
 *
 * Gratuit : 2 analyses et 1 comparaison, mais réservé aux comptes créés
 * (compte Supabase) — quota nominatif en base (voir consume_comparison /
 * consume_analysis côté Supabase). Un visiteur anonyme sans compte et sans
 * jeton Pro reçoit une erreur "compte_requis" plutôt qu'un essai gratuit.
 * Pro : jeton signé délivré par /api/activate après vérification du paiement
 * auprès de Stripe. Le jeton embarque l'ID d'abonnement et expire à la fin
 * de la période en cours (+ 3 jours de grâce) ; le front le fait
 * re-vérifier automatiquement auprès de Stripe à l'expiration. Ce jeton
 * fonctionne sans compte : un paiement suffit, la contrainte de compte ne
 * vise que l'essai gratuit.
 */

const crypto = require("node:crypto");

const FREE_LIMIT = 2;
const FREE_COMPARE_LIMIT = 1;

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

const accountRequiredForAnalyzeError = () => ({
  status: 401,
  body: {
    error: "Crée un compte gratuit pour lancer ton analyse — ça prend 10 secondes.",
    code: "compte_requis",
  },
});

const accountRequiredForCompareError = () => ({
  status: 401,
  body: {
    error: "Crée un compte gratuit pour comparer avec ton site.",
    code: "compte_requis",
  },
});

const serviceUnavailableError = () => ({
  status: 503,
  body: { error: "Service momentanément indisponible. Réessaie dans un instant.", code: "service_indisponible" },
});

/* Un JWT Supabase a trois segments ; nos jetons Pro signés en ont deux.
   Exporté : réutilisé par lib/billing.js pour router vers le bon parcours. */
const looksLikeSupabaseJwt = (t) => typeof t === "string" && t.split(".").length === 3;

/**
 * Analyse — deux chemins, dans l'ordre :
 * 1. jeton Pro signé (paiement sans compte) → illimité ;
 * 2. session Supabase → quota nominatif en base (consommé tout de suite,
 *    rendu via refund() si l'analyse échoue) ;
 * sinon (visiteur anonyme sans compte ni jeton Pro) → compte requis.
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
      // Jeton présent mais Supabase injoignable/en erreur : distinct d'un
      // visiteur sans compte, pour ne pas lui dire à tort de s'inscrire.
      console.error("quota supabase:", err.message);
      return { allowed: false, mode: "supabase", error: serviceUnavailableError() };
    }
  }

  return { allowed: false, mode: "anonymous", error: accountRequiredForAnalyzeError() };
}

/**
 * Comparaison — même schéma que l'analyse, avec 1 essai gratuit avant de
 * nécessiter le passage en Pro :
 * 1. jeton Pro signé (paiement sans compte) → illimité ;
 * 2. session Supabase → quota nominatif en base (1 comparaison gratuite) ;
 * sinon (visiteur anonyme sans compte ni jeton Pro) → compte requis.
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
      return { allowed: false, mode: "supabase", error: serviceUnavailableError() };
    }
  }

  return { allowed: false, mode: "anonymous", error: accountRequiredForCompareError() };
}

module.exports = {
  FREE_LIMIT, FREE_COMPARE_LIMIT, makeProToken, verifyProToken, bearerToken, isPro,
  checkAnalyzeAccess, checkCompareAccess, looksLikeSupabaseJwt,
};
