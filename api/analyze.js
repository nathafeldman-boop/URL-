/* Fonction serverless Vercel : POST /api/analyze
   Gratuit : 2 analyses (cookie signé). Pro (jeton Bearer) : illimité. */

const { analyze } = require("../lib/audit");
const { checkAnalyze, FREE_LIMIT } = require("../lib/access");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Méthode non autorisée." });
  }
  let url = "";
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    url = body.url;
  } catch {
    return res.status(400).json({ error: "Corps de requête invalide." });
  }

  const access = checkAnalyze(req);
  if (!access.allowed) {
    return res.status(access.error.status).json(access.error.body);
  }

  const { status, body } = await analyze(url);
  // Le quota gratuit n'est décompté que si l'analyse a réussi.
  if (status === 200 && !access.pro) {
    res.setHeader("Set-Cookie", access.consume());
    body.quota_restant = FREE_LIMIT - access.used - 1;
  }
  return res.status(status).json(body);
};
