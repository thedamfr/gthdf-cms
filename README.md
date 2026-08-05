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
