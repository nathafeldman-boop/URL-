/* Fonction serverless Vercel : POST /api/activate → jeton Pro après vérification Stripe */

const { activate } = require("../lib/activate");

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
  const { status, body } = await activate(payload);
  return res.status(status).json(body);
};
