# PRD04 — snapshot des limites communales

Ce répertoire contient un snapshot GeoJSON WGS84 déterministe pour les 223
`municipalityKey` de `villes.csv` : 217 communes françaises et 6 communes
belges.

## Fichiers

- `municipalities.wgs84.geojson` : snapshot compact RFC 7946, trié par
  `municipalityKey` ;
- `manifest.json` : sources, licences, date de récupération, SHA-256,
  normalisation et comptages ;
- `generate_boundaries.py` : générateur sans dépendance Python externe ;
- `check_snapshot.py` : contrôle hors ligne de l’intégrité, de la couverture,
  du schéma, des géométries et des ancres ;
- `REPORT.md` : rapport de provenance et audit des changements 2025–2026.

## Vérification hors ligne

Le contrôle standard est autonome : il lit uniquement le snapshot et son
manifeste versionnés dans ce dépôt.

```sh
npm run catalogue:boundaries:check
```

Résultat attendu :

```text
OK: 223 municipality keys (217 FR, 6 BE), 88865 WGS84 coordinates, sha256=1bf7045cd3e45376dae6cab0a9dc568b11307153d7e5e752c6507237be99d873 (snapshot-only; pass --csv to check dataset coverage and anchors)
```

Pour contrôler en plus l'empreinte du dataset source, sa couverture exacte et
la position de ses 223 ancres, fournir explicitement le CSV contrôlé :

```sh
python3 data/catalogue/boundaries/check_snapshot.py \
  --csv /chemin/vers/villes.csv
```

## Régénération

Le générateur interroge `geo.api.gouv.fr` une fois par code INSEE. Pour la
Belgique, il télécharge l’archive nationale AdminVector WGS84 (environ 105 Mo)
dans un répertoire temporaire, puis n’en conserve que les six codes NIS.

```sh
python3 generate_boundaries.py \
  --csv /chemin/vers/villes.csv \
  --snapshot-date 2026-08-07T14:17:30+02:00
```

Pour éviter de retélécharger AdminVector, fournir l’archive officielle ou son
GeoPackage déjà extrait :

```sh
python3 generate_boundaries.py \
  --csv /chemin/vers/villes.csv \
  --belgium-source /chemin/adminvector_4326.zip
```

Le fichier GeoJSON est déterministe pour des réponses sources identiques. La
date de récupération et les empreintes agrégées dans le manifeste rendent toute
dérive amont visible.
