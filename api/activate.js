/* Fonction serverless Vercel : POST /api/activate → jeton Pro après vérification Stripe.
   Si connecté (Authorization: Bearer <jeton Supabase>), écrit aussi le statut Pro sur le compte. */

const { activate } = require("../lib/activate");
const { bearerToken } = require("../lib/access");
const { logEvent } = require("../lib/events");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Méthode non autorisée." });
  }
  let payload;
  try {
    payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    return res.status(400).json({ error: "Corps de requête invalide." });
  }
  const { status, body } = await activate(payload, bearerToken(req));
  if (status === 200) await logEvent("pro_activated");
  return res.status(status).json(body);
};
