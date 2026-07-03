/**
 * Verdict — portail client Stripe : gérer moyen de paiement, factures, et
 * résilier son abonnement en libre-service. On ne code aucune logique
 * d'annulation nous-mêmes ; Stripe l'assure entièrement côté portail.
 *
 * Le portail a besoin d'un ID client Stripe (customer), résolu selon le
 * mode d'accès de l'appelant :
 * - compte Supabase → lu depuis son profil via get_billing_info() (RPC)
 * - jeton Pro anonyme → le client est retrouvé depuis l'abonnement
 *   (le jeton ne porte que l'ID d'abonnement, vérifié par sa signature)
 */

const { verifyProToken, looksLikeSupabaseJwt } = require("./access");
const sb = require("./supabase");

const config = () => ({
  secretKey: process.env.STRIPE_SECRET_KEY,
  baseUrl: process.env.STRIPE_BASE_URL || "https://api.stripe.com",
});

async function stripeGet(cfg, path) {
  const resp = await fetch(`${cfg.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${cfg.secretKey}` },
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Stripe ${resp.status}: ${data.error?.message || "?"}`);
  return data;
}

async function stripePost(cfg, path, params) {
  const resp = await fetch(`${cfg.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Stripe ${resp.status}: ${data.error?.message || "?"}`);
  return data;
}

/** Retrouve l'ID client Stripe pour le porteur du jeton, ou null. */
async function resolveCustomerId(cfg, token) {
  const pro = verifyProToken(token);
  if (pro) {
    const sub = await stripeGet(cfg, `/v1/subscriptions/${pro.sub}`);
    return typeof sub.customer === "string" ? sub.customer : sub.customer?.id || null;
  }
  if (looksLikeSupabaseJwt(token)) {
    const info = await sb.rpc("get_billing_info", {}, token).catch(() => null);
    return info?.stripe_customer_id || null;
  }
  return null;
}

/** Crée une session de portail Stripe et renvoie { status, body } — body.url au succès. */
async function createPortalSession(token, returnUrl) {
  const cfg = config();
  if (!cfg.secretKey) {
    return { status: 503, body: { error: "Paiement pas encore configuré côté serveur." } };
  }
  if (!token) {
    return { status: 401, body: { error: "Connecte-toi ou active ton abonnement pour accéder à ton profil." } };
  }
  try {
    const customerId = await resolveCustomerId(cfg, token);
    if (!customerId) {
      return { status: 404, body: { error: "Aucun abonnement actif trouvé pour ce compte." } };
    }
    const session = await stripePost(cfg, "/v1/billing_portal/sessions", {
      customer: customerId,
      return_url: returnUrl,
    });
    return { status: 200, body: { url: session.url } };
  } catch (err) {
    console.error("billing-portal:", err.message);
    return { status: 502, body: { error: "Impossible d'ouvrir ton espace abonnement. Réessaie dans un instant." } };
  }
}

module.exports = { createPortalSession };
