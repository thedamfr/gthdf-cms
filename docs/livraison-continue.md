# Livraison continue du CMS GTHF

Version 0.2 — 11 septembre 2026. Statut : **implémentation en revue, activation en attente**.
Le [plan initial du 10 septembre](livraison-continue-initiale-2026-09-10.md) est conservé intégralement.
Le [runbook frontend](https://github.com/thedamfr/gthdf-frontend/pull/33) porte les commandes communes et les preuves d'exploitation.
Les implémentations sont coordonnées dans les PR [frontend #33](https://github.com/thedamfr/gthdf-frontend/pull/33) et [CMS #23](https://github.com/thedamfr/gthdf-cms/pull/23).

## Staging complet du produit

Le namespace `gthdf-qualification` contient un PostgreSQL dédié, une copie éditoriale sans comptes ni secrets de production et les accès de recette propres au CMS. Les 2 720 objets média et les 2 209 références de fichiers ont été copiés et réécrits vers `gthf-staging-media-bis` à Gravelines. La base et les médias persistent séparément de la production.

Sur instruction explicite du propriétaire, l'utilisateur S3 `gthf` est partagé entre les deux buckets GTHF. Les clés S3 ne constituent donc pas une barrière entre staging et production ; les scripts bornent les écritures de recette au seul bucket staging. Les identités PostgreSQL, Strapi et les jetons restent propres à chaque environnement. Le contrôle d'accès au bucket de production avec les nouvelles clés réussit depuis le 11 septembre ; leur installation en production reste à effectuer pendant le rollout préparé.

Les applications et le routage restent à basculer : les domaines staging historiques servent encore la production. Aucun test d'écriture ne doit les utiliser. Les URLs Tailscale de recette seront ajoutées aux PR après mise en service et vérification.

## Implémentation et validations

- `.github/workflows/delivery.yml` : tests et build sur PR, publication par SHA/digest GHCR sur `main`, puis déployeur commun uniquement si `GTHDF_DELIVERY_ENABLED=true`.
- `GET /api/release` : révision effective du processus, absence de cache et requête PostgreSQL ; dépendance indisponible en 503.
- `DATABASE_FORCE_MIGRATION=false` : conservation des tables et colonnes lors du retour arrière ; changements destructifs refusés par le déployeur.
- `.dockerignore` : documentation narrative et tests exclus de l'image ; les scripts et données métier restent des entrées runtime.
- `delivery:storage:check` : contrôle borné création/lecture/suppression en staging, puis accès au bucket de production sans écriture.
- `delivery:staging:prepare` : copie reprenable des médias, réécriture des URLs et comptes de staging, avec garde-fous sur la cible.

Les 254 tests CMS et le build Strapi ont réussi localement. La préparation réelle de la base et des médias a réussi, avec un administrateur, un jeton de lecture et aucun webhook. La publication GHCR, la recette CRUD/preview/upload et la persistance après rollout applicatif restent à valider. Aucune nouvelle image de cette PR n'est annoncée déployée.

## Activation et retour arrière

Fusionner le déployeur frontend avant l'activation du workflow CMS. La connexion privée GitHub Actions → Penthouse exige une identité OIDC Tailscale autorisant les deux dépôts, une clé SSH dédiée et la lecture GHCR côté cluster. Le runbook `infra-sincere` ne fournit pas encore les paramètres GTHF au contrôle du 11 septembre ; son complément est demandé.

La première paire d'images doit être qualifiée dans staging, puis promue avec sauvegarde PostgreSQL et contrôles de disponibilité avant d'enregistrer les références initiales. La livraison automatique refuse leur absence. Les volumes, secrets et données de staging ne sont jamais promus. Le retour arrière conserve les données et réactive la dernière image compatible ; aucune restauration de base n'est automatique.

Les scripts Clever et le seed distant restent des opérations historiques distinctes : voir la [portée des commandes](../README.md#portée-des-commandes-distantes-et-des-migrations).
