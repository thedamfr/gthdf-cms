# GTHF CMS

CMS Strapi du Grand Tour des Hauts-de-France. Ce dépôt porte les schémas
éditoriaux, l’administration, les migrations et les médias consommés par
l’application publique.

## Organisation des dépôts et documentation

Le produit GTHF est réparti entre :

- ce dépôt `gthdf-cms`, source du schéma exécutable Strapi ;
- [`gthdf-frontend`](https://github.com/thedamfr/gthdf-frontend), application
  Next.js qui consomme son contrat de données.

Les PRD transverses ont une source canonique unique dans
[`gthdf-frontend/documentation/`](https://github.com/thedamfr/gthdf-frontend/tree/main/documentation).
Chaque document précise les dépôts d’implémentation concernés, leur ordre de
déploiement et les contraintes de compatibilité. Dans un checkout local où les
deux dépôts sont voisins, ces fichiers se trouvent sous
`../gthdf-frontend/documentation/`.

Ne pas copier les PRD dans ce dépôt : les lier depuis le README, une issue ou
une pull request. Cette centralisation simplifie la revue d’architecture sans
coupler les cycles de livraison ; chaque application reste versionnée et
déployée depuis son propre dépôt, notamment vers `production-clever`.

Documents de référence :

- [PRD 01 — Référentiel des villes et pages hubs](https://github.com/thedamfr/gthdf-frontend/blob/main/documentation/prd_01_referentiel_villes_pages_hubs.md), livré ;
- [PRD 02 — Retrouver son chapitre sur mobile](https://github.com/thedamfr/gthdf-frontend/blob/main/documentation/prd_02_retrouver_chapitre_mobile.md), livré et validé en production ;
- [PRD 03 — GPX Builder v2](https://github.com/thedamfr/gthdf-frontend/blob/main/documentation/prd_03_gpx_builder_fusion_decoupe.md), prêt pour revue ;
- [PRD 04 — Catalogue d’itinéraires ville à ville](https://github.com/thedamfr/gthdf-frontend/blob/main/documentation/prd_04_catalogue_itineraires_ville_a_ville.md), prêt pour revue.

## 🐳 Development Setup

### Prerequisites

- Node.js v24.3.0+
- Docker & Docker Compose

### 1. Start Infrastructure

```bash
docker-compose up -d
```

This starts:
- **PostgreSQL** (port 5432): Database `gthdf`
- **MinIO** (ports 9000/9001): S3-compatible object storage

### 2. Configure Environment

Create `.env` file with:

```env
# Database
DATABASE_NAME=gthdf
DATABASE_USERNAME=gthdf
DATABASE_PASSWORD=gthdf

# MinIO S3 Storage
AWS_ACCESS_KEY_ID=gthdf
AWS_SECRET_ACCESS_KEY=gthdfpassword
AWS_REGION=us-east-1
AWS_BUCKET=gthdf-media
AWS_CDN_URL=http://127.0.0.1:9000/gthdf-media
```

### 3. Create MinIO Bucket

**Important**: Create bucket via AWS SDK (not MinIO CLI) for compatibility:

```bash
node create-bucket.js
```

Set public read policy:

```bash
s3cmd setpolicy minio-policy.json s3://gthdf-media --host=http://127.0.0.1:9000 \
  --host-bucket=http://127.0.0.1:9000/gthdf-media \
  --access_key=gthdf --secret_key=gthdfpassword --no-ssl
```

### 4. Install & Run

```bash
npm install
npm run develop
```

Le CMS et le frontend doivent partager la même valeur longue et aléatoire de
`PREVIEW_SECRET`. Elle protège l’activation du Draft Mode pour les previews
d’article, de chapitre et de ville.

## Migration PRD 01 des villes

Le script de reprise lit par défaut l’export contrôlé
`../gthdf-frontend/documentation/data/gthf_villes_et_produits_seo/csv/villes.csv`.
Il utilise les noms legacy des chapitres pour proposer uniquement les villes
nécessaires ; il n’importe jamais tout le référentiel de 223 villes.

Commencer obligatoirement par le dry-run, qui ne modifie aucune donnée :

```bash
npm run migrate:cities
```

Le rapport détaillé est écrit dans
`.tmp/city-migration-report.json`. Une ville ambiguë ou absente y est associée
au chapitre concerné. Pour résoudre un homonyme, copier
`scripts/city-migration-resolutions.example.json`, renseigner le slug du
chapitre et la `municipalityKey` relue, puis relancer :

```bash
npm run migrate:cities -- --resolutions /chemin/resolutions.json
```

Après revue du rapport, l’application est volontaire :

```bash
npm run migrate:cities -- --resolutions /chemin/resolutions.json --apply
```

Garanties du script :

- `dry-run` par défaut et rapport JSON observable ;
- création de brouillons avec `hasPublicPage=false` uniquement ;
- mise à jour des brouillons de chapitre sans aucune republication ;
- refus d’écraser des `cityPassages` éditoriaux qui diffèrent de la
  proposition legacy ;
- exécution idempotente : un second passage valide reste sans changement.

Les chemins peuvent être remplacés avec `--mapping`, `--resolutions` et
`--report`. `npm run migrate:cities -- --help` documente toutes les options.

### Reprise manuelle en production

Cette reprise n'est jamais lancée au démarrage de Clever Cloud. Strapi crée le
schéma au chargement de la nouvelle version ; le script ci-dessous reprend
ensuite les données, une seule fois et depuis un checkout local où les deux
dépôts sont voisins.

Après déploiement du CMS, mettre `gthdf-frontend` à jour pour disposer du CSV
canonique et renseigner dans le `.env` local du CMS les variables
`POSTGRESQL_ADDON_HOST_REMOTE`, `POSTGRESQL_ADDON_PORT_REMOTE`,
`POSTGRESQL_ADDON_DB_REMOTE`, `POSTGRESQL_ADDON_USER_REMOTE` et
`POSTGRESQL_ADDON_PASSWORD_REMOTE`. Commencer par le dry-run distant :

```bash
npm run migrate:cities:remote -- --resolutions /chemin/resolutions.json
```

Relire le rapport local `.tmp/city-migration-report.json`, notamment les
ambiguïtés, conflits et chapitres bloqués. L'application distante exige ensuite
deux options explicites :

```bash
npm run migrate:cities:remote -- \
  --resolutions /chemin/resolutions.json \
  --apply \
  --confirm-remote
```

Même dans ce mode, seules des villes en brouillon avec `hasPublicPage=false` et
les versions brouillon des chapitres sont écrites. La relecture puis la
publication éditoriale restent manuelles dans Strapi.

### Sélection des villes mises en avant

La sélection éditoriale validée est versionnée dans
`scripts/featured-city-passages.json`. Elle conserve tous les passages de
ville et change uniquement leur booléen `featured`, avec un maximum de six
intermédiaires par chapitre.

Commencer par un dry-run local ou distant :

```bash
npm run migrate:featured-cities
npm run migrate:featured-cities:remote
```

Le rapport `.tmp/featured-city-migration-report.json` expose, pour chaque
chapitre, les clés mises en avant avant et après la migration. Après relecture,
l’application locale ou distante est volontaire :

```bash
npm run migrate:featured-cities -- --apply
npm run migrate:featured-cities:remote -- --apply --confirm-remote
```

Le script est idempotent, ne modifie que les brouillons de chapitre et ne
publie aucun document. Pour revenir en arrière, reconstruire un fichier de
sélection à partir des `beforeFeaturedMunicipalityKeys` du rapport sauvegardé,
puis le passer avec `--selection` après un nouveau dry-run. Une restauration de
la sauvegarde PostgreSQL prise avant application reste le retour arrière
complet.

## Migration PRD 02 de l’ordre public des chapitres

Le champ `displayOrder` fixe l’ordre public de la boucle sans dépendre de
l’ordre de retour de Strapi. Un brouillon peut temporairement ne pas avoir
d’ordre ou partager une valeur avec un autre brouillon. La publication exige
en revanche des entiers positifs, uniques et contigus de `1` au nombre de
chapitres publiés. Dépublier ou supprimer un chapitre d’ordre intermédiaire
est refusé tant que cela créerait un trou ; retirer le dernier ordre conserve
un ensemble valide. Les publications, dépublications et suppressions sont
sérialisées avant validation par un verrou transactionnel global PostgreSQL
(`pg_advisory_xact_lock`, clé stable `0x47544846`, soit `GTHF` en ASCII). Ce
verrou couvre aussi les créations lorsque la table est vide. Les opérations
limitées aux brouillons restent inchangées et ne prennent pas ce verrou.

Le mapping versionné couvre explicitement les dix slugs actuels, de
`lille-a-arras` (`1`) à `st-omer-lille` (`10`). Commencer par le dry-run local :

```bash
npm run migrate:chapter-display-order
```

Le rapport `.tmp/chapter-display-order-migration-report.json` affiche, pour
chaque slug, les valeurs brouillon et publiée avant migration ainsi que la
valeur cible. L’application est volontaire :

```bash
npm run migrate:chapter-display-order -- --apply
```

La commande met à jour dans une seule transaction les versions brouillon et
publiée de chaque document. Elle ne republie aucun chapitre et n’écrit que
`displayOrder`. Elle refuse l’ensemble de l’application si un slug est absent,
inattendu, dupliqué ou s’il manque une des deux versions. Un second passage doit
signaler les dix chapitres comme inchangés.

En production, prendre une sauvegarde PostgreSQL, vérifier que la CLI Clever
est installée et authentifiée, puis exécuter d’abord :

```bash
npm run migrate:chapter-display-order:remote -- --allow-self-signed-tls
```

La commande appelle `clever env --app gthdf-cms --format json`, sélectionne
l’endpoint PostgreSQL externe `DIRECT_*` et conserve les secrets uniquement en
mémoire. Elle ne dépend pas de variables `*_REMOTE` copiées dans `.env`. Une
autre application peut être ciblée explicitement avec
`--clever-app <id-ou-nom>`. La vérification du certificat TLS reste active par
défaut. Clever expose actuellement cet endpoint avec un certificat auto-signé
et sans CA dans les variables de l’add-on : l’exception
`--allow-self-signed-tls` est donc volontaire et visible dans chaque commande
distante, tout en conservant le chiffrement TLS.

Après relecture du rapport et contrôle des dix associations, appliquer avec le
second verrou :

```bash
npm run migrate:chapter-display-order:remote -- \
  --allow-self-signed-tls \
  --apply \
  --confirm-remote
```

Contrôler ensuite que les valeurs publiées vont de `1` à `10` et que les
relations `nextChapter` et `previousChapter` n’ont pas changé. Le rollback
applicatif peut conserver ce champ additif : l’ancien frontend l’ignore. Pour
annuler également les données CMS, restaurer la sauvegarde PostgreSQL prise
avant `--apply`; le script ne modifiant aucun autre champ, aucune reprise de
contenu séparée n’est nécessaire.

### Exécution de production du 5 août 2026

La migration a été appliquée aux dix documents de production, soit vingt
versions brouillon et publiée. Elle a écrit les ordres `1` à `10` sans erreur ;
le dry-run postérieur a classé les dix documents comme inchangés. Les rapports
avant et après application ont été conservés localement sans exposer les
identifiants de la base.

La sauvegarde tentée ce jour-là n’a pas abouti. L’application sans sauvegarde
réussie a fait l’objet d’une autorisation explicite pour cette exécution
précise. Cette exception historique ne change pas le runbook : toute nouvelle
application distante doit être précédée d’une sauvegarde PostgreSQL réussie et
contrôlée.

### Validation locale

Avec PostgreSQL disponible et le schéma chargé, les validations pures et le
smoke test Strapi se lancent ainsi :

```bash
npm test
npm run test:integration:prd01
```

Le smoke test vérifie le refus d'une ville incomplète, l'immutabilité du slug
après publication et le refus d'un chapitre aux passages invalides. Ses
documents QA temporaires sont supprimés avant la fin du test.

### `develop`

Start your Strapi application with autoReload enabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-develop)

```
npm run develop
```

### `start`

Start your Strapi application with autoReload disabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-start)

```
npm run start
# or
yarn start
```

### `build`

Build your admin panel. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-build)

```
npm run build
# or
yarn build
```

## ⚙️ Deployment

Strapi gives you many possible deployment options for your project including [Strapi Cloud](https://cloud.strapi.io). Browse the [deployment section of the documentation](https://docs.strapi.io/dev-docs/deployment) to find the best solution for your use case.

```
yarn strapi deploy
```

## 📚 Learn more

- [Resource center](https://strapi.io/resource-center) - Strapi resource center.
- [Strapi documentation](https://docs.strapi.io) - Official Strapi documentation.
- [Strapi tutorials](https://strapi.io/tutorials) - List of tutorials made by the core team and the community.
- [Strapi blog](https://strapi.io/blog) - Official Strapi blog containing articles made by the Strapi team and the community.
- [Changelog](https://strapi.io/changelog) - Find out about the Strapi product updates, new features and general improvements.

Feel free to check out the [Strapi GitHub repository](https://github.com/strapi/strapi). Your feedback and contributions are welcome!

## ✨ Community

- [Discord](https://discord.strapi.io) - Come chat with the Strapi community including the core team.
- [Forum](https://forum.strapi.io/) - Place to discuss, ask questions and find answers, show your Strapi project and get feedback or just talk with other Community members.
- [Awesome Strapi](https://github.com/strapi/awesome-strapi) - A curated list of awesome things related to Strapi.

---

<sub>🤫 Psst! [Strapi is hiring](https://strapi.io/careers).</sub>

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0-or-later).
See the LICENSE file for the full license text.
