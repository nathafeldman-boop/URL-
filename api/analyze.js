/* Fonction serverless Vercel : POST /api/analyze */

const { analyze } = require("../lib/audit");

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
  const { status, body } = await analyze(url);
  return res.status(status).json(body);
};
