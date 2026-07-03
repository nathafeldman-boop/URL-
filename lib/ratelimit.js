/**
 * Verdict — limite de débit par IP, en mémoire (zéro dépendance).
 * Protège la facture Mistral contre les scripts : chaque appel à
 * /api/analyze ou /api/compare coûte un appel LLM.
 *
 * Limite volontairement large (30 requêtes/heure/IP) : aucun humain ne
 * l'atteint, un script oui. En serverless la mémoire est par instance,
 * donc la borne réelle est un multiple du LIMIT — protection partielle
 * mais suffisante contre les abus naïfs ; une vraie limite partagée
 * viendra avec la base de données.
 */

const WINDOW_MS = 60 * 60 * 1000;
const LIMIT = 30;

const hits = new Map(); // ip → timestamps des requêtes dans la fenêtre

function clientIp(req) {
  const fwd = req.headers?.["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "inconnu";
}

/** Renvoie { limited, error? }. À appeler avant tout traitement coûteux. */
function rateLimit(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= LIMIT) {
    return {
      limited: true,
      error: {
        status: 429,
        body: { error: "Trop de requêtes depuis ta connexion. Réessaie dans une heure." },
      },
    };
  }

  recent.push(now);
  hits.set(ip, recent);

  // Purge périodique pour borner la mémoire.
  if (hits.size > 5000) {
    for (const [key, list] of hits) {
      if (!list.some((t) => now - t < WINDOW_MS)) hits.delete(key);
    }
  }

  return { limited: false };
}

module.exports = { rateLimit };
