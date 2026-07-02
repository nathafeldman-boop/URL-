/**
 * Verdict — création de session Stripe Checkout (abonnement Pro).
 * Zéro dépendance : appels directs à l'API Stripe en form-encoded.
 * Accepte un ID produit (prod_…) dont on résout le prix par défaut,
 * ou directement un ID prix (price_…) via STRIPE_PRICE_ID.
 */

const config = () => ({
  secretKey: process.env.STRIPE_SECRET_KEY,
  productId: process.env.STRIPE_PRODUCT_ID || "prod_UoUCJGRo2tMb6B",
  priceId: process.env.STRIPE_PRICE_ID, // optionnel : court-circuite la résolution
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

async function resolvePriceId(cfg) {
  if (cfg.priceId) return cfg.priceId;
  const product = await stripeGet(cfg, `/v1/products/${cfg.productId}`);
  if (typeof product.default_price === "string") return product.default_price;
  const prices = await stripeGet(cfg, `/v1/prices?product=${cfg.productId}&active=true&limit=1`);
  if (prices.data?.[0]?.id) return prices.data[0].id;
  throw new Error(`Aucun prix actif sur le produit ${cfg.productId}`);
}

/** Crée la session et renvoie { status, redirectUrl } ou { status, body }. */
async function createCheckout(origin) {
  const cfg = config();
  if (!cfg.secretKey) {
    return { status: 503, body: { error: "Paiement pas encore configuré : ajoute STRIPE_SECRET_KEY côté serveur." } };
  }
  try {
    const price = await resolvePriceId(cfg);
    const session = await stripePost(cfg, "/v1/checkout/sessions", {
      mode: "subscription",
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      success_url: `${origin}/app?paiement=reussi`,
      cancel_url: `${origin}/#tarifs`,
      allow_promotion_codes: "true",
    });
    return { status: 303, redirectUrl: session.url };
  } catch (err) {
    console.error("checkout:", err.message);
    return { status: 502, body: { error: "Impossible de démarrer le paiement. Réessaie dans un instant." } };
  }
}

module.exports = { createCheckout };
