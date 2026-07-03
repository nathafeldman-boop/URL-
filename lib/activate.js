/**
 * Verdict — activation du plan Pro après paiement Stripe.
 *
 * Deux modes de vérification Stripe :
 * - { session_id } : au retour de Stripe Checkout, on vérifie que la session
 *   est payée et on lit son abonnement.
 * - { subscription } : renouvellement silencieux quand le jeton expire — on
 *   re-vérifie que l'abonnement est toujours actif.
 * Dans les deux cas on délivre un jeton signé (parcours anonyme, valable
 * jusqu'à la fin de la période en cours + 3 jours de grâce).
 *
 * Si l'appelant est connecté (jeton Supabase en 2e argument), on écrit AUSSI
 * le statut Pro dans son profil via la fonction apply_pro — protégée par un
 * secret partagé (APP_SECRET) que seul ce serveur connaît.
 */

const { makeProToken } = require("./access");
const sb = require("./supabase");

const GRACE_MS = 3 * 24 * 3600 * 1000;
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

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

/** Renvoie { status, body } — body contient { token, exp } en cas de succès. */
async function activate({ session_id, subscription }, supabaseToken) {
  const cfg = config();
  if (!cfg.secretKey) {
    return { status: 503, body: { error: "Paiement pas encore configuré côté serveur." } };
  }

  try {
    let subId = null;
    let customerId = null;

    if (typeof session_id === "string" && /^cs_[\w]+$/.test(session_id)) {
      const session = await stripeGet(cfg, `/v1/checkout/sessions/${session_id}`);
      if (session.payment_status !== "paid") {
        return { status: 402, body: { error: "Le paiement n'a pas abouti. Réessaie ou contacte-nous." } };
      }
      subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
    } else if (typeof subscription === "string" && /^sub_[\w]+$/.test(subscription)) {
      subId = subscription;
    }

    if (!subId) {
      return { status: 400, body: { error: "Requête d'activation invalide." } };
    }

    const sub = await stripeGet(cfg, `/v1/subscriptions/${subId}`);
    if (!ACTIVE_STATUSES.has(sub.status)) {
      return { status: 402, body: { error: "Ton abonnement n'est plus actif. Réabonne-toi pour retrouver l'illimité." } };
    }
    if (!customerId) customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;

    const periodEnd = (sub.current_period_end || 0) * 1000;
    const exp = Math.max(periodEnd + GRACE_MS, Date.now() + 24 * 3600 * 1000);

    if (supabaseToken && process.env.APP_SECRET) {
      try {
        await sb.rpc(
          "apply_pro",
          { p_secret: process.env.APP_SECRET, p_subscription: subId, p_customer: customerId, p_until: new Date(exp).toISOString() },
          supabaseToken
        );
      } catch (err) {
        // On n'échoue pas l'activation pour ça : le jeton anonyme suffit à débloquer l'accès ;
        // le compte se resynchronisera au prochain appel réussi.
        console.error("apply_pro:", err.message);
      }
    }

    return { status: 200, body: { token: makeProToken(subId, exp), exp, sub: subId } };
  } catch (err) {
    console.error("activate:", err.message);
    return { status: 502, body: { error: "Impossible de vérifier le paiement. Réessaie dans un instant." } };
  }
}

module.exports = { activate };
