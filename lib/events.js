/**
 * Verdict — journal d'événements produit (alimente le dashboard interne).
 * Best-effort et non bloquant : une panne Supabase ne doit jamais faire
 * échouer une analyse, une comparaison ou une activation.
 */

const sb = require("./supabase");

function logEvent(type, meta) {
  sb.rpc("log_event", { p_type: type, p_meta: meta || null }).catch((err) => {
    console.error("log_event:", err.message);
  });
}

module.exports = { logEvent };
