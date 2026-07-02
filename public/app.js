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

let stepTimer = null;
let progressTimer = null;

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
  input.value = "";
  input.focus();
  document.getElementById("audit").scrollIntoView({ behavior: "smooth" });
});

function startLoading(url) {
  btn.disabled = true;
  loadingDomain.textContent = url.replace(/^https?:\/\//, "").split("/")[0];
  loadingEl.hidden = false;

  const checks = [...document.getElementById("analysis-checks").children];
  checks.forEach((c) => c.classList.remove("done"));
  const bar = document.getElementById("analysis-progress");
  bar.style.width = "4%";

  let i = 0;
  loadingStep.textContent = LOADING_STEPS[0];
  stepTimer = setInterval(() => {
    if (i < checks.length) checks[i].classList.add("done");
    i = Math.min(i + 1, LOADING_STEPS.length - 1);
    loadingStep.textContent = LOADING_STEPS[i];
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

function renderReport({ url, technologies, report }) {
  const r = report;

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
      return div;
    })
  );

  reportEl.hidden = false;
  reportEl.scrollIntoView({ behavior: "smooth", block: "start" });
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
