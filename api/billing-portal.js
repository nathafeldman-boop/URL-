/* Fonction serverless Vercel : POST /api/billing-portal
   Ouvre le portail client Stripe (factures, moyen de paiement, résiliation). */

const { createPortalSession } = require("../lib/billing");
const { bearerToken } = require("../lib/access");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Méthode non autorisée." });
  }
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const { status, body } = await createPortalSession(bearerToken(req), `${proto}://${host}/app`);
  return res.status(status).json(body);
};
