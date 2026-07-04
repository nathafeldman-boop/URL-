/* Fonction serverless Vercel : POST /api/owner-token
   Délivre un jeton Pro permanent à l'exploitant du SaaS (protégé par
   OWNER_SECRET) — voir lib/owner.js. */

const { issueOwnerToken } = require("../lib/owner");

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
  const { status, body } = issueOwnerToken(payload.secret);
  return res.status(status).json(body);
};
