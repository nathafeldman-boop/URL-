/* Fonction serverless Vercel : GET /api/dashboard-data
   Réservée aux comptes autorisés (voir dashboard_stats() côté Postgres) —
   nécessite une session Supabase (Authorization: Bearer <jeton>). */

const { getDashboardData } = require("../lib/dashboard");
const { bearerToken } = require("../lib/access");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Méthode non autorisée." });
  }
  const { status, body } = await getDashboardData(bearerToken(req));
  return res.status(status).json(body);
};
