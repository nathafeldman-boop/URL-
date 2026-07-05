/**
 * Verdict — dashboard interne (lecture seule, réservé à l'exploitant).
 * Réutilise les fonctions d'auth.js (session Supabase). Les données brutes
 * (événements + inscriptions des 180 derniers jours) viennent de
 * /api/dashboard-data et sont découpées en heure/jour/semaine/mois ici,
 * côté client, pour éviter des requêtes SQL par période côté serveur.
 */

const dgLogin = document.getElementById("dash-login");
const dgDenied = document.getElementById("dash-denied");
const dgContent = document.getElementById("dash-content");

const dgGoogleBtn = document.getElementById("dg-google-btn");
const dgSigninForm = document.getElementById("dg-signin-form");
const dgSigninEmail = document.getElementById("dg-signin-email");
const dgSigninMsg = document.getElementById("dg-signin-msg");
const dgCodeForm = document.getElementById("dg-code-form");
const dgCodeEmailDisplay = document.getElementById("dg-code-email-display");
const dgSigninCode = document.getElementById("dg-signin-code");
const dgCodeMsg = document.getElementById("dg-code-msg");
const dgSignoutBtn = document.getElementById("dg-signout-btn");

const dgKpis = document.getElementById("dash-kpis");
const dgMetricTabs = document.getElementById("dash-metric-tabs");
const dgRangeTabs = document.getElementById("dash-range-tabs");
const dgChartTotal = document.getElementById("dash-chart-total");
const dgChart = document.getElementById("dash-chart");
const dgUpdated = document.getElementById("dash-updated");

const METRIC_LABELS = {
  analyze: "Analyses",
  compare: "Comparaisons",
  signup: "Inscriptions",
  pro_activated: "Activations Pro",
};

let dgData = null; // { events, signups, total_users, pro_users }
let dgMetric = "analyze";
let dgRange = "hour";

function showSection(section) {
  dgLogin.hidden = section !== "login";
  dgDenied.hidden = section !== "denied";
  dgContent.hidden = section !== "content";
}

/* ---------------------------------------------------------------- auth UI */

dgGoogleBtn?.addEventListener("click", () => signInWithGoogle());

dgSigninForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  dgSigninMsg.hidden = true;
  const email = dgSigninEmail.value.trim();
  if (!email) return;
  try {
    await requestOtp(email);
    dgCodeEmailDisplay.textContent = email;
    dgCodeForm.hidden = false;
    dgSigninCode.focus();
  } catch (err) {
    dgSigninMsg.textContent = err.message;
    dgSigninMsg.hidden = false;
  }
});

dgCodeForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  dgCodeMsg.hidden = true;
  try {
    await verifyOtp(dgSigninEmail.value.trim(), dgSigninCode.value);
    await boot();
  } catch (err) {
    dgCodeMsg.textContent = err.message;
    dgCodeMsg.hidden = false;
  }
});

dgSignoutBtn?.addEventListener("click", async () => {
  await signOut();
  showSection("login");
});

/* --------------------------------------------------------------- données */

async function loadDashboard() {
  const headers = await sbAuthHeaders();
  const resp = await fetch("/api/dashboard-data", { headers });
  if (resp.status === 401 || resp.status === 403) {
    showSection("denied");
    return;
  }
  if (!resp.ok) {
    showSection("denied");
    return;
  }
  dgData = await resp.json();
  showSection("content");
  renderKpis();
  renderChart();
}

function within(ts, days) {
  return Date.now() - new Date(ts).getTime() <= days * 86400000;
}

function renderKpis() {
  const events = dgData.events || [];
  const countType = (type) => events.filter((e) => e.type === type && within(e.created_at, 30)).length;
  const conversion = dgData.total_users ? ((dgData.pro_users / dgData.total_users) * 100).toFixed(1) : "0.0";

  const tiles = [
    { value: dgData.total_users ?? 0, label: "Utilisateurs" },
    { value: dgData.pro_users ?? 0, label: "Pro actifs" },
    { value: `${conversion}%`, label: "Taux de conversion" },
    { value: countType("analyze"), label: "Analyses (30j)" },
    { value: countType("compare"), label: "Comparaisons (30j)" },
    { value: countType("checkout_click"), label: "Clics paiement (30j)" },
    { value: countType("pro_activated"), label: "Activations Pro (30j)" },
  ];

  dgKpis.innerHTML = tiles
    .map((t) => `<div class="dash-kpi"><b>${t.value}</b><span>${t.label}</span></div>`)
    .join("");
}

/* --------------------------------------------------------- découpage temps */

function buildBuckets(range) {
  const now = new Date();
  const buckets = [];

  if (range === "hour") {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    for (let h = 0; h < 24; h++) {
      const start = new Date(dayStart.getTime() + h * 3600000);
      const end = new Date(start.getTime() + 3600000);
      buckets.push({ label: `${h}h`, tooltip: `${h}h–${h + 1}h`, start, end });
    }
  } else if (range === "day") {
    for (let i = 29; i >= 0; i--) {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - i);
      const end = new Date(start.getTime() + 86400000);
      const label = start.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
      buckets.push({ label, tooltip: label, start, end });
    }
  } else if (range === "week") {
    const todayEnd = new Date(now);
    todayEnd.setHours(0, 0, 0, 0);
    todayEnd.setDate(todayEnd.getDate() + 1);
    for (let i = 11; i >= 0; i--) {
      const end = new Date(todayEnd.getTime() - i * 7 * 86400000);
      const start = new Date(end.getTime() - 7 * 86400000);
      const label = start.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
      const tooltip = `${label} – ${new Date(end.getTime() - 86400000).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })}`;
      buckets.push({ label, tooltip, start, end });
    }
  } else if (range === "month") {
    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const label = start.toLocaleDateString("fr-FR", { month: "short" });
      buckets.push({ label, tooltip: start.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }), start, end });
    }
  }

  return buckets;
}

function bucketize(timestamps, range) {
  const buckets = buildBuckets(range);
  const counts = new Array(buckets.length).fill(0);
  for (const ts of timestamps) {
    const t = new Date(ts).getTime();
    for (let i = 0; i < buckets.length; i++) {
      if (t >= buckets[i].start.getTime() && t < buckets[i].end.getTime()) {
        counts[i]++;
        break;
      }
    }
  }
  return buckets.map((b, i) => ({ label: b.label, tooltip: b.tooltip, count: counts[i] }));
}

/* -------------------------------------------------------------- rendu graphique */

function metricTimestamps(metric) {
  if (metric === "signup") return (dgData.signups || []).map((s) => s.created_at);
  return (dgData.events || []).filter((e) => e.type === metric).map((e) => e.created_at);
}

function renderChart() {
  const points = bucketize(metricTimestamps(dgMetric), dgRange);
  const total = points.reduce((sum, p) => sum + p.count, 0);
  const max = Math.max(1, ...points.map((p) => p.count));

  dgChartTotal.textContent = `${total} ${METRIC_LABELS[dgMetric].toLowerCase()}`;

  if (total === 0) {
    dgChart.innerHTML = '<div class="dash-chart-empty">Aucune donnée sur cette période.</div>';
  } else {
    dgChart.innerHTML = points
      .map((p) => {
        const heightPct = Math.max(2, Math.round((p.count / max) * 100));
        const empty = p.count === 0 ? " is-empty" : "";
        return `<div class="dash-bar-col${empty}">
          <div class="dash-tooltip">${p.tooltip} — ${p.count}</div>
          <div class="dash-bar" style="height:${heightPct}%"></div>
        </div>`;
      })
      .join("");
  }

  dgUpdated.textContent = `Mis à jour à ${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
}

dgMetricTabs?.addEventListener("click", (e) => {
  const btn = e.target.closest(".dash-tab");
  if (!btn) return;
  dgMetric = btn.dataset.metric;
  [...dgMetricTabs.children].forEach((c) => c.classList.toggle("is-active", c === btn));
  renderChart();
});

dgRangeTabs?.addEventListener("click", (e) => {
  const btn = e.target.closest(".dash-tab");
  if (!btn) return;
  dgRange = btn.dataset.range;
  [...dgRangeTabs.children].forEach((c) => c.classList.toggle("is-active", c === btn));
  renderChart();
});

/* ------------------------------------------------------------------- boot */

async function boot() {
  if (!isLoggedIn()) {
    showSection("login");
    return;
  }
  await loadDashboard();
}

(async () => {
  await consumeOAuthRedirect();
  await boot();
})();
