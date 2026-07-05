/**
 * Verdict — client Supabase minimal côté serveur (zéro dépendance).
 * On n'utilise que des RPC PostgREST appelées AVEC le jeton de l'utilisateur :
 * la clé anon est publique par design, la sécurité vient des politiques RLS
 * et des fonctions security definer côté base.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "https://fjrkpatehqtkiojpnzja.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqcmtwYXRlaHF0a2lvanBuemphIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwODAzNDEsImV4cCI6MjA5ODY1NjM0MX0.hdyQeIrU6VWjs8AYJWj4FeiX58fyRBvXoFY_fuMnxZI";

/** Appelle une fonction Postgres (RPC) au nom de l'utilisateur, ou en tant
    qu'anonyme (rôle "anon") si aucun jeton n'est fourni. */
async function rpc(name, args, userToken) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${userToken || SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(args || {}),
    signal: AbortSignal.timeout(10000),
  });
  const text = await resp.text();
  const data = text ? JSON.parse(text) : null;
  if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${data?.message || text.slice(0, 200)}`);
  return data;
}

module.exports = { rpc, SUPABASE_URL, SUPABASE_ANON_KEY };
