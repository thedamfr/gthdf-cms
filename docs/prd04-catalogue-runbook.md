# PRD04 — runbook catalogue et recette Tailscale

Toutes les commandes catalogue sont en **dry-run par défaut**. Aucun script ne
publie ni n’active la production implicitement. Une application exige le hash
exact du rapport, l’identité de l’opérateur et, pour une cible distante,
`--remote --confirm-remote`.

## Infrastructure locale isolée

```bash
docker compose -f docker-compose.catalogue.yml up -d --wait --wait-timeout 120 postgres-catalogue minio-catalogue
docker compose -f docker-compose.catalogue.yml run --rm -T --no-deps minio-init-catalogue
docker compose -f docker-compose.catalogue.yml ps
```

Cette stack ne contient pas Strapi et n’utilise aucun nom/volume de la stack
historique : PostgreSQL écoute seulement sur `127.0.0.1:55432`, MinIO sur
`127.0.0.1:59000` et sa console sur `127.0.0.1:59001`.
Avant de continuer, `postgres-catalogue` et `minio-catalogue` doivent être
`healthy`; la commande `minio-init-catalogue` doit terminer avec le code `0`.
L’init séparé évite de lancer la recette avant la création effective du bucket.

Créer `.env` depuis `.env.example`, remplacer tous les secrets factices par des
valeurs locales, puis remplacer `HOST`/`PORT` et ajouter les autres variables
suivantes, sans conserver de définition en double. Ce fichier est ignoré par
Git et chargé explicitement par `catalogue:recipe` :

```dotenv
DATABASE_CLIENT=postgres
DATABASE_HOST=127.0.0.1
DATABASE_PORT=55432
DATABASE_NAME=gthdf_catalogue
DATABASE_USERNAME=gthdf
DATABASE_PASSWORD=gthdf
DATABASE_SSL=false
DATABASE_POOL_MAX=10
AWS_ACCESS_KEY_ID=gthdf
AWS_SECRET_ACCESS_KEY=gthdfpassword
AWS_REGION=us-east-1
AWS_ENDPOINT=http://127.0.0.1:59000
AWS_BUCKET=gthdf-catalogue-media
AWS_CDN_URL=http://127.0.0.1:59000/gthdf-catalogue-media
HOST=127.0.0.1
PORT=1340
```

Sur une base locale vierge, la commande de recette ci-dessous charge Strapi et
matérialise son schéma elle-même. Ne pas laisser en parallèle un autre processus
`npm run develop` sur cette base. Après le seed, démarrer Strapi, créer
l’administrateur local, puis créer depuis l’admin un token API **Read-only**
réservé à Next. Ne jamais réutiliser un token de production.

La migration ci-dessous concerne une base locale existante qui possède encore
les anciennes colonnes `decimal`. Elle exige une vraie sauvegarde préalable et
ne doit pas être lancée sur une base vierge avant la création du schéma :

```bash
npm run migrate:catalogue-schema -- --apply --confirm-apply --backup-reference recette-locale-vierge
```

## Une page synthétique pour la recette

Le seed est idempotent, interdit avec `NODE_ENV=production`, refuse toute URI
DB non loopback et produit une seule page synthétique en `noindex`. Le premier
appel décrit le plan sans créer de contenu fixture (le chargement de Strapi peut
matérialiser son schéma sur une base vierge) :

```bash
npm run catalogue:recipe -- --dry-run
npm run catalogue:recipe -- --apply --confirm-local-recipe
HOST=127.0.0.1 PORT=1340 npm run develop
```

Il crée uniquement dans la base locale les deux villes, dix petits GPX AB
déterministes et leurs chapitres/jonctions exactes, le parcours, les deux ancres
recomposables, les médias immuables, une révision `ready` et l’itinéraire
`ville-recette-a-a-ville-recette-b`. Elle crée aussi, de façon idempotente, la
redirection locale `ancienne-ville-recette-a-a-ville-recette-b` vers ce slug
canonique.

## Exposer seulement via Tailscale

Conserver Strapi sur le loopback dans un premier terminal. Exécuter les
commandes frontend et Tailscale ci-dessous dans un second terminal.

Le frontend doit lui aussi écouter sur le loopback, port 3001, puis être servi :

```bash
PORT=3001 npm run start -- --hostname 127.0.0.1 --port 3001
tailscale serve --bg --https=9443 http://127.0.0.1:3001
tailscale serve status
```

Auditer **toutes** les règles affichées. Toute cible `127.0.0.1:1337`,
`localhost:1337`, `127.0.0.1:1340` ou `localhost:1340` expose Strapi au tailnet
et doit être coupée avant de partager l’URL. Exemples de ports historiques :

```bash
tailscale serve --https=8443 off
tailscale serve --https=9444 off
tailscale serve status
```

Le dernier statut doit conserver `:9443 -> http://127.0.0.1:3001` et ne plus
contenir aucune cible CMS. Ne pas activer Tailscale Funnel.

La recette humaine ouvre ensuite :

```text
https://<nom-machine-tailscale>:9443/itineraires-velo/ville-recette-a-a-ville-recette-b
```

Vérifier la carte, le profil, le téléchargement GPX, les deux villes et le
`noindex`. Ouvrir ensuite l’ancien slug ci-dessous : la réponse doit être une
redirection permanente HTTP `308` et l’adresse finale doit reprendre le slug
canonique.

```text
https://<nom-machine-tailscale>:9443/itineraires-velo/ancienne-ville-recette-a-a-ville-recette-b
```

Après validation, arrêter Tailscale Serve et la stack :

```bash
tailscale serve --https=9443 off
docker compose -f docker-compose.catalogue.yml down
```

`down` conserve les volumes isolés; ne passer `--volumes` que pour supprimer
explicitement la recette locale.

## Vertical contrôlé complet

Le dataset doit être fourni par `CATALOGUE_DATASET_DIR` ou `--dataset`; le
snapshot administratif versionné est `data/catalogue/boundaries/`.

```bash
npm run catalogue:boundaries:check
npm run catalogue:import
npm run catalogue:anchors
npm run catalogue:calculate
npm run catalogue:apply -- --report .tmp/catalogue-calculate-report.json --confirm-hash <sha256> --operator <nom>
```

Le flux de bootstrap sûr reste : parcours publié avec
`catalogueEnabled=false`, propositions d’ancres, validation humaine, calcul et
apply des fingerprints, puis activation éditoriale du parcours et du coupe-
circuit Global. Toute mutation de source ferme immédiatement les pages par
invalidation des hashes, sans recalcul GPX dans le middleware.

## Sauvegarde et rollback de la migration float

Avant `migrate:catalogue-schema --apply`, réaliser un `pg_dump -Fc` et fournir
sa référence avec `--backup-reference`. La migration convertit City latitude/longitude
en `double precision` et vérifie la conservation exacte de valeurs témoins
comme `49.9202` et `4.0841`. En cas d’échec : arrêter Strapi, restaurer le dump
dans une base neuve, repointer l’environnement, puis seulement relancer.
