/**
 * Verdict — logique d'audit partagée entre le serveur local (server.js)
 * et la fonction serverless Vercel (api/analyze.js).
 */

const dns = require("node:dns").promises;
const net = require("node:net");

const config = () => ({
  apiKey: process.env.MISTRAL_API_KEY,
  model: process.env.MISTRAL_MODEL || "mistral-large-latest",
  baseUrl: process.env.MISTRAL_BASE_URL || "https://api.mistral.ai",
  // Dev uniquement : autorise l'audit d'URLs locales (tests hors ligne).
  allowLocal: process.env.ALLOW_LOCAL === "1",
});

/** Point d'entrée : renvoie { status, body } prêt à sérialiser. */
async function analyze(rawUrl) {
  const cfg = config();
  if (!cfg.apiKey) {
    return { status: 503, body: { error: "Clé API manquante côté serveur. Configure MISTRAL_API_KEY." } };
  }

  let target;
  try {
    target = normalizeUrl(rawUrl);
  } catch {
    return { status: 400, body: { error: "URL invalide. Exemple : https://tonsite.com" } };
  }

  if (!(await isPublicHost(target.hostname, cfg))) {
    return { status: 400, body: { error: "Cette adresse n'est pas accessible publiquement." } };
  }

  let page;
  try {
    page = await fetchPage(target.href);
  } catch (err) {
    console.error("fetch:", err.message);
    return {
      status: 422,
      body: { error: "Impossible de charger cette page. Vérifie que le site est en ligne et accessible." },
    };
  }

  const extract = extractContent(page.html, target.href);
  if (extract.text.length < 80) {
    return {
      status: 422,
      body: { error: "La page ne contient pas assez de contenu lisible pour un audit (site rendu 100 % en JavaScript ?)." },
    };
  }

  try {
    const report = await runAudit(target.href, extract, cfg);
    return { status: 200, body: { url: target.href, finalUrl: page.finalUrl, report } };
  } catch (err) {
    console.error("audit:", err.message);
    return { status: 502, body: { error: "L'analyse a échoué. Réessaie dans un instant." } };
  }
}

function normalizeUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("empty");
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  const u = new URL(s);
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) throw new Error("bad url");
  return u;
}

async function isPublicHost(hostname, cfg) {
  if (cfg.allowLocal) return true;
  if (/^(localhost|.*\.local)$/i.test(hostname)) return false;
  try {
    const { address } = await dns.lookup(hostname);
    if (net.isIPv4(address)) {
      const [a, b] = address.split(".").map(Number);
      if (a === 10 || a === 127 || a === 0) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
      if (a === 169 && b === 254) return false;
    } else if (/^(::1|fe80:|fc|fd)/i.test(address)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchPage(url) {
  const resp = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 VerdictBot/1.0",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const type = resp.headers.get("content-type") || "";
  if (!type.includes("html")) throw new Error(`content-type: ${type}`);
  const html = (await resp.text()).slice(0, 1_500_000);
  return { html, finalUrl: resp.url };
}

/* Extraction de signaux depuis le HTML brut — pas de parseur, regex suffisent
   pour alimenter le modèle avec la structure réelle de la page. */
function extractContent(html, url) {
  const pick = (re) => (html.match(re) || [, ""])[1].trim();
  const pickAll = (re, max) => {
    const out = [];
    let m;
    while ((m = re.exec(html)) && out.length < max) {
      const t = clean(m[1]);
      if (t) out.push(t);
    }
    return out;
  };

  const title = clean(pick(/<title[^>]*>([\s\S]*?)<\/title>/i));
  const metaDesc = clean(
    pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)
  );
  const h1 = pickAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, 4);
  const h2 = pickAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, 12);
  const h3 = pickAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, 12);
  const ctas = [
    ...pickAll(/<button[^>]*>([\s\S]*?)<\/button>/gi, 15),
    ...pickAll(/<a[^>]+class=["'][^"']*(?:btn|button|cta)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi, 15),
  ];

  const text = clean(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
  ).slice(0, 9000);

  const formCount = (html.match(/<form[\s>]/gi) || []).length;
  const imgCount = (html.match(/<img[\s>]/gi) || []).length;
  const hasPricing = /pricing|tarif|prix|€|\$\d|plan/i.test(text);
  const hasTestimonials = /témoignage|testimonial|avis client|review|trusted by|ils nous font confiance/i.test(text);

  return { url, title, metaDesc, h1, h2, h3, ctas: [...new Set(ctas)].slice(0, 12), text, formCount, imgCount, hasPricing, hasTestimonials };
}

function clean(s) {
  return (s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ LLM */

const SYSTEM_PROMPT = `Tu es consultant senior en conversion (CRO), UX et copywriting. Tu audites des landing pages pour des fondateurs de startups et des équipes marketing exigeantes.

Ton style : direct, concret, orienté business. Pas de généralités, pas de jargon. Chaque remarque doit être actionnable et spécifique à LA page analysée (cite des éléments réels de la page : titres, CTA, sections). Tu écris en français, tutoiement.

Tu réponds UNIQUEMENT en JSON valide, exactement ce schéma :
{
  "resume": "le site en une phrase",
  "proposition_valeur": "la proposition de valeur telle que la page la communique, et si elle est claire ou non (2-3 phrases)",
  "scores": { "ux": 0-10, "copywriting": 0-10, "conversion": 0-10 },
  "points_forts": ["3 à 4 points forts concrets"],
  "points_faibles": ["3 à 4 points faibles concrets"],
  "ameliorations": [ { "titre": "action courte à l'impératif", "detail": "comment faire, concrètement, 1-2 phrases" } ] (exactement 5, classées par impact),
  "a_copier": [ { "titre": "élément qui fonctionne bien sur cette page", "detail": "pourquoi ça marche et comment le répliquer ailleurs" } ] (exactement 3),
  "plan_action": [ { "etape": 1, "titre": "titre court", "detail": "quoi faire cette semaine, 1-2 phrases" } ] (exactement 3, ordre d'exécution)
}

Notation : 5 = moyenne du marché, 8+ = excellent, sous 4 = problème sérieux. Sois honnête, pas complaisant.`;

async function runAudit(url, x, cfg) {
  const userPrompt = [
    `Audit de la page : ${url}`,
    ``,
    `TITLE : ${x.title || "(absent)"}`,
    `META DESCRIPTION : ${x.metaDesc || "(absente)"}`,
    `H1 : ${x.h1.join(" | ") || "(aucun)"}`,
    `H2 : ${x.h2.join(" | ") || "(aucun)"}`,
    `H3 : ${x.h3.join(" | ") || "(aucun)"}`,
    `CTA / BOUTONS : ${x.ctas.join(" | ") || "(aucun détecté)"}`,
    `FORMULAIRES : ${x.formCount} — IMAGES : ${x.imgCount} — SECTION PRIX : ${x.hasPricing ? "oui" : "non"} — PREUVE SOCIALE DÉTECTÉE : ${x.hasTestimonials ? "oui" : "non"}`,
    ``,
    `CONTENU TEXTE DE LA PAGE :`,
    x.text,
  ].join("\n");

  const resp = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(90000),
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Mistral ${resp.status}: ${detail.slice(0, 300)}`);
  }

  const data = await resp.json();
  const report = JSON.parse(data.choices[0].message.content);
  validateReport(report);
  return report;
}

function validateReport(r) {
  const bound = (n) => Math.max(0, Math.min(10, Math.round(Number(n) || 0)));
  r.scores = {
    ux: bound(r.scores?.ux),
    copywriting: bound(r.scores?.copywriting),
    conversion: bound(r.scores?.conversion),
  };
  for (const key of ["points_forts", "points_faibles", "ameliorations", "a_copier", "plan_action"]) {
    if (!Array.isArray(r[key])) r[key] = [];
  }
  if (typeof r.resume !== "string") r.resume = "";
  if (typeof r.proposition_valeur !== "string") r.proposition_valeur = "";
}

module.exports = { analyze };
