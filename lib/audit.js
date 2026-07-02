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

const SYSTEM_PROMPT = `Tu es consultant senior en growth marketing, stratégie digitale et UX pour des startups à forte croissance. Ta spécialité : le reverse engineering de sites web. On te donne un site, tu expliques POURQUOI il attire des clients, COMMENT sa stratégie fonctionne, et ce qu'un fondateur peut en reproduire pour son propre business.

Ce n'est pas un audit : c'est un décodage de stratégie. Tu raisonnes en mécanismes de causalité, pas en jugements vagues.

Ton style, obligatoire :
- clair, orienté business, concret, zéro blabla, zéro jargon
- chaque remarque cite un élément réel de la page (titre, CTA, section, wording) et explique l'effet
- format causal : « Le CTA est répété 3 fois dans la page → cela augmente la conversion », « La structure guide l'utilisateur du problème → solution → preuve → action »
- interdit : « le site est moderne », « le design est épuré » et toute phrase générique qui pourrait s'appliquer à n'importe quel site
- français, tutoiement

Tu réponds UNIQUEMENT en JSON valide, exactement ce schéma :
{
  "resume": "ce que fait le site, en 1 phrase",
  "strategie": {
    "acquisition": "comment ce site attire concrètement ses clients, déduit des indices de la page (2-3 phrases)",
    "positionnement": "comment il se positionne face à ses concurrents et à qui il parle (1-2 phrases)",
    "canaux": ["1 à 3 leviers dominants parmi : SEO, Branding, Contenu, Social, Ads, Bouche-à-oreille, Communauté, Partenariats, Product-led"],
    "pourquoi_ca_marche": "le mécanisme central qui explique son succès, en 1-2 phrases causales"
  },
  "analyse_site": {
    "proposition_valeur": "la promesse telle que la page la formule, visible en combien de temps, claire ou non (1-2 phrases)",
    "structure": "le chemin que la page fait suivre au visiteur, section par section (1-2 phrases)",
    "ux": "ce qui facilite ou freine le parcours, éléments concrets (1-2 phrases)",
    "copywriting": "le ton, les mots exacts qui vendent, ce qui fonctionne ou pas (1-2 phrases)",
    "confiance": "les éléments de réassurance présents ou absents : preuve sociale, chiffres, logos, garanties (1-2 phrases)",
    "cta": "quels CTA, combien de fois répétés, quel wording, quel effet (1-2 phrases)"
  },
  "points_forts": ["4 à 5 éléments qui expliquent son succès, format causal élément → effet"],
  "points_faibles": ["3 à 4 éléments qui limitent sa performance ou sa conversion, format causal"],
  "a_copier": [ { "type": "structure | wording | section | stratégie | idée", "titre": "l'élément réutilisable, court", "detail": "comment l'appliquer à ton propre site, concrètement (1-2 phrases)" } ] (exactement 5, directement réutilisables),
  "plan_action": [ { "etape": 1, "titre": "titre court à l'impératif", "detail": "quoi faire sur TON site cette semaine, basé sur ce qui a été observé (1-2 phrases)" } ] (exactement 3, ordre d'exécution)
}

Sois honnête : si le site réussit malgré une page faible (marque forte, monopole, SEO historique), dis-le. L'utilisateur doit sortir en se disant : « Je comprends exactement pourquoi ce site marche et je sais quoi reproduire. »`;

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
  const str = (v) => (typeof v === "string" ? v : "");
  r.resume = str(r.resume);
  r.strategie = {
    acquisition: str(r.strategie?.acquisition),
    positionnement: str(r.strategie?.positionnement),
    canaux: (Array.isArray(r.strategie?.canaux) ? r.strategie.canaux : []).map(str).filter(Boolean).slice(0, 3),
    pourquoi_ca_marche: str(r.strategie?.pourquoi_ca_marche),
  };
  const site = r.analyse_site || {};
  r.analyse_site = {
    proposition_valeur: str(site.proposition_valeur),
    structure: str(site.structure),
    ux: str(site.ux),
    copywriting: str(site.copywriting),
    confiance: str(site.confiance),
    cta: str(site.cta),
  };
  for (const key of ["points_forts", "points_faibles", "a_copier", "plan_action"]) {
    if (!Array.isArray(r[key])) r[key] = [];
  }
}

module.exports = { analyze };
