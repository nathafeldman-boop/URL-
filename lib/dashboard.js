/**
 * Verdict — données du dashboard interne (lecture seule), réservé à
 * l'exploitant : la fonction Postgres dashboard_stats() vérifie déjà que
 * l'appelant est l'un des comptes autorisés et lève une exception sinon —
 * ce module ne fait que relayer l'appel et traduire le refus en 403.
 */

const sb = require("./supabase");
const { looksLikeSupabaseJwt } = require("./access");

async function getDashboardData(token) {
  if (!looksLikeSupabaseJwt(token)) {
    return { status: 401, body: { error: "Connecte-toi avec un compte autorisé pour voir le dashboard." } };
  }
  try {
    const data = await sb.rpc("dashboard_stats", {}, token);
    return { status: 200, body: data };
  } catch (err) {
    console.error("dashboard_stats:", err.message);
    return { status: 403, body: { error: "Accès refusé." } };
  }
}

module.exports = { getDashboardData };
