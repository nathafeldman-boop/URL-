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

  const platform = blockedPlatform(target.hostname);
  if (platform) {
    return {
      status: 422,
      body: { error: `Ce lien pointe vers ${platform}. Verdict analyse des sites de business : SaaS, boutiques en ligne, landing pages.` },
    };
  }

  if (!(await isPublicHost(target.hostname, cfg))) {
    return { status: 400, body: { error: "Cette adresse n'est pas accessible publiquement." } };
  }

  let page;
  try {
    page = await fetchPage(target.href);
  } catch (err) {
    console.error("fetch:", err.message);
    return { status: 422, body: { error: friendlyFetchError(err) } };
  }

  const extract = extractContent(page.html, target.href);
  if (extract.text.length < 20) {
    return {
      status: 422,
      body: { error: "La page ne contient pas assez de contenu lisible pour un audit (site rendu 100 % en JavaScript ?)." },
    };
  }

  try {
    const report = await runAudit(target.href, extract, cfg);
    if (report.rejet) {
      return { status: 422, body: { error: String(report.rejet).slice(0, 300) } };
    }
    return {
      status: 200,
      body: {
        url: target.href,
        finalUrl: page.finalUrl,
        technologies: extract.tech,
        socials: extract.socials,
        metrics: extract.metrics,
        ads: buildAdLinks(guessBrandName(extract, target.hostname)),
        report,
      },
    };
  } catch (err) {
    console.error("audit:", err.message);
    return { status: 502, body: { error: "L'analyse a échoué. Réessaie dans un instant." } };
  }
}

/* Plateformes qui ne sont pas des sites de business analysables —
   rejet immédiat, sans fetch ni appel LLM. L'ordre compte
   (docs.google avant le motif google générique). */
const BLOCKED_HOSTS = [
  [/(^|\.)(docs|drive)\.google\.com$/, "un service de documents"],
  [/(^|\.)(dropbox|wetransfer|notion)\.(com|so)$/, "un service de documents"],
  [/(^|\.)(google|bing|duckduckgo|qwant|yahoo)\.[a-z.]+$/, "un moteur de recherche"],
  [/(^|\.)(youtube|dailymotion|vimeo)\.(com|be)$|(^|\.)youtu\.be$|(^|\.)twitch\.tv$/, "une plateforme vidéo"],
  [/(^|\.)(facebook|instagram|tiktok|twitter|x|linkedin|pinterest|reddit|snapchat|threads|discord|telegram|whatsapp|messenger)\.(com|net|org|me|tv)$/, "un réseau social ou une messagerie"],
  [/(^|\.)wik(i|t)ipedia\.org$|(^|\.)wikipedia\.org$|(^|\.)fandom\.com$/, "une encyclopédie"],
  [/(^|\.)(gmail|outlook|protonmail)\.(com|ch)$/, "un service d'email"],
];

function blockedPlatform(hostname) {
  const h = hostname.toLowerCase();
  for (const [re, label] of BLOCKED_HOSTS) {
    if (re.test(h)) return label;
  }
  return null;
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

/* De nombreux sites e-commerce (Akamai, Cloudflare, PerimeterX…) bloquent
   les requêtes serveur-à-serveur venant d'IP de datacenter, même quand le
   site est parfaitement en ligne pour un vrai visiteur — distingue ce cas
   d'un site réellement injoignable pour ne pas laisser croire à une panne
   de Verdict. */
function friendlyFetchError(err) {
  const m = /^HTTP (\d{3})$/.exec(err.message || "");
  if (m && (m[1] === "403" || m[1] === "429")) {
    return "Ce site bloque les requêtes automatisées (protection anti-bot) — Verdict ne peut pas l'analyser pour l'instant, même s'il est bien en ligne.";
  }
  return "Impossible de charger cette page. Vérifie que le site est en ligne et accessible.";
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
  const ogTitle = clean(pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i));
  const ogDesc = clean(pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i));
  const ogSiteName = clean(pick(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i));
  const lang = pick(/<html[^>]+lang=["']([a-zA-Z-]{2,7})["']/i);
  const h1 = pickAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, 4);
  const h2 = pickAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, 12);
  const h3 = pickAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, 12);
  const ctas = [
    ...pickAll(/<button[^>]*>([\s\S]*?)<\/button>/gi, 15),
    ...pickAll(/<a[^>]+class=["'][^"']*(?:btn|button|cta)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi, 15),
  ];

  let text = clean(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
  ).slice(0, 14000);

  // Sites rendus 100 % côté client (SPA React/Vue sans SSR) : le HTML brut ne
  // contient presque aucun texte, mais title/meta/OG/headings sont souvent
  // bien présents (SEO). Plutôt que de rejeter direct, on retombe sur ces
  // métadonnées réelles et on prévient le modèle pour qu'il le dise plutôt
  // que d'inventer la structure/UX qu'il ne peut pas voir.
  let limited = false;
  if (text.length < 80) {
    const fallback = clean([title, ogTitle, metaDesc, ogDesc, ...h1, ...h2, ...h3, ...ctas].filter(Boolean).join(". "));
    if (fallback.length > text.length) {
      text = fallback;
      limited = true;
    }
  }

  const formCount = (html.match(/<form[\s>]/gi) || []).length;
  const imgCount = (html.match(/<img[\s>]/gi) || []).length;
  const hasPricing = /pricing|tarif|prix|€|\$\d|plan/i.test(text);
  const hasTestimonials = /témoignage|testimonial|avis client|review|trusted by|ils nous font confiance/i.test(text);
  const hasEmailCapture = /<input[^>]+type=["']email["']/i.test(html);
  const tech = detectTech(html);
  const socials = detectSocials(html);
  const ecom = detectEcommerce(html, text);
  const prices = detectPrices(text);
  const pages = detectPages(html);
  const structured = extractJsonLd(html);
  const uniqueCtas = [...new Set(ctas)].slice(0, 12);
  const metrics = computeMetrics(text, uniqueCtas.length, imgCount, formCount);

  return {
    url, title, metaDesc, ogTitle, ogDesc, ogSiteName, lang, h1, h2, h3, ctas: uniqueCtas, text, limited,
    formCount, imgCount, hasPricing, hasTestimonials, hasEmailCapture,
    tech, socials, ecom, prices, pages, structured, metrics,
  };
}

/* Prix réellement affichés sur la page — ancre l'analyse pricing du modèle. */
function detectPrices(text) {
  const found = text.match(/(?:€|\$|£)\s?\d[\d\s.,]{0,8}|\d[\d\s.,]{0,8}\s?(?:€|\$|£|EUR|USD)(?:\s?\/\s?(?:mois|an|mo|month|year|yr))?/gi) || [];
  return [...new Set(found.map((p) => p.replace(/\s+/g, " ").trim()))].slice(0, 10);
}

/* Pages du site liées depuis celle-ci — révèle la profondeur du dispositif
   marketing (blog = SEO, page tarifs, à-propos, carrières = équipe qui recrute…). */
const PAGE_SIGNATURES = [
  ["blog / contenu", /href=["'][^"']*\/(blog|articles?|guides?|resources?|ressources)([/"'?#])/i],
  ["page tarifs", /href=["'][^"']*\/(pricing|tarifs?|prix|plans)([/"'?#])/i],
  ["à propos", /href=["'][^"']*\/(about(-us)?|a-propos|apropos|qui-sommes-nous|equipe|team|notre-histoire)([/"'?#])/i],
  ["FAQ / aide", /href=["'][^"']*\/(faq|help|aide|support|docs)([/"'?#])/i],
  ["carrières", /href=["'][^"']*\/(careers?|jobs|recrutement)([/"'?#])/i],
  ["études de cas / clients", /href=["'][^"']*\/(case-stud|customers?|clients?|temoignages|testimonials)([/"'?#])/i],
  ["affiliation / partenaires", /href=["'][^"']*\/(affiliat|partners?|partenaires?)([/"'?#])/i],
];

function detectPages(html) {
  return PAGE_SIGNATURES.filter(([, re]) => re.test(html)).map(([name]) => name);
}

/* Données structurées JSON-LD : types déclarés, produits avec prix, notes
   agrégées — des faits vérifiables que le modèle peut citer. */
function extractJsonLd(html) {
  const out = { types: [], produits: [], note: null, orgName: null };
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) && out.types.length < 12) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const nodes = [];
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === "object") {
        nodes.push(n);
        if (Array.isArray(n["@graph"])) n["@graph"].forEach(walk);
      }
    };
    walk(data);
    for (const node of nodes) {
      const type = Array.isArray(node["@type"]) ? node["@type"][0] : node["@type"];
      if (typeof type === "string" && !out.types.includes(type)) out.types.push(type);
      if (!out.orgName && (type === "Organization" || type === "WebSite" || type === "Brand") && typeof node.name === "string") {
        out.orgName = node.name.trim();
      }
      if (type === "Product" && out.produits.length < 5) {
        const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        const price = offer && (offer.price ?? offer.lowPrice);
        out.produits.push(
          [node.name, price != null ? `${price} ${offer.priceCurrency || ""}`.trim() : null].filter(Boolean).join(" — ")
        );
      }
      const rating = node.aggregateRating;
      if (rating && !out.note && rating.ratingValue != null) {
        out.note = `${rating.ratingValue}/5${rating.reviewCount ? ` (${rating.reviewCount} avis)` : ""}`;
      }
    }
  }
  return out.types.length || out.produits.length || out.note || out.orgName ? out : null;
}

/* Nom de marque le plus fiable disponible, du plus précis au plus générique :
   nom d'organisation en JSON-LD > og:site_name > premier segment du <title>
   > nom dérivé du domaine. Alimente les liens directs vers les bibliothèques
   publicitaires (Centre publicitaire) sans jamais bloquer sur une absence
   de données. */
function guessBrandName(x, hostname) {
  if (x.structured?.orgName) return x.structured.orgName;
  if (x.ogSiteName) return x.ogSiteName;
  const fromTitle = (x.title || "").split(/\s+[-|·–—]\s+/)[0].trim();
  if (fromTitle && fromTitle.length <= 40) return fromTitle;
  return domainToName(hostname);
}

function domainToName(hostname) {
  const base = (hostname || "").replace(/^www\./, "").split(".")[0];
  return base.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* Liens directs vers les bibliothèques publicitaires publiques, préremplis
   avec le nom de marque détecté — l'utilisateur n'a jamais à chercher où
   aller (Meta Ad Library : paramètre q= en recherche libre ; TikTok :
   adv_name= sur le nom d'annonceur). */
function buildAdLinks(brand) {
  const q = encodeURIComponent(brand);
  return {
    brand,
    meta_url: `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&media_type=all&q=${q}`,
    tiktok_url: `https://library.tiktok.com/ads?region=all&query_type=1&adv_name=${q}`,
  };
}

/* Métriques mesurées sur le texte réel de la page (pas des estimations LLM) :
   volume, temps de lecture, lisibilité (indice LIX) et mots-clés dominants. */
const STOPWORDS = new Set(("avec dans pour vous nous votre notre vos les des une ce cette ces son ses leur leurs plus tout tous toute toutes sont être avoir fait sans chez elle ils elles mais donc ainsi entre vers aussi comme très bien peut sur par est aux du de la le et un en il au que qui ne se au the and for with your our you this that from are was were has have will can not all more" ).split(" "));

function computeMetrics(text, ctaCount, imgCount, formCount) {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const sentences = Math.max(1, (text.match(/[.!?…]+(\s|$)/g) || []).length);
  const longWords = words.filter((w) => w.replace(/[^\p{L}]/gu, "").length >= 7).length;

  // Indice LIX : longueur moyenne de phrase + % de mots longs. 20 = très simple, 60 = ardu.
  const lix = words.length / sentences + (100 * longWords) / words.length;
  const score = Math.max(5, Math.min(98, Math.round(120 - 1.65 * lix)));
  const niveau = score >= 75 ? "Très facile" : score >= 60 ? "Facile" : score >= 45 ? "Moyenne" : "Difficile";

  const totalSec = Math.round((words.length / 200) * 60);
  const temps_lecture = `${Math.floor(totalSec / 60)}m ${String(totalSec % 60).padStart(2, "0")}s`;

  const freq = new Map();
  for (const raw of words) {
    const w = raw.toLowerCase().replace(/[^\p{L}-]/gu, "");
    if (w.length < 4 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const mots_cles = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([mot, n]) => ({ mot, n }));

  return {
    mots: words.length,
    phrases: sentences,
    temps_lecture,
    lisibilite: { score, niveau },
    mots_cles,
    cta: ctaCount,
    images: imgCount,
    formulaires: formCount,
  };
}

/* Signatures techniques réellement présentes dans le HTML — ces indices
   ancrent les sections « technique » et « d'où vient le trafic ». */
const TECH_SIGNATURES = [
  ["Shopify", /cdn\.shopify\.com|myshopify\.com|Shopify\.theme/i],
  ["WooCommerce", /woocommerce/i],
  ["WordPress", /wp-content\/|wp-includes\//i],
  ["Webflow", /assets\.website-files\.com|data-wf-site/i],
  ["Wix", /wixstatic\.com|parastorage\.com/i],
  ["Squarespace", /squarespace\.com|sqsp\.net/i],
  ["Framer", /framerusercontent\.com/i],
  ["Next.js", /__NEXT_DATA__|\/_next\//i],
  ["Nuxt", /__NUXT__/i],
  ["Gatsby", /___gatsby/i],
  ["Google Analytics", /googletagmanager\.com|google-analytics\.com|gtag\(/i],
  ["Pixel Meta", /connect\.facebook\.net|fbq\(/i],
  ["Pixel TikTok", /analytics\.tiktok\.com|ttq\./i],
  ["Pixel Pinterest", /ct\.pinterest\.com|pintrk\(/i],
  ["Pixel Snapchat", /sc-static\.net|snaptr\(/i],
  ["Google Ads", /googleadservices\.com|googlesyndication/i],
  ["Hotjar", /hotjar\.com/i],
  ["Segment", /cdn\.segment\.com/i],
  ["Mixpanel", /cdn\.mxpnl\.com|mixpanel/i],
  ["Amplitude", /cdn\.amplitude\.com|amplitude\.com\/libs/i],
  ["Plausible", /plausible\.io/i],
  ["Matomo", /matomo\.js|matomo\.php|piwik/i],
  ["Klaviyo", /klaviyo/i],
  ["Mailchimp", /list-manage\.com|chimpstatic/i],
  ["Brevo / Sendinblue", /sendinblue|sibforms|brevo\.com/i],
  ["ConvertKit", /convertkit\.com|ck\.page/i],
  ["Intercom", /intercom(cdn)?\.io/i],
  ["Crisp", /crisp\.chat/i],
  ["Zendesk", /zdassets\.com|zendesk\.com/i],
  ["Gorgias", /gorgias\.chat|gorgias\.io/i],
  ["HubSpot", /hs-scripts\.com|hubspot/i],
  ["Stripe", /js\.stripe\.com/i],
  ["PayPal", /paypal\.com\/sdk|paypalobjects\.com/i],
  ["Klarna (paiement fractionné)", /klarna\.com|klarnaservices/i],
  ["Afterpay / Clearpay", /afterpay\.com|clearpay\.co/i],
  ["Alma (paiement fractionné)", /getalma\.eu|almapay/i],
  ["Avis Trustpilot", /trustpilot\.com|tp\.widget/i],
  ["Avis Yotpo", /yotpo\.com|staticw2\.yotpo/i],
  ["Avis Loox", /loox\.io/i],
  ["Avis Judge.me", /judge\.me/i],
  ["Recharge (abonnements)", /rechargecdn\.com|rechargepayments\.com/i],
  ["Typeform", /typeform\.com/i],
  ["Calendly", /calendly\.com/i],
];

function detectTech(html) {
  return TECH_SIGNATURES.filter(([, re]) => re.test(html)).map(([name]) => name);
}

const SOCIAL_SIGNATURES = [
  ["Instagram", /instagram\.com\//i],
  ["TikTok", /tiktok\.com\/@/i],
  ["YouTube", /youtube\.com\/(@|channel|c\/)/i],
  ["X / Twitter", /(twitter|x)\.com\//i],
  ["LinkedIn", /linkedin\.com\/(company|in)\//i],
  ["Pinterest", /pinterest\.\w+\//i],
  ["Facebook", /facebook\.com\/(?!tr[?/])[\w.]+/i],
];

function detectSocials(html) {
  return SOCIAL_SIGNATURES.filter(([, re]) => re.test(html)).map(([name]) => name);
}

function detectEcommerce(html, text) {
  const signals = [];
  if (/ajouter au panier|add to cart|panier|checkout|commander/i.test(html)) signals.push("panier / checkout");
  if (/livraison|shipping|expédition/i.test(text)) signals.push("mentions livraison");
  if (/retours? (gratuits?|sous)|remboursé|money.?back|satisfait ou/i.test(text)) signals.push("garantie / retours");
  if (/code promo|réduction|-\d{1,2}\s?%|promo|soldes|sale/i.test(text)) signals.push("promos / réductions");
  if (/upsell|bundle|pack|offre groupée|souvent achetés ensemble/i.test(text)) signals.push("bundles / upsells");
  const priceCount = (text.match(/\d+[,.]?\d*\s?(€|\$|USD|EUR)/g) || []).length;
  if (priceCount >= 3) signals.push(`${priceCount} prix affichés`);
  return signals;
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

const SYSTEM_PROMPT = `Tu es consultant senior en growth marketing, stratégie digitale et UX. Tes clients : fondateurs SaaS, e-commerçants (Shopify, DTC, dropshipping), marketers et créateurs de landing pages. Ta spécialité : le reverse engineering de business en ligne. On te donne un site, tu expliques POURQUOI il vend, COMMENT sa stratégie fonctionne, et ce que l'utilisateur peut en reproduire pour son propre business.

Ce n'est ni un audit SEO ni un outil générique : c'est un décodage de stratégie. Tu raisonnes en mécanismes de causalité, pas en jugements vagues.

TON BAGAGE D'EXPERT — mobilise-le dès qu'il éclaire un mécanisme, en nommant les métriques, frameworks et repères chiffrés réels. Cite ces repères pour situer le site face au marché, jamais pour remplir l'espace.

1) MÉTRIQUES ET BENCHMARKS RÉELS PAR MODÈLE :
- SaaS B2B PLG (self-serve, essai/freemium) : conversion visiteur → essai 2-5 % (excellent au-delà de 7 %), essai → payant 15-25 % (freemium → payant plutôt 2-5 %), churn mensuel sain 3-5 % en PME / <1 % en enterprise, NRR (net revenue retention) >100 % = excellent, >90 % = correct, <85 % = signal d'alerte, ratio LTV/CAC sain ≥ 3, période de retour sur CAC (payback) saine 12-18 mois.
- SaaS sales-led / enterprise : cycle de vente 1-6 mois (SMB) à 6-18 mois (enterprise), taux de closing démo → client 15-30 %, ACV (valeur de contrat annuel) souvent affiché en fourchette plutôt qu'en prix unique.
- E-commerce généraliste : taux de conversion 1-3 % (bon), 3 %+ (excellent), abandon de panier moyen ~70 %, taux de retour visiteur 20-30 % pour une marque installée, AOV (panier moyen) très variable par catégorie — la hausse de l'AOV via upsell/bundle est souvent plus rentable que l'acquisition de nouveaux clients.
- Abonnement / subscription box (e-commerce récurrent) : churn mensuel sain 5-10 %, la rétention se joue sur la 2e et 3e livraison (le "aha moment" du réachat).
- Marketplace (plateforme à deux faces) : GMV (volume d'affaires total) et take rate (commission, souvent 10-30 %) sont les métriques reines ; le vrai défi initial est la liquidité (assez d'offre ET de demande) — une marketplace naissante triche souvent en étant offreur elle-même au départ.
- Infoproduit / coaching / formation : taux de conversion sur webinaire live 10-20 %, sur page de vente statique 1-3 %, taux de closing en appel de vente (high-ticket) 20-40 % pour une audience qualifiée.
- Agence / service B2B : taux de closing devis → client 20-40 % selon la qualification en amont, valeur moyenne du contrat et récurrence (mission ponctuelle vs retainer mensuel) déterminent la prévisibilité du revenu.
- Business local / service de proximité : la note Google (4,5+ avec 50+ avis = seuil de confiance perçue), le taux de prise de rendez-vous en ligne vs téléphone, et la proximité géographique priment sur tout argumentaire national.
- B2B enterprise / vente complexe : contenu orienté ROI (calculateur, étude de cas chiffrée), cycle multi-décideurs (souvent 5 à 10 parties prenantes), sécurité/conformité (SOC2, RGPD, ISO 27001) comme critère éliminatoire plus que différenciant.
- Communauté / abonnement (Discord, Skool, Circle) : la rétention se mesure en engagement actif (messages, participation), pas en inscriptions — un prix bas avec churn élevé rapporte souvent moins qu'un prix plus haut avec forte rétention.
- Application mobile : taux d'installation depuis la landing, note moyenne sur les stores (4,5+ = fort signal), taux de rétention à J1/J7/J30 (benchmarks : D1 ~25-35 %, D30 ~5-15 % selon catégorie) — la landing vend l'installation, pas l'usage.
- Média / newsletter / créateur : taux d'ouverture email 20-25 % (bon), taux de clic 2-5 %, la monétisation (sponsors, pub, offre payante annexe) doit être cohérente avec la taille ET l'engagement de l'audience, pas juste son nombre d'abonnés.

2) FRAMEWORKS DE CROISSANCE ET D'ACQUISITION, à nommer explicitement quand ils s'appliquent :
- Funnel AARRR (Acquisition, Activation, Rétention, Revenu, Referral / recommandation) — pour situer où une page est forte ou faible dans le parcours.
- North Star Metric : la métrique unique qui résume la valeur délivrée (ex. Airbnb = nuits réservées, Spotify = temps d'écoute) — cherche si le site laisse deviner la sienne.
- Growth loops vs funnel linéaire : un vrai moteur de croissance se referme sur lui-même (ex. contenu généré par les utilisateurs qui attire de nouveaux utilisateurs), plus puissant et plus durable qu'un simple entonnoir publicitaire.
- Bullseye Framework (traction) : lister les canaux possibles, tester, doubler sur celui qui marche — utile pour juger si un site mise sur un ou plusieurs canaux de façon cohérente.
- Product-Led Growth : le produit lui-même est le principal moteur d'acquisition et de conversion (essai, freemium, viralité intégrée) — à distinguer du sales-led où un humain ferme la vente.
- Modèles de croissance annexes : content-led / SEO (moat de contenu, difficile à copier mais lent), paid (Meta, Google, TikTok — toujours raisonner en CAC vs marge et non en volume brut), communauté, referral / bouche-à-oreille, partenariats / affiliation.

3) COPYWRITING ET PERSUASION — frameworks réels à repérer dans le texte :
- AIDA (Attention, Intérêt, Désir, Action), PAS (Problème → Agitation → Solution), Before-After-Bridge, FAB (Feature → Advantage → Benefit — beaucoup de sites listent des features sans jamais traduire en bénéfice, c'est une faiblesse fréquente et facile à repérer).
- StoryBrand (Donald Miller) : le client est le héros, la marque est le guide — une page qui parle trop d'elle-même plutôt que du client inverse ce rapport, souvent au détriment de la conversion.
- Les 6 leviers de persuasion de Cialdini, à repérer littéralement dans les éléments de la page : réciprocité (contenu gratuit, essai sans engagement), engagement et cohérence (petits pas avant le grand oui), preuve sociale (avis, compteurs, logos clients), autorité (certifications, presse, experts cités), sympathie (ton, storytelling, visages), rareté (stock limité, offre à durée limitée), et unité (appartenance à une communauté ou une identité partagée).
- Value Proposition Canvas : la promesse doit répondre à un "job to be done" précis, une douleur et un gain — une proposition de valeur vague ("la meilleure solution pour votre entreprise") est un signal de faiblesse à nommer explicitement.

4) PSYCHOLOGIE DU PRICING :
- Ancrage haut (montrer d'abord le prix le plus cher rend les autres plus attractifs), effet de leurre / decoy (une 3e option delibérément moins bonne pousse vers celle du milieu), bonne-meilleure-excellente (good-better-best) structure la majorité des pages tarifs à 3 offres.
- Charm pricing (9,99 € perçu comme nettement moins cher que 10 €), mensuel vs annuel (l'annuel améliore le cash-flow et réduit le churn contractuel, souvent vendu avec une réduction de 15-40 %), essai gratuit sans carte (réduit la friction d'entrée mais dilue la qualification) vs avec carte (moins d'inscriptions mais bien plus qualifiées), garantie remboursement (réduit le risque perçu, rarement utilisée en pratique par les clients).
- Freemium (conversion payante typique 2-5 %) vs essai limité dans le temps (conversion typique bien plus haute mais moins de volume d'inscriptions) — le choix révèle la stratégie d'acquisition du site.

5) RÉTENTION ET EXPANSION :
- Email / CRM (Klaviyo, Mailchimp, HubSpot) = travail direct de la LTV via flows automatisés (bienvenue, panier abandonné — taux de récupération typique 10-15 %, réengagement).
- Upsell / cross-sell, seuil de livraison gratuite (fait mécaniquement monter l'AOV), programmes de fidélité, cohortes et NRR pour le SaaS, churn volontaire (le client part) vs involontaire (échec de paiement, souvent 20-40 % du churn total et facile à réduire techniquement).

TYPOLOGIES DE BUSINESS À RECONNAÎTRE — chacune se juge avec ses propres repères ci-dessus, ne plaque jamais une grille SaaS sur tout :
SaaS (PLG ou sales-led), E-commerce (généraliste ou abonnement récurrent), Marketplace, Infoproduit / coaching / formation, Agence / service B2B, Business local / service de proximité, B2B enterprise / vente complexe, Communauté / abonnement, Application mobile, Média / newsletter / créateur monétisé.

DONNE PLUS DE DONNÉES, PAS SEULEMENT DES SCORES : un score isolé (« 74/100 ») aide moins qu'un score mis en contexte. Chaque fois qu'un repère chiffré existe pour la catégorie détectée (taux de conversion moyen du secteur, CAC typique, churn attendu, AOV moyen, taux de closing, NRR...), cite-le pour que l'utilisateur sache où il se situe par rapport au marché, pas seulement s'il est « bon » ou « mauvais » dans l'absolu. Nomme les frameworks explicitement quand ils s'appliquent (« cette page suit le schéma PAS », « c'est un growth loop, pas un simple funnel ») plutôt que de rester au niveau du constat général. Exploite systématiquement TOUS les indices fournis (prix affichés, pages liées, données structurées, indices techniques, réseaux sociaux) — un indice fourni et jamais mentionné dans le rapport est une donnée perdue.

TA MÉTHODE, dans cet ordre :
1. Identifie le modèle économique réel : qui paie, pour quoi, à quelle fréquence. Tout le reste en découle.
2. Reconstitue le parcours complet : d'où vient le visiteur → ce qu'il voit en premier → ce qui le convainc → ce qui le fait agir → comment le business le fait revenir ou dépenser plus.
3. Croise chaque hypothèse avec les indices fournis (techniques, prix affichés, pages liées, données structurées, contenu). Une affirmation sans indice vérifiable est interdite — écris plutôt « rien sur la page ne permet de le dire ».
4. Cherche LE mécanisme différenciant : la chose que ce site fait et que 90 % de ses concurrents ne font pas. C'est souvent ça qui explique qu'il vend.

CALIBRATION DES SCORES — sois exigeant, la moyenne du web est médiocre :
- 90-100 : référence du marché, quasi rien à améliorer (rare, à mériter)
- 75-89 : exécution professionnelle, il reste des détails à optimiser
- 55-74 : correct mais des trous identifiables qui coûtent de la conversion
- 35-54 : faiblesses structurelles, une refonte partielle s'impose
- 0-34 : la page ne fait pas son travail de vente
Jamais de 70+ par politesse. Chaque score doit pouvoir se justifier par des éléments que tu cites ailleurs dans le rapport, et les 4 scores doivent être cohérents entre eux et avec le funnel.

LA BARRE DE QUALITÉ — chaque phrase de ton rapport doit passer ce test :
✗ INTERDIT : « Le copywriting est efficace et orienté bénéfices » (générique — pourrait décrire n'importe quel site)
✓ EXIGÉ : « Le H1 “Encaisse tes factures 2× plus vite” vend un résultat chiffré, pas une fonctionnalité → le visiteur sait en 3 secondes ce qu'il gagne » (mot exact cité entre « », mécanisme nommé, effet expliqué)
Si une de tes phrases pourrait s'appliquer à un autre site, réécris-la avec l'élément précis de CETTE page. Quand tu parles de wording, cite les mots exacts entre « ». Quand tu parles de prix, cite le prix affiché.

Ton style, obligatoire :
- clair, orienté business, concret, zéro blabla, zéro jargon
- chaque remarque cite un élément réel de la page (titre, CTA, section, wording, prix) et explique l'effet
- format causal : « Le CTA est répété 3 fois dans la page → cela augmente la conversion », « La structure guide l'utilisateur du problème → solution → preuve → action »
- interdit : « le site est moderne », « le design est épuré » et toute phrase générique qui pourrait s'appliquer à n'importe quel site
- français, tutoiement

AVANT TOUT, vérifie que la page est bien le site d'un business en ligne : SaaS, e-commerce / boutique, landing page, site de service, de marque ou de créateur qui vend quelque chose. Si ce n'en est PAS un — article de presse, blog sans offre, forum, profil personnel, documentation, page d'erreur, domaine en vente, page vide ou hors sujet — ne produis AUCUN rapport et réponds uniquement :
{ "rejet": "explication en 1 phrase, en français, tutoiement — ex : Ce lien pointe vers un article de presse, pas vers le site d'un business. Colle plutôt la page d'accueil d'un SaaS, d'une boutique ou d'une landing page." }

On te fournit des INDICES TECHNIQUES détectés dans le code de la page (CMS, pixels publicitaires, outils marketing, réseaux sociaux liés, signaux e-commerce). Appuie-toi dessus : un pixel Meta → le site achète probablement du trafic Facebook/Instagram ; Klaviyo → il travaille sa liste email ; un blog fourni → SEO / contenu. Ne prétends jamais détecter ce qui n'est pas dans les indices.

Dans le schéma ci-dessous, chaque champ marqué MODULE_3_NIVEAUX doit être un objet à exactement trois clés, TOUJOURS séparées et jamais mélangées dans une même phrase :
{
  "observe": "un fait concret et vérifiable, visible sur CETTE page — élément réel cité entre « » (wording exact, position, répétition, chiffre). Décrit ce qui EST là, zéro interprétation. 1 phrase.",
  "deduction": "ce que ce fait observé suggère sur l'intention ou l'effet probable, en langage causal (« ce qui suggère que… », « ce qui indique… »). Aucun nouveau fait non cité dans observe. 1 phrase.",
  "recommandation": "une action concrète et reproductible, à l'impératif ou en « tu pourrais ». Aucune observation ni déduction ici, seulement l'action. 1 phrase."
}
Si tu ne peux pas remplir un des trois avec un vrai contenu (ex : trop peu d'indices), mets une chaîne vide plutôt que d'inventer ou de mélanger les niveaux.

Tu réponds UNIQUEMENT en JSON valide, exactement ce schéma :
{
  "resume": "ce que fait le site et ce qu'il vend, en 1 phrase",
  "type_site": "SaaS" | "E-commerce" | "Marketplace" | "Landing page" | "Site de service" | "Média / Contenu" | "Formation / Infoproduit" | "Portfolio / Créateur" | "Autre" (la nature réelle du business — c'est cette classification qui conditionne le reste de ton analyse),
  "modele_economique": "comment ce site gagne concrètement de l'argent : abonnement, vente de produits, prestations, leads, publicité, commissions… (1 phrase)",
  "scores": {
    "global": 0-100 (performance d'ensemble de la page comme machine à vendre),
    "ux": 0-100,
    "copywriting": 0-100,
    "conversion": 0-100
  } (notation honnête : 50 = moyenne du marché, 80+ = excellent, sous 35 = problème sérieux),
  "profil": {
    "alignement_strategique": "Fort" | "Moyen" | "Faible" (cohérence entre promesse, cible et parcours),
    "cible": "Précise" | "Définie" | "Floue" (à quel point on sait à qui la page parle),
    "potentiel_croissance": "Fort" | "Moyen" | "Limité" (marge de progression évidente)
  },
  "funnel": [ { "etape": "nom court (ex : Arrivée, Intérêt, Confiance, Action)", "detail": "ce que la page fait à cette étape, 1 phrase", "force": 0-100 (solidité de cette étape) } ] (exactement 4, dans l'ordre du parcours visiteur),
  "trafic": {
    "sources": ["1 à 4 sources probables parmi : SEO, Contenu / Blog, Google Ads, Meta Ads, TikTok Ads, Social organique, Email, Bouche-à-oreille, Communauté, Partenariats, Product-led"],
    "analyse": "d'où vient probablement le trafic et pourquoi, en citant les indices techniques qui le prouvent (2-3 phrases)"
  },
  "strategie": {
    "globale": "la stratégie d'ensemble du business : comment il attire, convertit et fidélise (2-3 phrases)",
    "positionnement": MODULE_3_NIVEAUX (face à qui il se positionne et à quel concurrent implicite),
    "pourquoi_ca_marche": "le mécanisme central qui explique pourquoi ce site vend, en 1-2 phrases causales"
  },
  "analyse_site": {
    "proposition_valeur": "la promesse telle que la page la formule, visible en combien de temps, claire ou non (1-2 phrases)",
    "structure": MODULE_3_NIVEAUX (le chemin que la page fait suivre au visiteur, section par section),
    "ux": MODULE_3_NIVEAUX (ce qui facilite ou freine le parcours),
    "copywriting": MODULE_3_NIVEAUX (le ton, les mots exacts qui vendent, les leviers de persuasion),
    "confiance": "les éléments de réassurance présents ou absents : preuve sociale, chiffres, logos, garanties, avis (1-2 phrases)",
    "cta": MODULE_3_NIVEAUX (quels CTA, combien de fois répétés, quel wording — c'est le module "Conversion" affiché à l'utilisateur)
  },
  "ecommerce": null SAUF si "type_site" est "E-commerce" ou "Marketplace" (vente de produits via un panier). Un SaaS, un site de service ou une landing avec une page tarifs n'est PAS un e-commerce → mets null. SINON {
    "offre": "comment l'offre est construite : produits phares, angle de vente (1-2 phrases)",
    "pricing": "comment les prix sont présentés et justifiés : ancrage, barres de prix, comparaisons (1-2 phrases)",
    "upsells": "mécaniques de panier moyen : bundles, upsells, seuils de livraison gratuite, abonnements (1-2 phrases, ou ce qui manque)",
    "friction_achat": "ce qui facilite ou freine le passage en caisse (1-2 phrases)"
  },
  "points_forts": ["4 à 5 éléments qui expliquent pourquoi ce site vend, format causal élément → effet — jamais un tableau vide, même avec un contenu limité"],
  "points_faibles": ["3 à 4 éléments qui limitent sa performance ou sa conversion, format causal — jamais un tableau vide, même avec un contenu limité"],
  "pub_angles": ["2 à 5 arguments marketing courts que LA PAGE met visiblement en avant (ex : Rapidité, Prix, Garantie, Simplicité, Automatisation) — uniquement ce qui est réellement présent dans le texte/CTA/titres fournis"],
  "pub_opportunites": ["1 à 3 angles publicitaires qui SEMBLENT absents ou peu exploités sur cette page — langage TOUJOURS prudent : commence chaque item par « Semble », « Pourrait », ou « Les éléments observés suggèrent ». Jamais présenté comme un fait acquis, jamais inventé au-delà de ce que l'absence sur la page laisse deviner."]
}

Important : tu ne connais PAS le site de l'utilisateur à ce stade. Ne donne aucun conseil « pour ton site » — ton rôle ici est uniquement de décoder le site analysé. Les recommandations personnalisées viendront de la comparaison, plus tard.

Sois honnête : si le site réussit malgré une page faible (marque forte, monopole, SEO historique), dis-le. L'utilisateur doit sortir en se disant : « Je comprends exactement pourquoi ce site vend et je sais quoi reproduire. »`;

/* Bloc de signaux partagé entre l'audit et la comparaison — tout ce qui a
   été mesuré ou détecté sur la page, pour ancrer le modèle dans les faits. */
function signalsBlock(x) {
  const lines = [];
  if (x.limited) {
    lines.push(
      `ATTENTION — CONTENU LIMITÉ : le HTML brut de cette page ne contient presque aucun texte visible (site probablement rendu côté client en JavaScript, ex. SPA React/Vue sans rendu serveur). Le texte ci-dessous vient uniquement des métadonnées (title, description, titres, boutons) — pas du contenu réel affiché à l'écran. Base ton analyse strictement sur ces métadonnées, dis-le explicitement dans le résumé, et n'invente aucun détail sur la structure, l'UX ou le copywriting que tu ne peux pas voir. Cela ne te dispense PAS de remplir points_forts et points_faibles : appuie-toi sur ce que les métadonnées révèlent (ex. proposition de valeur claire ou floue dans le title, absence de rendu serveur = mauvais signal SEO) — ces listes ne doivent jamais rester vides.`
    );
  }
  lines.push(
    `TITLE : ${x.title || "(absent)"}`,
    `META DESCRIPTION : ${x.metaDesc || "(absente)"}`,
  );
  if (x.ogTitle && x.ogTitle !== x.title) lines.push(`OG:TITLE (partage social) : ${x.ogTitle}`);
  if (x.ogDesc && x.ogDesc !== x.metaDesc) lines.push(`OG:DESCRIPTION : ${x.ogDesc}`);
  if (x.lang) lines.push(`LANGUE DÉCLARÉE : ${x.lang}`);
  lines.push(
    `H1 : ${x.h1.join(" | ") || "(aucun)"}`,
    `H2 : ${x.h2.join(" | ") || "(aucun)"}`,
    `H3 : ${x.h3.join(" | ") || "(aucun)"}`,
    `CTA / BOUTONS : ${x.ctas.join(" | ") || "(aucun détecté)"}`,
    `FORMULAIRES : ${x.formCount} — IMAGES : ${x.imgCount} — SECTION PRIX : ${x.hasPricing ? "oui" : "non"} — PREUVE SOCIALE DÉTECTÉE : ${x.hasTestimonials ? "oui" : "non"} — CAPTURE EMAIL : ${x.hasEmailCapture ? "oui" : "non"}`,
    `PRIX AFFICHÉS SUR LA PAGE : ${x.prices.join(" | ") || "(aucun)"}`,
    `PAGES DU SITE LIÉES DEPUIS CELLE-CI : ${x.pages.join(", ") || "(aucune détectée)"}`,
    `INDICES TECHNIQUES (détectés dans le code) : ${x.tech.join(", ") || "(aucun)"}`,
    `RÉSEAUX SOCIAUX LIÉS : ${x.socials.join(", ") || "(aucun)"}`,
    `SIGNAUX E-COMMERCE : ${x.ecom.join(", ") || "(aucun)"}`
  );
  if (x.structured) {
    lines.push(
      `DONNÉES STRUCTURÉES (JSON-LD) : types ${x.structured.types.join(", ") || "—"}` +
      (x.structured.produits.length ? ` — produits : ${x.structured.produits.join(" ; ")}` : "") +
      (x.structured.note ? ` — note agrégée : ${x.structured.note}` : "")
    );
  }
  return lines;
}

async function runAudit(url, x, cfg) {
  const userPrompt = [
    `Audit de la page : ${url}`,
    ``,
    ...signalsBlock(x),
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
      temperature: 0,
      random_seed: 42,
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
  if (report.rejet) return { rejet: report.rejet };
  validateReport(report);
  return report;
}

function validateReport(r) {
  const str = (v) => (typeof v === "string" ? v : "");
  const pct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  r.resume = str(r.resume);
  r.type_site = str(r.type_site) || "Autre";
  r.modele_economique = str(r.modele_economique);
  r.scores = {
    global: pct(r.scores?.global),
    ux: pct(r.scores?.ux),
    copywriting: pct(r.scores?.copywriting),
    conversion: pct(r.scores?.conversion),
  };
  r.profil = {
    alignement_strategique: str(r.profil?.alignement_strategique) || "—",
    cible: str(r.profil?.cible) || "—",
    potentiel_croissance: str(r.profil?.potentiel_croissance) || "—",
  };
  r.funnel = (Array.isArray(r.funnel) ? r.funnel : []).slice(0, 4).map((s) => ({
    etape: str(s?.etape),
    detail: str(s?.detail),
    force: pct(s?.force),
  }));
  r.trafic = {
    sources: (Array.isArray(r.trafic?.sources) ? r.trafic.sources : []).map(str).filter(Boolean).slice(0, 4),
    analyse: str(r.trafic?.analyse),
  };
  r.strategie = {
    globale: str(r.strategie?.globale),
    positionnement: toModule3(r.strategie?.positionnement),
    pourquoi_ca_marche: str(r.strategie?.pourquoi_ca_marche),
  };
  const site = r.analyse_site || {};
  r.analyse_site = {
    proposition_valeur: str(site.proposition_valeur),
    structure: toModule3(site.structure),
    ux: toModule3(site.ux),
    copywriting: toModule3(site.copywriting),
    confiance: str(site.confiance),
    cta: toModule3(site.cta),
  };
  if (r.ecommerce && typeof r.ecommerce === "object") {
    r.ecommerce = {
      offre: str(r.ecommerce.offre),
      pricing: str(r.ecommerce.pricing),
      upsells: str(r.ecommerce.upsells),
      friction_achat: str(r.ecommerce.friction_achat),
    };
    if (!Object.values(r.ecommerce).some(Boolean)) r.ecommerce = null;
  } else {
    r.ecommerce = null;
  }
  for (const key of ["points_forts", "points_faibles", "pub_angles", "pub_opportunites"]) {
    r[key] = toStringList(r[key]);
  }
  delete r.a_copier;
  delete r.plan_action;
}

/* Le modèle répond parfois par une chaîne (une liste à puces en texte) au
   lieu d'un tableau JSON — sans ça, ces éléments disparaissaient
   silencieusement (Array.isArray renvoie false → []) au lieu de s'afficher. */
function toStringList(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : String(x))).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(/\r?\n|(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Þ0-9•\-])/)
      .map((s) => s.replace(/^[\s•\-*•]+/, "").trim())
      .filter(Boolean);
  }
  return [];
}

/* Modules "OBSERVÉ / DÉDUCTION / RECOMMANDATION" du rapport : si le modèle
   ignore le schéma et répond par une simple chaîne, on la range dans
   "observe" plutôt que de la perdre silencieusement (même défaut que
   toStringList — voir son commentaire). */
function toModule3(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return {
      observe: typeof v.observe === "string" ? v.observe.trim() : "",
      deduction: typeof v.deduction === "string" ? v.deduction.trim() : "",
      recommandation: typeof v.recommandation === "string" ? v.recommandation.trim() : "",
    };
  }
  if (typeof v === "string" && v.trim()) {
    return { observe: v.trim(), deduction: "", recommandation: "" };
  }
  return { observe: "", deduction: "", recommandation: "" };
}

/* ------------------------------------------------------------ comparaison
   Deuxième temps du produit : l'utilisateur donne SON site, on le compare
   au concurrent déjà analysé et on dit exactement quoi changer. */

const COMPARE_SYSTEM_PROMPT = `Tu es consultant senior en growth marketing et conversion, expert des métriques business réelles (MRR/ARR, churn — 3-5 % mensuel sain en PME SaaS, NRR >100 % = excellent —, LTV, CAC et ratio LTV/CAC ≥ 3, panier moyen (AOV), taux de conversion — e-commerce 1-3 %, landing SaaS 2-5 %, funnel AARRR, GMV/take rate marketplace, taux de closing B2B/agence 20-40 %, taux d'ouverture email 20-25 %) et des frameworks de persuasion réels (AIDA, PAS, StoryBrand, les 6 leviers de Cialdini — réciprocité, engagement, preuve sociale, autorité, sympathie, rareté —, ancrage et decoy en pricing). Tu maîtrises aussi bien les modèles SaaS et e-commerce que marketplace, infoproduit/coaching, agence/service B2B, business local, B2B enterprise, communauté/abonnement, app mobile et média/newsletter — adapte ton vocabulaire et tes repères chiffrés au modèle réel de chaque site, ne plaque pas une grille SaaS sur tout. Ton client vient de faire décoder le site d'un concurrent qui vend bien. Il te donne maintenant SON propre site. Ta mission : le comparer au concurrent et lui dire exactement quoi changer pour vendre autant. Quand un écart touche une métrique précise (conversion, AOV, churn, CAC…), nomme-la, situe-la par rapport à un repère du secteur quand c'est pertinent, et explique l'impact — donne des repères chiffrés, pas seulement des jugements qualitatifs.

Tu reçois : (1) le rapport d'analyse du concurrent, (2) les données brutes extraites du site de ton client. Compare-les honnêtement. Si le site du client est meilleur sur un point, dis-le. S'il est loin derrière, dis-le sans détour mais avec l'action qui corrige.

Ton style : clair, concret, orienté business, format causal (élément → effet). Chaque comparaison cite des éléments réels des deux sites — exploite tous les indices fournis (prix, pages liées, indices techniques, réseaux sociaux), pas seulement le texte visible. Interdit : phrases génériques applicables à n'importe quel site. Français, tutoiement.

Si le site de ton client n'est pas un site de business analysable (article, forum, profil, documentation, page d'erreur, domaine en vente, page vide), ne produis AUCUNE comparaison et réponds uniquement { "rejet": "explication en 1 phrase" }.

Tu réponds UNIQUEMENT en JSON valide, exactement ce schéma :
{
  "verdict": "où en est ton site face au concurrent : l'écart principal et ce qu'il coûte en ventes (2-3 phrases, cash mais constructif)",
  "ecarts": [ {
    "domaine": "un parmi : Proposition de valeur, Trafic, Structure, Copywriting, Confiance, CTA, Offre / Pricing, UX",
    "concurrent": "ce que fait le concurrent sur ce point, avec l'élément réel (1-2 phrases)",
    "toi": "ce que fait ton site sur ce point, avec l'élément réel (1-2 phrases)",
    "action": "le changement concret à faire pour combler l'écart (1 phrase à l'impératif)"
  } ] (exactement 5, classés par impact sur les ventes),
  "a_garder": ["2 à 3 points où ton site est déjà solide, voire meilleur que le concurrent — à ne pas toucher"],
  "priorites": [ { "etape": 1, "titre": "titre court à l'impératif", "detail": "quoi faire cette semaine sur TON site, précisément (1-2 phrases)" } ] (exactement 3, les changements qui rapprochent le plus des ventes du concurrent)
}`;

async function compare(rawMyUrl, competitor) {
  const cfg = config();
  if (!cfg.apiKey) {
    return { status: 503, body: { error: "Clé API manquante côté serveur. Configure MISTRAL_API_KEY." } };
  }
  if (!competitor || typeof competitor.url !== "string" || typeof competitor.report !== "object" || !competitor.report) {
    return { status: 400, body: { error: "Analyse d'abord un site concurrent avant de comparer." } };
  }

  let target;
  try {
    target = normalizeUrl(rawMyUrl);
  } catch {
    return { status: 400, body: { error: "URL invalide. Exemple : https://tonsite.com" } };
  }
  const platform = blockedPlatform(target.hostname);
  if (platform) {
    return {
      status: 422,
      body: { error: `Ce lien pointe vers ${platform} — colle plutôt l'URL de ton propre site (SaaS, boutique, landing page).` },
    };
  }
  if (!(await isPublicHost(target.hostname, cfg))) {
    return { status: 400, body: { error: "Cette adresse n'est pas accessible publiquement." } };
  }

  let page;
  try {
    page = await fetchPage(target.href);
  } catch (err) {
    console.error("fetch (compare):", err.message);
    return { status: 422, body: { error: friendlyFetchError(err).replace("cette page", "ton site") } };
  }

  const x = extractContent(page.html, target.href);
  if (x.text.length < 20) {
    return { status: 422, body: { error: "Ton site ne contient pas assez de contenu lisible pour une comparaison (rendu 100 % JavaScript ?)." } };
  }

  const userPrompt = [
    `SITE CONCURRENT (déjà analysé) : ${competitor.url}`,
    `RAPPORT DU CONCURRENT :`,
    JSON.stringify(competitor.report).slice(0, 12000),
    ``,
    `SITE DE TON CLIENT : ${target.href}`,
    ...signalsBlock(x),
    ``,
    `CONTENU TEXTE DU SITE DE TON CLIENT :`,
    x.text,
  ].join("\n");

  try {
    const resp = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(90000),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        random_seed: 42,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: COMPARE_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`Mistral ${resp.status}: ${detail.slice(0, 300)}`);
    }
    const data = await resp.json();
    const result = JSON.parse(data.choices[0].message.content);
    if (result.rejet) {
      return { status: 422, body: { error: String(result.rejet).slice(0, 300) } };
    }
    validateCompare(result);
    return {
      status: 200,
      body: { url: target.href, competitorUrl: competitor.url, technologies: x.tech, comparison: result },
    };
  } catch (err) {
    console.error("compare:", err.message);
    return { status: 502, body: { error: "La comparaison a échoué. Réessaie dans un instant." } };
  }
}

function validateCompare(r) {
  const str = (v) => (typeof v === "string" ? v : "");
  r.verdict = str(r.verdict);
  r.ecarts = (Array.isArray(r.ecarts) ? r.ecarts : []).map((e) => ({
    domaine: str(e?.domaine),
    concurrent: str(e?.concurrent),
    toi: str(e?.toi),
    action: str(e?.action),
  }));
  r.a_garder = toStringList(r.a_garder);
  r.priorites = Array.isArray(r.priorites) ? r.priorites : [];
}

module.exports = { analyze, compare };
