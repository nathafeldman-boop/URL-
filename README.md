# Verdict

Reverse engineering de business en ligne. Colle l'URL de n'importe quel site — SaaS, e-commerce, landing page — et comprends pourquoi il vend :

- **le résumé du business** en une phrase
- **d'où vient le trafic** — déduit d'indices réels détectés dans le code (pixels Meta/TikTok, Google Analytics, Klaviyo, réseaux liés…)
- **la technique** — CMS et outils détectés (Shopify, Webflow, Next.js, Stripe…)
- **la stratégie globale** : comment il attire, convertit, fidélise ; positionnement ; mécanisme central
- **l'analyse du site** : proposition de valeur, structure, UX, copywriting, éléments de confiance, CTA
- **l'analyse e-commerce** (si applicable) : offre, pricing, upsells, friction à l'achat
- **ce qui explique son succès** / **ce qui le limite** (format causal : élément → effet)
- **5 éléments à copier** directement, typés (structure, wording, section, stratégie, idée)
- **un plan d'action en 3 étapes** pour ton propre site

Expérience : onboarding animé (~9 s, une seule fois), mode analyse immersif, rapport en cards. Landing marketing et pricing intégrés.

## Lancer en local

Prérequis : Node.js ≥ 18. Aucune dépendance à installer.

```bash
cp .env.example .env   # puis colle ta clé Mistral dans .env
npm start              # → http://localhost:3000
```

La clé se crée sur [console.mistral.ai](https://console.mistral.ai/api-keys). Elle reste côté serveur : le navigateur ne la voit jamais. **Ne commite jamais ton `.env`** (il est déjà dans `.gitignore`).

## Déployer sur Vercel

Le projet est prêt pour Vercel (statique + fonction serverless) :

1. Va sur [vercel.com/new](https://vercel.com/new) et importe le repo GitHub `nathafeldman-boop/URL-`.
2. Laisse les réglages par défaut (framework « Other », aucun build). `vercel.json` configure déjà tout.
3. Dans **Environment Variables**, ajoute `MISTRAL_API_KEY` avec ta clé.
4. Clique **Deploy**. Chaque `git push` redéploiera automatiquement.

## Architecture

```
lib/audit.js       Logique d'audit partagée : fetch de la page cible,
                   extraction des signaux (title, h1/h2, CTA, texte…),
                   appel de l'API Mistral, validation du rapport JSON
lib/access.js      Contrôle d'accès : quota gratuit (cookie signé),
                   jeton Pro anonyme, statut Pro/quota via Supabase
lib/activate.js    Vérifie le paiement auprès de Stripe, délivre le
                   jeton Pro et écrit le statut Pro sur le compte connecté
lib/supabase.js    Client Supabase minimal (appels RPC PostgREST)
lib/billing.js     Portail client Stripe (factures, moyen de paiement,
                   résiliation en libre-service — aucune logique custom)
lib/ratelimit.js   Limite de débit par IP (protège la facture Mistral)
api/analyze.js     Fonction serverless Vercel (POST /api/analyze)
api/compare.js     Fonction serverless Vercel (POST /api/compare)
api/activate.js    Fonction serverless Vercel (POST /api/activate)
api/billing-portal.js  Fonction serverless Vercel (POST /api/billing-portal)
server.js          Serveur de dev local zéro dépendance : statique + API
vercel.json        Config Vercel (public/ en statique, maxDuration 60 s)
public/
  index.html       Landing + rapport + pricing
  app.html          Application (analyse, historique, paywall, compte)
  styles.css       Design system (blanc, accent indigo, ombres légères)
  auth.js          Authentification Supabase (Google, code par email, session, historique)
  app.js           Soumission, états de chargement, rendu du rapport
```

### Config (variables d'environnement)

| Variable | Défaut | Rôle |
|---|---|---|
| `MISTRAL_API_KEY` | — (requis) | Clé API Mistral |
| `MISTRAL_MODEL` | `mistral-large-latest` | Modèle utilisé pour l'audit |
| `STRIPE_SECRET_KEY` | — | Clé secrète Stripe (active les boutons « Passer en Pro ») |
| `STRIPE_PRODUCT_ID` | `prod_UoUCJGRo2tMb6B` | Produit Stripe du plan mensuel (15 €/mois) |
| `STRIPE_PRODUCT_ID_ANNUAL` | `prod_UoV06C0wwwwcmG` | Produit Stripe du plan annuel (100 €/an) |
| `STRIPE_PRICE_ID` | — | Optionnel : ID prix (`price_…`) du plan mensuel, court-circuite la résolution produit |
| `STRIPE_PRICE_ID_ANNUAL` | — | Optionnel : ID prix (`price_…`) du plan annuel |
| `PORT` | `3000` | Port du serveur |
| `APP_SECRET` | — | Secret HMAC dédié (jetons Pro anonymes, cookie de quota, **et** vérification du secret partagé avec la fonction Postgres `apply_pro` — doit être identique à la valeur stockée dans `private.config`). À défaut, la clé Stripe sert de secret pour les jetons/cookies, mais `apply_pro` restera silencieusement inopérant sans elle. |
| `SUPABASE_URL` | `https://fjrkpatehqtkiojpnzja.supabase.co` | Projet Supabase (comptes + quota nominatif + historique) |
| `SUPABASE_ANON_KEY` | (clé publique du projet, en dur) | Clé anon publique, protégée par les politiques RLS côté base |

## Comptes (Supabase)

Un compte n'est pas obligatoire : sans connexion, le quota gratuit (2 analyses, 1 comparaison) vit dans des cookies signés et l'historique dans le navigateur (localStorage). Se connecter (Google, ou email → code à 6 chiffres sans mot de passe ni lien à cliquer) rend le quota **nominatif** — en base, via des fonctions Postgres `security definer` (`quota_status`, `consume_analysis`, `refund_analysis`, `consume_comparison`, `refund_comparison`, `is_pro`, `apply_pro`) — et synchronise l'historique sur tous les appareils (table `analyses`, RLS : chacun ne voit que le sien).

`public/auth.js` gère la session (stockage, rafraîchissement du jeton) et les appels REST directs à Supabase (zéro dépendance) : `requestOtp(email)` / `verifyOtp(email, code)` pour le code par email ; `signInWithGoogle()` / `consumeOAuthRedirect()` pour Google (redirection obligatoire — c'est le protocole OAuth, pas un email, donc pas le problème de lien pré-chargé qui affectait le lien magique). `public/app.js` route les appels vers le compte connecté en priorité, sinon le jeton Pro anonyme, sinon le cookie de quota.

### Gérer son abonnement (portail Stripe)

Un bouton « Gérer mon abonnement » apparaît dans le tiroir historique dès que le statut Pro est actif — connecté ou non (un achat anonyme y donne aussi droit). Il ouvre le [Customer Portal](https://stripe.com/docs/customer-management) de Stripe : factures, moyen de paiement, et résiliation en libre-service, sans qu'aucune logique d'annulation ne soit codée côté Verdict.

`POST /api/billing-portal` résout l'ID client Stripe selon le mode d'accès (fonction `get_billing_info()` pour un compte, sinon lecture de l'abonnement associé au jeton Pro anonyme), puis crée la session de portail.

⚠️ Le **Customer Portal doit être activé au moins une fois** dans Stripe (Dashboard → Settings → Billing → Customer portal → Activate) avant que l'API puisse créer des sessions.

⚠️ **Réglages Supabase uniquement accessibles depuis le dashboard** (aucune API ne les expose, donc à faire manuellement une seule fois) :
1. **Authentication → Emails → Enable custom SMTP** : le service d'email intégré de Supabase est très limité en volume — configure un vrai fournisseur SMTP (Resend, Brevo…) avant d'espérer des envois fiables à volume réel.
2. **Authentication → Email Templates → Magic Link** : par défaut ce template affiche un lien à cliquer. Pour recevoir un code à taper (ce que le front attend), remplace son contenu par un template qui inclut `{{ .Token }}`, par exemple :
   ```html
   <h2>Ton code de connexion Verdict</h2>
   <p>Entre ce code dans l'application : <strong>{{ .Token }}</strong></p>
   <p>Il expire dans quelques minutes.</p>
   ```
3. **Authentication → Sign In / Providers → Google** : nécessite un Client ID + Client Secret créés dans Google Cloud Console (APIs & Services → Credentials), avec comme URI de redirection autorisée `https://<projet>.supabase.co/auth/v1/callback`. Colle les deux valeurs et active le provider.
4. **Authentication → URL Configuration → Redirect URLs** : ajoute l'URL de production de l'app (ex. `https://url-five-black.vercel.app/app`) — sans ça, ni Google ni les liens de secours ne redirigeront correctement après connexion.

## Limites connues (MVP)

- Les sites rendus 100 % en JavaScript côté client renvoient peu de contenu : l'audit est refusé plutôt que d'inventer.
- Gratuit sans compte : 2 analyses et 1 comparaison (compteurs serveur via cookies signés) — effacer ses cookies remet les compteurs à zéro. Gratuit avec compte : quota nominatif en base, ne se réinitialise pas en changeant de navigateur. Pro : illimité, activé par un jeton signé délivré après vérification du paiement auprès de Stripe (`/api/activate`), re-validé à chaque période ; si connecté, le statut Pro est aussi écrit sur le compte.
- L'historique des analyses est en localStorage (20 dernières) hors connexion, synchronisé sur Supabase (20 dernières aussi) une fois connecté.
- Rate limit basique en mémoire (30 requêtes/heure/IP sur `/api/analyze` et `/api/compare`) — protège des scripts naïfs, pas une vraie limite distribuée.
