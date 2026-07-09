/**
 * Verdict — journal d'événements produit (alimente le dashboard interne).
 * Best-effort : une panne Supabase ne doit jamais faire échouer une analyse,
 * une comparaison ou une activation.
 *
 * DOIT être attendu (await) par l'appelant : sur Vercel, la fonction
 * serverless est gelée dès que la réponse HTTP part — un fire-and-forget
 * n'a jamais le temps d'aboutir (ni de logger son échec), et le dashboard
 * restait à zéro alors que les analyses tournaient.
 */

const sb = require("./supabase");

async function logEvent(type, meta) {
  try {
    await sb.rpc("log_event", { p_type: type, p_meta: meta || null });
  } catch (err) {
    console.error("log_event:", err.message);
  }
}

module.exports = { logEvent };
