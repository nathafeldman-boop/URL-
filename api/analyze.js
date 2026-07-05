/* Fonction serverless Vercel : POST /api/analyze
   Accès, dans l'ordre : jeton Pro anonyme → illimité ; session Supabase →
   2 analyses gratuites puis quota nominatif en base ; sinon → compte requis. */

const { analyze } = require("../lib/audit");
const { checkAnalyzeAccess } = require("../lib/access");
const { rateLimit } = require("../lib/ratelimit");
const { logEvent } = require("../lib/events");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Méthode non autorisée." });
  }
  const rl = rateLimit(req);
  if (rl.limited) return res.status(rl.error.status).json(rl.error.body);

  let url = "";
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    url = body.url;
  } catch {
    return res.status(400).json({ error: "Corps de requête invalide." });
  }

  const access = await checkAnalyzeAccess(req);
  if (!access.allowed) {
    return res.status(access.error.status).json(access.error.body);
  }

  const { status, body } = await analyze(url);

  if (status !== 200) {
    // L'analyse a échoué : on rend l'analyse gratuite consommée en base.
    if (access.refund) await access.refund();
    return res.status(status).json(body);
  }

  if (access.mode === "supabase" && !access.pro) {
    body.quota_restant = access.remaining;
  }
  logEvent("analyze");
  return res.status(status).json(body);
};
