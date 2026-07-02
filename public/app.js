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
  "Lecture de la page…",
  "Analyse de la proposition de valeur…",
  "Passage au crible du copywriting…",
  "Évaluation du parcours de conversion…",
  "Rédaction de l'audit…",
];

let stepTimer = null;

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
  btn.textContent = "Analyse en cours…";
  loadingDomain.textContent = url.replace(/^https?:\/\//, "").split("/")[0];
  loadingEl.hidden = false;
  let i = 0;
  loadingStep.textContent = LOADING_STEPS[0];
  stepTimer = setInterval(() => {
    i = Math.min(i + 1, LOADING_STEPS.length - 1);
    loadingStep.textContent = LOADING_STEPS[i];
  }, 6000);
  loadingEl.scrollIntoView({ behavior: "smooth", block: "center" });
}

function stopLoading() {
  clearInterval(stepTimer);
  loadingEl.hidden = true;
  btn.disabled = false;
  btn.textContent = "Lancer l'audit";
}

function setError(msg) {
  errorEl.hidden = !msg;
  errorEl.textContent = msg || "";
}

function renderReport({ url, report }) {
  const r = report;

  document.getElementById("r-domain").textContent = new URL(url).hostname;
  document.getElementById("r-resume").textContent = r.resume;
  document.getElementById("r-vp").textContent = r.proposition_valeur;

  for (const key of ["ux", "copywriting", "conversion"]) {
    const val = r.scores[key];
    document.querySelector(`[data-score="${key}"]`).textContent = val;
    const bar = document.querySelector(`[data-bar="${key}"]`);
    bar.style.width = "0";
    requestAnimationFrame(() => (bar.style.width = val * 10 + "%"));
    bar.style.background = val <= 4 ? "var(--bad)" : val <= 6 ? "#d9a13b" : "var(--accent)";
  }

  fillList("r-forts", r.points_forts);
  fillList("r-faibles", r.points_faibles);
  fillDetailList("r-ameliorations", r.ameliorations);
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
      const detail = document.createElement("p");
      detail.textContent = item.detail;
      box.append(title, detail);
      li.append(box);
      return li;
    })
  );
}
