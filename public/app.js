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

/* ------------------------------------------------------------------- pro
   Le jeton Pro (signé côté serveur après vérification Stripe) vit en
   localStorage. Gratuit : 2 analyses et 1 comparaison (compteurs serveur
   via cookies signés), puis Pro requis. */

const PRO_KEY = "verdict_pro";
const QUOTA_LEFT_KEY = "verdict_quota_restant";
const COMPARE_LEFT_KEY = "verdict_comparaisons_restantes";

/* Événement analytics Vercel (no-op si le script n'est pas chargé). */
function track(name) {
  if (typeof window.va === "function") window.va("event", { name });
}

function getProState() {
  try {
    return JSON.parse(localStorage.getItem(PRO_KEY)) || null;
  } catch {
    return null;
  }
}

/* Jeton Pro anonyme (achat sans compte), distinct du statut Pro d'un compte
   connecté — voir accessState plus bas pour la vue unifiée des deux. */
function hasAnonymousProToken() {
  const p = getProState();
  return !!(p && p.token && p.exp > Date.now());
}

function proHeaders() {
  const p = getProState();
  return hasAnonymousProToken() ? { Authorization: "Bearer " + p.token } : {};
}

/* En-têtes d'authentification pour /api/analyze et /api/compare : priorité
   à la session Supabase (compte), sinon au jeton Pro anonyme éventuel. */
async function authHeaders() {
  if (isLoggedIn()) return sbAuthHeaders();
  return proHeaders();
}

async function activatePro(payload) {
  const headers = { "Content-Type": "application/json" };
  const loggedIn = isLoggedIn();
  if (loggedIn) Object.assign(headers, await sbAuthHeaders());
  const resp = await fetch("/api/activate", { method: "POST", headers, body: JSON.stringify(payload) });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "Activation impossible. Réessaie ou contacte-nous.");
  // Le jeton anonyme n'est conservé que hors connexion : pour un compte, le
  // statut Pro vit en base (apply_pro) — le garder ici survivrait à la
  // déconnexion et laisserait l'accès Pro fuiter sur un appareil partagé.
  if (!loggedIn) localStorage.setItem(PRO_KEY, JSON.stringify(data));
  return data;
}

const paywall = document.getElementById("paywall");

function openPaywall(reason) {
  document.getElementById("paywall-reason").textContent = reason;
  paywall.hidden = false;
  track("paywall_affiche");
}

for (const plan of paywall.querySelectorAll(".paywall-plan")) {
  plan.addEventListener("click", () => track("checkout_clique"));
}

document.getElementById("paywall-close").addEventListener("click", () => (paywall.hidden = true));
paywall.addEventListener("click", (e) => {
  if (e.target === paywall) paywall.hidden = true;
});
document.getElementById("compare-unlock").addEventListener("click", () =>
  openPaywall("Tu as utilisé ta comparaison gratuite. Passe en Pro pour comparer en illimité avec ton site.")
);

/* État d'accès unifié : compte Supabase (quota nominatif en base) en
   priorité, sinon jeton Pro anonyme, sinon quota gratuit par cookie.
   compareRemaining : null = pas encore tenté (1 comparaison gratuite
   supposée disponible), sinon le compte exact renvoyé par le serveur. */
let accessState = { mode: "cookie", pro: false, remaining: null, compareRemaining: null, email: null, proUntil: null };

async function refreshAccessState() {
  if (isLoggedIn()) {
    const q = await fetchQuotaStatus();
    if (q) {
      accessState = {
        mode: "supabase",
        pro: !!q.pro,
        remaining: q.remaining,
        compareRemaining: q.comparisons_remaining,
        email: getSbSession()?.user?.email || null,
        proUntil: q.pro_until || null,
      };
    } else {
      // Session invalide/expirée et non rafraîchissable.
      accessState = { mode: "cookie", pro: hasAnonymousProToken(), remaining: null, compareRemaining: null, email: null, proUntil: getProState()?.exp || null };
    }
  } else if (hasAnonymousProToken()) {
    accessState = { mode: "token", pro: true, remaining: null, compareRemaining: null, email: null, proUntil: getProState()?.exp || null };
  } else {
    const raw = localStorage.getItem(QUOTA_LEFT_KEY);
    const cmpRaw = localStorage.getItem(COMPARE_LEFT_KEY);
    accessState = {
      mode: "cookie",
      pro: false,
      remaining: raw === null ? null : Number(raw),
      compareRemaining: cmpRaw === null ? null : Number(cmpRaw),
      email: null,
      proUntil: null,
    };
  }
  renderAccessState();
  renderAccountUI();
}

function renderAccessState() {
  const { pro, remaining, compareRemaining } = accessState;
  document.getElementById("pro-badge").hidden = !pro;

  const note = document.getElementById("quota-note");
  if (pro) {
    note.textContent = "Analyses illimitées avec ton plan Pro. Résultats en ~40 secondes.";
  } else {
    note.textContent =
      remaining === null
        ? "2 analyses gratuites. Résultats en ~40 secondes."
        : remaining <= 0
          ? "Analyses gratuites épuisées — passe en Pro pour continuer en illimité."
          : `Il te reste ${remaining} analyse${remaining > 1 ? "s" : ""} gratuite${remaining > 1 ? "s" : ""}. Résultats en ~40 secondes.`;
  }

  const cmpLeft = compareRemaining === null ? 1 : compareRemaining;
  const compareLocked = !pro && cmpLeft <= 0;
  document.getElementById("compare-form").hidden = compareLocked;
  document.getElementById("compare-lock").hidden = !compareLocked;
  const compareNote = document.getElementById("compare-note");
  compareNote.hidden = pro || compareLocked;
  if (!pro && !compareLocked) {
    compareNote.textContent = "1 comparaison gratuite avec ton site — la suivante nécessite le plan Pro.";
  }
}

function renderAccountUI() {
  const signedIn = isLoggedIn() && accessState.email;
  document.getElementById("google-btn").hidden = signedIn;
  document.getElementById("account-divider").hidden = signedIn;
  document.getElementById("signin-form").hidden = signedIn;
  // Le formulaire de code n'est réaffiché qu'explicitement après l'envoi
  // d'un code (cf. plus bas) — jamais par cette fonction, pour ne pas
  // effacer une saisie en cours quand le statut d'accès se rafraîchit.
  document.getElementById("code-form").hidden = true;
  document.getElementById("account-signed-in").hidden = !signedIn;
  if (signedIn) {
    document.getElementById("account-email").textContent = accessState.email;
    const planEl = document.getElementById("account-plan");
    planEl.textContent = accessState.pro ? "Pro" : "Gratuit";
    planEl.classList.toggle("is-pro", accessState.pro);
  }

  // Accès au portail Stripe : visible dès qu'on est Pro, connecté ou non
  // (un achat anonyme donne aussi droit à gérer son abonnement) — sauf pour
  // le jeton propriétaire, qui n'a aucun abonnement Stripe à gérer.
  const isOwnerToken = accessState.mode === "token" && getProState()?.sub === "owner-gratuit";
  document.getElementById("billing-block").hidden = !accessState.pro || isOwnerToken;
  if (accessState.pro && !isOwnerToken) {
    const renewal = document.getElementById("billing-renewal");
    renewal.textContent = accessState.proUntil
      ? "Renouvellement le " + new Date(accessState.proUntil).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })
      : "";
  }
}

(async function initAccess() {
  await consumeOAuthRedirect();

  const params = new URLSearchParams(location.search);
  const oauthError = params.get("error_description");
  if (oauthError) {
    history.replaceState(null, "", "/app");
    setError(decodeURIComponent(oauthError.replace(/\+/g, " ")));
  }

  const sessionId = params.get("session_id");
  const ownerSecret = params.get("owner_token");
  if (sessionId) {
    history.replaceState(null, "", "/app");
    try {
      await activatePro({ session_id: sessionId });
      track("pro_active");
      const toast = document.getElementById("pro-toast");
      toast.hidden = false;
      setTimeout(() => (toast.hidden = true), 6000);
    } catch (err) {
      setError(err.message);
    }
  } else if (ownerSecret) {
    // Activation propriétaire : jeton Pro permanent, sans abonnement Stripe
    // réel — voir lib/owner.js. Le lien n'est jamais affiché dans l'UI.
    history.replaceState(null, "", "/app");
    try {
      const resp = await fetch("/api/owner-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: ownerSecret }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Jeton invalide.");
      localStorage.setItem(PRO_KEY, JSON.stringify(data));
    } catch (err) {
      setError(err.message);
    }
  } else if (!isLoggedIn()) {
    // Jeton anonyme expiré mais abonnement connu → re-vérification silencieuse auprès de Stripe.
    // (un jeton propriétaire n'expire pas avant 100 ans, donc jamais concerné ici)
    const p = getProState();
    if (p && /^sub_/.test(p.sub || "") && p.exp <= Date.now()) {
      try {
        await activatePro({ subscription: p.sub });
      } catch {
        localStorage.removeItem(PRO_KEY);
      }
    }
  }

  // Achat fait avant la création d'un compte : on le relie au compte
  // maintenant connecté (apply_pro avec le jeton Supabase), puis on efface
  // le jeton anonyme local — le statut Pro vit désormais en base. Un jeton
  // propriétaire (sub non-Stripe) n'a rien à lier : on le laisse tel quel.
  if (isLoggedIn()) {
    const p = getProState();
    if (p && /^sub_/.test(p.sub || "")) {
      try {
        await activatePro({ subscription: p.sub });
      } catch {
        /* abonnement expiré ou déjà lié : rien à faire */
      } finally {
        localStorage.removeItem(PRO_KEY);
      }
    }
  }

  await refreshAccessState();
})();

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
  track("analyse_lancee");

  try {
    const resp = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ url: raw }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (data.code === "quota_epuise") {
        accessState.remaining = 0;
        if (accessState.mode === "cookie") localStorage.setItem(QUOTA_LEFT_KEY, "0");
        renderAccessState();
        openPaywall(data.error);
        return;
      }
      throw new Error(data.error || "L'analyse a échoué. Réessaie.");
    }
    if (typeof data.quota_restant === "number") {
      accessState.remaining = data.quota_restant;
      if (accessState.mode === "cookie") localStorage.setItem(QUOTA_LEFT_KEY, String(data.quota_restant));
      renderAccessState();
    }
    if (accessState.mode === "supabase") {
      insertRemoteHistory(data);
    } else {
      addToHistory(data);
    }
    renderReport(data);
    track("rapport_affiche");
  } catch (err) {
    setError(err.message === "Failed to fetch" ? "Connexion au serveur impossible." : err.message);
  } finally {
    stopLoading();
  }
});

function resetToInput() {
  reportEl.hidden = true;
  document.getElementById("compare").hidden = true;
  document.getElementById("app-visual").hidden = false;
  document.body.classList.remove("report-view");
  input.value = "";
  input.focus();
  document.getElementById("audit").scrollIntoView({ behavior: "smooth" });
}

document.getElementById("new-audit").addEventListener("click", resetToInput);
for (const btnRelaunch of document.querySelectorAll(".relaunch-btn")) {
  btnRelaunch.addEventListener("click", resetToInput);
}

/* ------------------------------------------------------------ historique
   Les analyses sont conservées en localStorage (20 max) et rejouables
   depuis le panneau ouvert par le bouton ☰ en haut à droite. */

const HISTORY_KEY = "verdict_history";
const HISTORY_MAX = 20;

const drawer = document.getElementById("history-drawer");
const drawerOverlay = document.getElementById("history-overlay");
const historyToggle = document.getElementById("history-toggle");
const historyList = document.getElementById("history-list");
const historyEmpty = document.getElementById("history-empty");
const historyClear = document.getElementById("history-clear");

function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    /* stockage plein ou indisponible : l'app fonctionne sans historique */
  }
}

function addToHistory(data) {
  const list = loadHistory().filter((e) => e.url !== data.url);
  list.unshift({
    id: Date.now(),
    date: new Date().toISOString(),
    url: data.url,
    technologies: data.technologies,
    metrics: data.metrics,
    report: data.report,
  });
  saveHistory(list.slice(0, HISTORY_MAX));
  renderHistory();
}

async function removeFromHistory(id) {
  if (accessState.mode === "supabase") {
    await deleteRemoteHistory(id);
    return renderHistory();
  }
  saveHistory(loadHistory().filter((e) => e.id !== id));
  renderHistory();
}

/* Normalise une ligne Supabase (id, created_at) vers le même format que
   les entrées locales (id, date) pour un rendu partagé. */
function normalizeRemoteEntry(row) {
  return { id: row.id, date: row.created_at, url: row.url, report: row.report, technologies: row.technologies, metrics: row.metrics };
}

async function renderHistory() {
  const list = accessState.mode === "supabase" ? (await fetchRemoteHistory())?.map(normalizeRemoteEntry) || [] : loadHistory();

  historyEmpty.hidden = list.length > 0;
  historyClear.hidden = list.length === 0;

  historyList.replaceChildren(
    ...list.map((entry) => {
      const li = document.createElement("li");
      li.className = "history-item";

      const open = document.createElement("button");
      open.type = "button";
      open.className = "history-open";

      const domain = document.createElement("b");
      domain.textContent = new URL(entry.url).hostname;
      const meta = document.createElement("span");
      const score = entry.report?.scores?.global;
      meta.textContent =
        new Date(entry.date).toLocaleDateString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) +
        (typeof score === "number" ? ` · ${score}/100` : "");
      open.append(domain, meta);
      open.addEventListener("click", () => {
        closeDrawer();
        renderReport(entry);
        window.scrollTo({ top: 0 });
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "history-del";
      del.setAttribute("aria-label", "Supprimer cette analyse");
      del.textContent = "×";
      del.addEventListener("click", () => removeFromHistory(entry.id));

      li.append(open, del);
      return li;
    })
  );
}

function openDrawer() {
  renderHistory();
  drawer.classList.add("open");
  drawerOverlay.hidden = false;
  historyToggle.setAttribute("aria-expanded", "true");
}

function closeDrawer() {
  drawer.classList.remove("open");
  drawerOverlay.hidden = true;
  historyToggle.setAttribute("aria-expanded", "false");
}

historyToggle.addEventListener("click", () => {
  drawer.classList.contains("open") ? closeDrawer() : openDrawer();
});
document.getElementById("history-close").addEventListener("click", closeDrawer);
drawerOverlay.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeDrawer();
    paywall.hidden = true;
  }
});
historyClear.addEventListener("click", async () => {
  if (accessState.mode === "supabase") {
    await clearRemoteHistory();
  } else {
    saveHistory([]);
  }
  renderHistory();
});

/* ------------------------------------------------------------------ compte
   Connexion en deux étapes : email → code à 6 chiffres reçu par email
   (pas de lien à cliquer — plus fiable, et rien à faire pendant un
   paiement Stripe dans le même onglet). */

const signinForm = document.getElementById("signin-form");
const signinMsg = document.getElementById("signin-msg");
const codeForm = document.getElementById("code-form");
const codeMsg = document.getElementById("code-msg");
let pendingEmail = null;

signinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("signin-email").value.trim();
  if (!email) return;
  const btnSignin = document.getElementById("signin-btn");
  btnSignin.disabled = true;
  signinMsg.hidden = false;
  signinMsg.className = "account-msg";
  signinMsg.textContent = "Envoi du code…";
  try {
    await requestOtp(email);
    pendingEmail = email;
    document.getElementById("code-email-display").textContent = email;
    document.getElementById("signin-code").value = "";
    codeMsg.hidden = true;
    signinForm.hidden = true;
    codeForm.hidden = false;
    document.getElementById("signin-code").focus();
    track("code_envoye");
  } catch (err) {
    signinMsg.className = "account-msg is-error";
    signinMsg.textContent = err.message;
  } finally {
    btnSignin.disabled = false;
  }
});

codeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = document.getElementById("signin-code").value.trim();
  if (!code || !pendingEmail) return;
  const btnCode = document.getElementById("code-btn");
  btnCode.disabled = true;
  codeMsg.hidden = true;
  try {
    await verifyOtp(pendingEmail, code);
    track("connexion_reussie");
    signinMsg.hidden = true;
    signinForm.reset();
    await refreshAccessState();
    renderHistory();
  } catch (err) {
    codeMsg.hidden = false;
    codeMsg.className = "account-msg is-error";
    codeMsg.textContent = err.message;
  } finally {
    btnCode.disabled = false;
  }
});

document.getElementById("google-btn").addEventListener("click", () => {
  track("google_signin_clique");
  signInWithGoogle();
});

document.getElementById("code-back").addEventListener("click", () => {
  pendingEmail = null;
  codeForm.hidden = true;
  codeForm.reset();
  codeMsg.hidden = true;
  signinForm.hidden = false;
});

document.getElementById("signout-btn").addEventListener("click", async () => {
  await signOut();
  await refreshAccessState();
  renderHistory();
});

document.getElementById("billing-btn").addEventListener("click", async () => {
  const btn = document.getElementById("billing-btn");
  btn.disabled = true;
  try {
    const resp = await fetch("/api/billing-portal", { method: "POST", headers: await authHeaders() });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Impossible d'ouvrir ton espace abonnement. Réessaie dans un instant.");
    track("portail_stripe_ouvert");
    location.href = data.url;
  } catch (err) {
    setError(err.message === "Failed to fetch" ? "Connexion au serveur impossible." : err.message);
    btn.disabled = false;
  }
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
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ url: raw, competitor: { url: lastAnalysis.url, report: lastAnalysis.report } }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (data.code === "pro_requis") {
        accessState.compareRemaining = 0;
        if (accessState.mode === "cookie") localStorage.setItem(COMPARE_LEFT_KEY, "0");
        renderAccessState();
        openPaywall(data.error);
        return;
      }
      throw new Error(data.error || "La comparaison a échoué. Réessaie.");
    }
    if (typeof data.comparaisons_restantes === "number") {
      accessState.compareRemaining = data.comparaisons_restantes;
      if (accessState.mode === "cookie") localStorage.setItem(COMPARE_LEFT_KEY, String(data.comparaisons_restantes));
      renderAccessState();
    }
    renderCompare(data);
    track("comparaison_affichee");
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
  document.body.classList.add("report-view");

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
  document.getElementById("r-type").textContent = r.type_site || "—";
  document.getElementById("r-modele").textContent = r.modele_economique || "—";
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

