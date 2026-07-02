# Verdict

Reverse engineering de stratégie de site web. Colle l'URL d'un concurrent ou d'un site que tu admires, reçois en ~40 secondes :

- **le résumé du business** en une phrase
- **la stratégie décodée** : acquisition, positionnement, leviers dominants, et le mécanisme qui explique son succès
- **l'analyse du site** élément par élément : proposition de valeur, structure, UX, copywriting, éléments de confiance, CTA
- **ce qui explique son succès** / **ce qui le limite** (format causal : élément → effet)
- **5 éléments à copier** directement — structure, wording, sections, stratégie, idées
- **un plan d'action en 3 étapes** pour appliquer tout ça à ton propre site

Interface prête à vendre : landing marketing, section « comment ça marche », exemple de rapport et pricing intégrés.

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
| `PORT` | `3000` | Port du serveur |

## Limites connues (MVP)

- Les sites rendus 100 % en JavaScript côté client renvoient peu de contenu : l'audit est refusé plutôt que d'inventer.
- Pas encore de comptes, d'historique ni de limite d'usage — la section pricing est un placeholder prêt à brancher.
