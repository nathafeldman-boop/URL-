/* Verdict — logique front : soumission de l'URL, états de chargement, rendu du rapport. */

const form = document.getElementById("analyze-form");
const input = document.getElementById("url-input");
const btn = document.getElementById("analyze-btn");
const errorEl = document.getElementById("form-error");
const loadingEl = document.getElementById("loading");
const loadingStep = document.getElementById("loading-step");
const loadingDomain = document.getElementById("loading-domain");
const reportEl = document.getElementById("report");

const LOADING_STEPS = [
  "Analyse de la structure…",
  "Analyse du copywriting…",
  "Analyse UX…",
  "Détection de stratégie…",
];

const COMPARE_STEPS = [
  "Analyse de ton site…",
  "Comparaison des propositions de valeur…",
  "Comparaison des tunnels de conversion…",
  "Rédaction de tes priorités…",
];

let stepTimer = null;
let progressTimer = null;
// Dernière analyse concurrent, réutilisée par la comparaison.
let lastAnalysis = null;

/* ------------------------------------------------------------ onboarding
   Micro-expérience de bienvenue (~9 s), affichée une seule fois. */
(function onboarding() {
  const root = document.getElementById("onboarding");
  if (localStorage.getItem("verdict_onboarded")) return;

  const slides = [...root.querySelectorAll(".onb-slide")];
  const dots = [...document.getElementById("onb-dots").children];
  const DURATIONS = [2000, 2000, 3000, 2000];
  let timer = null;

  const show = (i) => {
    slides.forEach((s, j) => s.classList.toggle("active", j === i));
    dots.forEach((d, j) => d.classList.toggle("on", j <= i));
    if (i < DURATIONS.length) timer = setTimeout(() => show(i + 1), DURATIONS[i]);
  };

  const close = () => {
    clearTimeout(timer);
    localStorage.setItem("verdict_onboarded", "1");
    root.classList.add("closing");
    setTimeout(() => {
      root.hidden = true;
      input.focus();
    }, 160);
  };

  root.hidden = false;
  show(0);
  document.getElementById("onb-skip").addEventListener("click", close);
  document.getElementById("onb-start").addEventListener("click", close);
})();

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = input.value.trim();
  if (!raw) return;

  setError(null);
  reportEl.hidden = true;
  startLoading(raw);

  try {
    const resp = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: raw }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "L'analyse a échoué. Réessaie.");
    renderReport(data);
  } catch (err) {
    setError(err.message === "Failed to fetch" ? "Connexion au serveur impossible." : err.message);
  } finally {
    stopLoading();
  }
});

document.getElementById("new-audit").addEventListener("click", () => {
  reportEl.hidden = true;
  document.getElementById("compare").hidden = true;
  document.getElementById("app-visual").hidden = false;
  input.value = "";
  input.focus();
  document.getElementById("audit").scrollIntoView({ behavior: "smooth" });
});

/* ----------------------------------------------------------- comparaison */

const compareForm = document.getElementById("compare-form");
const compareInput = document.getElementById("compare-input");
const compareBtn = document.getElementById("compare-btn");
const compareErrorEl = document.getElementById("compare-error");
const compareEl = document.getElementById("compare");

compareForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = compareInput.value.trim();
  if (!raw || !lastAnalysis) return;

  compareErrorEl.hidden = true;
  compareEl.hidden = true;
  compareBtn.disabled = true;
  startLoading(raw, COMPARE_STEPS);

  try {
    const resp = await fetch("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: raw, competitor: { url: lastAnalysis.url, report: lastAnalysis.report } }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "La comparaison a échoué. Réessaie.");
    renderCompare(data);
  } catch (err) {
    compareErrorEl.hidden = false;
    compareErrorEl.textContent = err.message === "Failed to fetch" ? "Connexion au serveur impossible." : err.message;
  } finally {
    stopLoading();
    compareBtn.disabled = false;
  }
});

function renderCompare({ url, competitorUrl, comparison }) {
  const c = comparison;

  document.getElementById("c-domains").textContent =
    new URL(url).hostname + "  vs  " + new URL(competitorUrl).hostname;
  document.getElementById("c-verdict").textContent = c.verdict;

  document.getElementById("c-ecarts").replaceChildren(
    ...c.ecarts.map((gap) => {
      const item = document.createElement("div");
      item.className = "gap";

      const domaine = document.createElement("span");
      domaine.className = "gap-domain chip";
      domaine.textContent = gap.domaine;

      const cols = document.createElement("div");
      cols.className = "gap-cols";
      for (const [label, text] of [["Le concurrent", gap.concurrent], ["Toi", gap.toi]]) {
        const col = document.createElement("div");
        col.className = "fact";
        const lab = document.createElement("span");
        lab.className = "card-label";
        lab.textContent = label;
        const p = document.createElement("p");
        p.textContent = text;
        col.append(lab, p);
        cols.append(col);
      }

      const action = document.createElement("p");
      action.className = "gap-action";
      action.textContent = gap.action;

      item.append(domaine, cols, action);
      return item;
    })
  );

  fillList("c-garder", c.a_garder);

  document.getElementById("c-priorites").replaceChildren(
    ...c.priorites.map((step, i) => {
      const div = document.createElement("div");
      div.className = "plan-step";
      const num = document.createElement("span");
      num.className = "step-num";
      num.textContent = step.etape || i + 1;
      const title = document.createElement("b");
      title.textContent = step.titre;
      const detail = document.createElement("p");
      detail.textContent = step.detail;
      div.append(num, title, detail);
      return div;
    })
  );

  compareEl.hidden = false;
  compareEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function startLoading(url, steps = LOADING_STEPS) {
  btn.disabled = true;
  loadingDomain.textContent = url.replace(/^https?:\/\//, "").split("/")[0];
  loadingEl.hidden = false;

  const checks = [...document.getElementById("analysis-checks").children];
  checks.forEach((c) => c.classList.remove("done"));
  const bar = document.getElementById("analysis-progress");
  bar.style.width = "4%";

  let i = 0;
  loadingStep.textContent = steps[0];
  stepTimer = setInterval(() => {
    if (i < checks.length) checks[i].classList.add("done");
    i = Math.min(i + 1, steps.length - 1);
    loadingStep.textContent = steps[i];
  }, 8000);

  // La barre approche 90 % sans jamais l'atteindre — complétée à la réponse.
  let p = 4;
  progressTimer = setInterval(() => {
    p += (90 - p) * 0.06;
    bar.style.width = p.toFixed(1) + "%";
  }, 600);
}

function stopLoading() {
  clearInterval(stepTimer);
  clearInterval(progressTimer);
  document.getElementById("analysis-progress").style.width = "100%";
  setTimeout(() => (loadingEl.hidden = true), 250);
  btn.disabled = false;
}

function setError(msg) {
  errorEl.hidden = !msg;
  errorEl.textContent = msg || "";
}

function renderReport({ url, technologies, metrics, report }) {
  const r = report;
  lastAnalysis = { url, report };
  document.getElementById("app-visual").hidden = true;

  renderGauges(r.scores);
  renderMetrics(metrics);
  document.getElementById("p-alignement").textContent = r.profil.alignement_strategique;
  document.getElementById("p-cible").textContent = r.profil.cible;
  document.getElementById("p-potentiel").textContent = r.profil.potentiel_croissance;
  renderFunnel(r.funnel);
  renderKeywords(metrics?.mots_cles || []);

  // Réinitialise l'étape comparaison pour ce nouveau concurrent
  document.getElementById("compare").hidden = true;
  document.getElementById("compare-error").hidden = true;
  document.getElementById("compare-input").value = "";
  document.getElementById("cc-domain").textContent = new URL(url).hostname;

  document.getElementById("r-domain").textContent = new URL(url).hostname;
  document.getElementById("r-resume").textContent = r.resume;
  document.getElementById("r-pourquoi").textContent = r.strategie.pourquoi_ca_marche;
  document.getElementById("r-strategie").textContent = r.strategie.globale;
  document.getElementById("r-positionnement").textContent = r.strategie.positionnement;

  fillChips("r-sources", r.trafic.sources);
  document.getElementById("r-trafic").textContent = r.trafic.analyse;
  fillChips("r-tech", technologies?.length ? technologies : ["Rien de notable détecté"]);

  for (const el of document.querySelectorAll("#r-site [data-site]")) {
    el.textContent = r.analyse_site[el.dataset.site] || "—";
  }

  const ecomCard = document.getElementById("r-ecom-card");
  ecomCard.hidden = !r.ecommerce;
  if (r.ecommerce) {
    for (const el of ecomCard.querySelectorAll("[data-ecom]")) {
      el.textContent = r.ecommerce[el.dataset.ecom] || "—";
    }
  }

  fillList("r-forts", r.points_forts);
  fillList("r-faibles", r.points_faibles);
  fillDetailList("r-copier", r.a_copier);

  const plan = document.getElementById("r-plan");
  plan.replaceChildren(
    ...r.plan_action.map((step, i) => {
      const div = document.createElement("div");
      div.className = "plan-step";
      const num = document.createElement("span");
      num.className = "step-num";
      num.textContent = step.etape || i + 1;
      const title = document.createElement("b");
      title.textContent = step.titre;
      const detail = document.createElement("p");
      detail.textContent = step.detail;
      div.append(num, title, detail);
      if (step.impact) {
        const impact = document.createElement("span");
        impact.className = "impact-chip";
        impact.textContent = step.impact;
        impact.title = "Estimation";
        div.append(impact);
      }
      return div;
    })
  );

  reportEl.hidden = false;
  reportEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* --------------------------------------------------------- dashboard */

const SVG_NS = "http://www.w3.org/2000/svg";

function scoreLabel(v) {
  return v >= 80 ? "Excellent" : v >= 60 ? "Bon" : v >= 45 ? "Moyen" : "Faible";
}

function renderGauges(scores) {
  for (const el of document.querySelectorAll(".gauge")) {
    const val = scores[el.dataset.gauge] ?? 0;
    el.querySelectorAll("svg, .gauge-val").forEach((n) => n.remove());

    const main = el.classList.contains("gauge-main");
    const size = main ? 132 : 96;
    const r = main ? 56 : 40;
    const sw = main ? 9 : 7;
    const circ = 2 * Math.PI * r;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    for (const [stroke, offset] of [["var(--border)", 0], ["var(--accent)", circ * (1 - val / 100)]]) {
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", size / 2);
      c.setAttribute("cy", size / 2);
      c.setAttribute("r", r);
      c.setAttribute("fill", "none");
      c.setAttribute("stroke", stroke);
      c.setAttribute("stroke-width", sw);
      if (offset) {
        c.setAttribute("stroke-linecap", "round");
        c.setAttribute("stroke-dasharray", circ);
        c.setAttribute("stroke-dashoffset", offset);
        c.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
      }
      svg.append(c);
    }

    const valEl = document.createElement("div");
    valEl.className = "gauge-val";
    const num = document.createElement("b");
    num.textContent = val;
    const lab = document.createElement("i");
    lab.textContent = scoreLabel(val);
    valEl.append(num, lab);

    el.prepend(svg, valEl);
  }
}

function renderMetrics(m) {
  if (!m) return;
  document.getElementById("m-lecture").textContent = m.temps_lecture || "—";
  document.getElementById("m-lisibilite").textContent = m.lisibilite ? m.lisibilite.score + "/100" : "—";
  document.getElementById("m-lisibilite-niveau").textContent = m.lisibilite?.niveau || "";
  document.getElementById("m-mots").textContent = (m.mots || 0).toLocaleString("fr-FR");
  document.getElementById("m-cta").textContent = m.cta ?? "—";
}

function renderFunnel(steps) {
  document.getElementById("r-funnel").replaceChildren(
    ...(steps || []).map((s) => {
      const row = document.createElement("div");
      row.className = "funnel-step";
      const head = document.createElement("div");
      head.className = "funnel-head";
      const name = document.createElement("span");
      name.textContent = s.etape;
      const val = document.createElement("b");
      val.textContent = s.force + "/100";
      head.append(name, val);
      const bar = document.createElement("div");
      bar.className = "meter";
      const fill = document.createElement("span");
      fill.style.width = s.force + "%";
      bar.append(fill);
      const detail = document.createElement("p");
      detail.textContent = s.detail;
      row.append(head, bar, detail);
      return row;
    })
  );
}

function renderKeywords(words) {
  const max = Math.max(1, ...words.map((w) => w.n));
  document.getElementById("r-keywords").replaceChildren(
    ...words.map((w) => {
      const row = document.createElement("div");
      row.className = "kw-row";
      const name = document.createElement("span");
      name.className = "kw-word";
      name.textContent = w.mot;
      const bar = document.createElement("div");
      bar.className = "meter";
      const fill = document.createElement("span");
      fill.style.width = Math.round((w.n / max) * 100) + "%";
      bar.append(fill);
      const count = document.createElement("b");
      count.textContent = "×" + w.n;
      row.append(name, bar, count);
      return row;
    })
  );
  if (!words.length) {
    document.getElementById("r-keywords").textContent = "Pas assez de texte pour dégager des mots-clés.";
  }
}

function fillChips(id, labels) {
  document.getElementById(id).replaceChildren(
    ...(labels || []).map((label) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = label;
      return chip;
    })
  );
}

function fillList(id, items) {
  const ul = document.getElementById(id);
  ul.replaceChildren(
    ...(items || []).map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    })
  );
}

function fillDetailList(id, items) {
  const ol = document.getElementById(id);
  ol.replaceChildren(
    ...(items || []).map((item) => {
      const li = document.createElement("li");
      const box = document.createElement("div");
      const title = document.createElement("b");
      title.textContent = item.titre;
      if (item.type) {
        const tag = document.createElement("span");
        tag.className = "item-type";
        tag.textContent = item.type;
        title.append(tag);
      }
      const detail = document.createElement("p");
      detail.textContent = item.detail;
      box.append(title, detail);
      li.append(box);
      return li;
    })
  );
}
