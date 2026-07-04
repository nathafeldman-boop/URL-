/**
 * Verdict — accès propriétaire : jeton Pro permanent pour l'exploitant du
 * SaaS, sans dépendre d'un abonnement Stripe réel. Protégé par OWNER_SECRET
 * (variable d'environnement, jamais exposée côté client) : seul celui qui
 * connaît ce secret peut obtenir le jeton.
 */

const { makeProToken } = require("./access");

const HUNDRED_YEARS_MS = 100 * 365 * 24 * 3600 * 1000;
const OWNER_SUB = "owner-gratuit";

function issueOwnerToken(secret) {
  if (!process.env.OWNER_SECRET) {
    return { status: 503, body: { error: "Accès propriétaire pas encore configuré côté serveur." } };
  }
  if (typeof secret !== "string" || secret !== process.env.OWNER_SECRET) {
    return { status: 403, body: { error: "Secret invalide." } };
  }
  const exp = Date.now() + HUNDRED_YEARS_MS;
  return { status: 200, body: { token: makeProToken(OWNER_SUB, exp), exp, sub: OWNER_SUB } };
}

module.exports = { issueOwnerToken, OWNER_SUB };
