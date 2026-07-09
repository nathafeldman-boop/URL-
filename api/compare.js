/* Fonction serverless Vercel : POST /api/compare
   Compare le site de l'utilisateur au concurrent déjà analysé. Nécessite un
   compte (1 comparaison gratuite puis Pro) ou un jeton Pro anonyme. */

const { compare } = require("../lib/audit");
const { checkCompareAccess } = require("../lib/access");
const { rateLimit } = require("../lib/ratelimit");
const { logEvent } = require("../lib/events");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Méthode non autorisée." });
  }
  const rl = rateLimit(req);
  if (rl.limited) return res.status(rl.error.status).json(rl.error.body);

  const access = await checkCompareAccess(req);
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
  if (status !== 200) {
    if (access.refund) await access.refund();
    return res.status(status).json(body);
  }
  if (access.mode === "supabase" && !access.pro) {
    body.comparaisons_restantes = access.remaining;
  }
  await logEvent("compare");
  return res.status(status).json(body);
};
