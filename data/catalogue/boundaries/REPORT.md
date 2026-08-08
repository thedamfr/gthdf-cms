# Rapport de provenance — limites communales PRD04

Date de constitution : **2026-08-07 14:17:30 Europe/Paris**.

## Résultat

- 223 `municipalityKey` attendues et présentes, sans doublon ni clé inattendue ;
- 217 communes françaises et 6 communes belges ;
- 213 `Polygon`, 10 `MultiPolygon`, 88 865 positions WGS84 2D ;
- 223/223 ancres de `villes.csv` situées dans leur géométrie communale ;
- aucun écart de nom entre `villes.csv` et les référentiels courants ;
- fichier final : 1 893 135 octets ;
- SHA-256 : `1bf7045cd3e45376dae6cab0a9dc568b11307153d7e5e752c6507237be99d873`.

Le CSV d’entrée contient 223 lignes et porte le SHA-256
`a3cd1384324ad9b26b9cf8e4e986549b9d9e51451688abf885ff2d173f4cbe0c`.

## France

Les géométries ont été demandées individuellement par code INSEE à l’[API
Découpage administratif — Communes](https://geo.api.gouv.fr/decoupage-administratif/communes),
avec `format=geojson` et `geometry=contour`. Le [jeu de données Contours
administratifs](https://www.data.gouv.fr/datasets/contours-administratifs),
utilisé par cette API, est publié par data.gouv.fr/Etalab sous licence
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

L’API ne renvoie pas le millésime du contour dans la réponse. La date source
opérationnelle est donc la date de récupération ci-dessus ; l’empreinte agrégée
des 217 réponses brutes est
`b756213da7d101e41008aeb960c8701d526b6604f9e1a4334215ec5758df4380`.

## Belgique

Les géométries proviennent d’[AdminVector, couche
`municipality`](https://publish.geo.be/geonetwork/srv/api/records/fb1e2993-2020-428c-9188-eb5f75e284b9),
publié par l’Institut géographique national belge (NGI-IGN). La source est la
[distribution GeoPackage officielle
EPSG:4326](https://ac.ngi.be/remoteclient-open/ngi-standard-open/Vectordata/TerritorialDivisions/TerritorialDivisions-AdminVector/fb1e2993-2020-428c-9188-eb5f75e284b9_geopackage%2Bsqlite3_4326.zip),
révision 2026-07-16, édition 4.1, sous licence [CC BY
4.0](https://creativecommons.org/licenses/by/4.0/).

- archive officielle : 105 371 936 octets, SHA-256
  `22d05f1063530948735b48c484e160cdca034b8934e49395c90ec4f0487f6718` ;
- GeoPackage extrait : 217 972 736 octets, SHA-256
  `e9fea49d739ae91a27df23769247139441cf2d01b2176fcf90c21f29f003345b` ;
- couche source : 565 communes ;
- six lignes retenues par code NIS ; empreinte agrégée des lignes/géométries :
  `2150d59315afd9fcb68085acd77c7437429d3864f32760b4edcd93f69a51c902`.

Attribution à conserver : **National Geographic Institute (NGI-IGN Belgium),
AdminVector**.

## Audit fusions et codes 2025–2026

### Communes françaises sélectionnées

Les 217 codes et noms ont été comparés dans les trois millésimes officiels
Etalab suivants :

- [communes 2024 — GeoJSON 1000 m](https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/2024/geojson/communes-1000m.geojson.gz),
  SHA-256 `9c9cb38bc175b606152bf46e5b0f599aaec6e1f4ef44db800d48bccf1d098a26` ;
- [communes 2025 — GeoJSON 1000 m](https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/2025/geojson/communes-1000m.geojson.gz),
  SHA-256 `289874ba65da667921c38caa34a0fb4a287513a1ec540364b620993a70ea7dfa` ;
- [communes 2026 — GeoJSON 1000 m](https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/2026/geojson/communes-1000m.geojson.gz),
  SHA-256 `2cf7e49db41f8a5603a578ecb8975ad4be236bb89a181c123065fdcbbe698d2c`.

Le référentiel national passe de 35 074 entités en 2024 à 35 014 en 2025
(68 codes retirés, 8 ajoutés), puis reste à 35 014 en 2026. **Aucun des 217
codes PRD04 n’est retiré, ajouté ou renommé entre ces millésimes.**

### Communes belges sélectionnées

La [nomenclature REFNIS
2025](https://statbel.fgov.be/fr/open-data/code-refnis-0) et son [archive TXT
officielle](https://statbel.fgov.be/sites/default/files/files/opendata/REFNIS%20code/TU_COM_REFNIS-20250101.zip)
confirment 565 communes actives au 2025-01-01. L’archive porte le SHA-256
`2b4fd9cce780ca1104495dd7e2c81401991bc035ee41024695ca9e91882ebceb`.
Les six codes suivants sont actifs sans date de fin :

- `33039` Heuvelland ;
- `53039` Hensies ;
- `53068` Quiévrain ;
- `53083` Honnelles ;
- `56051` Momignies ;
- `57097` Comines-Warneton.

Statbel précise que les [secteurs statistiques
2026](https://statbel.fgov.be/fr/open-data/secteurs-statistiques-2026) utilisent
la version 2025 des limites communales. AdminVector révision 2026 contient
toujours ces six codes et 565 communes. **Aucune fusion ni mutation de code
2025–2026 ne touche les six communes PRD04.**

## Normalisation

Le snapshot est un `FeatureCollection` RFC 7946, encodé en UTF-8, sans
indentation, avec un saut de ligne final. Les entités sont triées par
`municipalityKey`. Les coordonnées sont en WGS84, ordre longitude/latitude,
arrondies à six décimales ; les valeurs Z belges sont supprimées, les doublons
consécutifs issus de l’arrondi sont retirés et la fermeture des anneaux est
forcée. Les propriétés ont un ordre fixe : `municipalityKey`, `country`,
`adminCode`, `name`, `sourceName`.
