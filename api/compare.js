/* Fonction serverless Vercel : POST /api/compare
   Compare le site de l'utilisateur au concurrent déjà analysé. */

const { compare } = require("../lib/audit");

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
  const { status, body } = await compare(payload.url, payload.competitor);
  return res.status(status).json(body);
};
