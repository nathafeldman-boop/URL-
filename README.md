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
api/analyze.js     Fonction serverless Vercel (POST /api/analyze)
server.js          Serveur de dev local zéro dépendance : statique + API
vercel.json        Config Vercel (public/ en statique, maxDuration 60 s)
public/
  index.html       Landing + rapport + pricing
  styles.css       Design system (blanc, accent indigo, ombres légères)
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

## Limites connues (MVP)

- Les sites rendus 100 % en JavaScript côté client renvoient peu de contenu : l'audit est refusé plutôt que d'inventer.
- Gratuit : 2 analyses (compteur serveur via cookie signé) et 0 comparaison. Pro : illimité, activé par un jeton signé délivré après vérification du paiement auprès de Stripe (`/api/activate`), re-validé à chaque période. Sans base de données, effacer ses cookies remet le compteur gratuit à zéro — le passage en base rendra le quota nominatif.
- L'historique des analyses est conservé en localStorage (20 dernières, par navigateur).
- `APP_SECRET` (optionnel) : secret HMAC dédié pour signer jetons et cookies ; à défaut la clé Stripe sert de secret.
