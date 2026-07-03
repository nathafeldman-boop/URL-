/* Fonction serverless Vercel : POST /api/compare
   Compare le site de l'utilisateur au concurrent déjà analysé. Pro uniquement. */

const { compare } = require("../lib/audit");
const { checkCompare } = require("../lib/access");
const { rateLimit } = require("../lib/ratelimit");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Méthode non autorisée." });
  }
  const rl = rateLimit(req);
  if (rl.limited) return res.status(rl.error.status).json(rl.error.body);

  const access = checkCompare(req);
  if (!access.allowed) {
    return res.status(access.error.status).json(access.error.body);
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
