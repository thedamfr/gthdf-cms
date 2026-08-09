# PRD05 — rôle d’administration DataMaster

**Date :** 9 août 2026

**Statut CMS :** implémenté, recette humaine à deux comptes en cours

**Matrice :** version 2

Ce lot livre uniquement la gouvernance Strapi du PRD05. La carte et le Builder
restent hors de cette pull request et seront traités séparément, dans cet ordre,
après validation du rôle DataMaster.

## Décision

`DataMaster` est un rôle de l’administration Strapi. Il reste distinct des
rôles du plugin Users & Permissions, des tokens API et de l’identité interne
des jobs catalogue. Sa description est :

> Contrôle et qualification des données techniques du catalogue
> d’itinéraires, sans administration générale de Strapi.

La matrice versionnée se trouve dans
`src/domain/datamaster-rbac.ts`. Une permission absente n’est pas accordée.
Le `Super Admin` est détecté par son code Strapi et n’est jamais modifié.
Aucun utilisateur n’est créé, invité ou affecté par le provisionnement.

| Type | Permissions DataMaster | Limites |
|---|---|---|
| `ReferenceRoute` | lire, modifier `name`, `catalogueEnabled`, `notes`, publier | aucune création ou suppression |
| `RouteCity` | lire, modifier `qualificationStatus`, `qualifiedAt`, `reviewNote` | aucune création ou suppression |
| `RouteAnchor` | lire, modifier `validationStatus` | aucune création ou suppression |
| `ItineraryRevision` | lire, modifier les trois champs `warningApproved*` | aucune création ou suppression |
| `CatalogueRun` | lire | aucune mutation |
| `ItinerarySlugRedirect` | lire, créer, modifier et désactiver | aucune suppression physique |
| `Chapter` | lire, modifier uniquement `status` et `reviewNote` sur les ancrages et jonctions GPX imbriqués | aucune création, publication ou suppression ; hashes, métriques, coordonnées et médias sources en lecture seule |
| `CityItinerary` | lire, relier la révision, gérer revue et publication, publier | aucun champ d’identité ou calculé |
| `City` | lire, modifier les cinq champs administratifs PRD04 | aucun autre champ modifiable |
| `Global` | lire, modifier `publishCityItinerariesToNext` | aucun autre champ modifiable |

Les rôles d’administration ordinaires perdent toute permission sur les six
types techniques. Sur `CityItinerary`, ils conservent seulement la lecture et
la modification de `title`, `introduction`, `blocks` et `seo`. Leurs autres
permissions sans rapport sont conservées. Les champs administratifs PRD04 de
`City` et le coupe-circuit catalogue de `Global` leur sont retirés. Sur
`Chapter`, ils conservent leurs permissions éditoriales existantes, mais les
champs `cityPassages.gpxAnchorAB`, `cityPassages.gpxAnchorBA`,
`gpxJunctionAfterAB` et `gpxJunctionAfterBA` leur sont masqués et interdits en
création comme en modification.

Les restrictions d’interface sont complétées par les validations serveur :
les métriques, empreintes, relations calculées, médias et données de run
refusent toute mutation humaine. Seuls les champs de décision explicitement
accordés restent modifiables. Les jobs passent par leur contexte système
interne. Une redirection exige un motif, une cible canonique publiée et un
ancien slug différent de la cible qui n’appartient pas à une autre fiche
publiée.

## Provisionnement

La commande utilise la base configurée pour le processus Strapi courant. Elle
ne recherche pas une cible distante et n’affiche ni email, ni identifiant
personnel, ni secret.

Commencer par le dry-run, qui charge les métadonnées Strapi avec une barrière
PostgreSQL en lecture seule :

```bash
npm run provision:datamaster
```

Le rapport annonce la création ou la mise à jour du rôle, le remplacement de
sa matrice et les rôles éditoriaux à restreindre. Il échoue si un content-type
attendu n’existe pas. Après relecture du rapport sur l’environnement exact :

```bash
npm run provision:datamaster -- --apply --confirm-apply
```

Relancer immédiatement le dry-run. `changesRequired` doit alors valoir
`false`. Une évolution ultérieure de la matrice doit incrémenter
`DATAMASTER_PERMISSION_MATRIX_VERSION`, être testée, puis suivre le même cycle.

### Contrôle local du 9 août 2026

Le provisionnement a été exécuté sur une base PostgreSQL locale vierge et
isolée. Le premier apply a créé DataMaster et restreint les rôles Strapi
`Editor` et `Author`. Le dry-run suivant a annoncé `changesRequired: false`
pour le rôle et les deux matrices éditoriales. La base de test a ensuite été
supprimée. Cette intégration ne remplace ni l’application sur l’environnement
cible, ni la recette humaine ci-dessous.

La première passe de recette humaine a ensuite montré qu’un compte `Editor`
voyait encore les ancrages et jonctions GPX imbriqués dans `Chapter`. La
matrice version 2 les retire des permissions `create`, `read` et `update` des
rôles éditoriaux, et ajoute `Chapter` au DataMaster en lecture et mise à jour
limitée à `status` et `reviewNote`. Sur la base PostgreSQL de recette isolée,
le cycle dry-run, apply puis dry-run s’est terminé avec
`changesRequired: false`. Le même chapitre a été contrôlé avec les deux
profils : les quatre blocs techniques affichent `No permissions` pour Editor ;
DataMaster voit les valeurs calculées en lecture seule et peut modifier
uniquement les deux champs de décision humaine. La recette complète reste en
cours.

L’affectation du rôle reste une opération humaine du `Super Admin`. Ne pas
affecter DataMaster avant la recette ci-dessous. Un compte possédant plusieurs
rôles cumule leurs permissions ; les deux comptes de recette doivent donc
porter uniquement le rôle contrôlé pendant le test.

## Recette humaine à deux comptes

Préparer sur un environnement non productif deux administrateurs sans donnée
personnelle réelle : un contributeur avec son rôle ordinaire et un second avec
le seul rôle `DataMaster`. Utiliser deux sessions de navigateur isolées.

Avec le contributeur :

1. vérifier l’absence de `ReferenceRoute`, `RouteCity`, `RouteAnchor`,
   `ItineraryRevision`, `CatalogueRun` et `ItinerarySlugRedirect` dans le
   Content Manager ;
2. ouvrir directement chaque route de la forme
   `/admin/content-manager/collection-types/<uid>` et vérifier le refus ;
3. vérifier sur `CityItinerary` que seuls `title`, `introduction`, `blocks` et
   `seo` sont lisibles et modifiables ;
4. vérifier que les cinq champs administratifs de `City` et
   `Global.publishCityItinerariesToNext` ne sont pas accessibles ;
5. ouvrir un `Chapter` et vérifier que ses ancrages et jonctions GPX ne sont ni
   visibles ni envoyés par les endpoints du Content Manager.

Avec DataMaster :

1. vérifier la présence des six types techniques et les actions de la matrice ;
2. qualifier une `RouteCity`, décider le `validationStatus` d’une ancre,
   approuver une révision de test et consulter un run ;
3. vérifier l’absence des actions créer/supprimer non prévues ;
4. tenter une requête forgée modifiant une métrique, une empreinte ou un champ
   de run et vérifier le refus serveur ;
5. créer une redirection valide vers une fiche publiée, puis la désactiver sans
   la supprimer ; vérifier le refus d’une cible brouillon et d’une collision ;
6. vérifier l’impossibilité d’atteindre utilisateurs, rôles, tokens, webhooks,
   réglages, configuration des vues et Content-Type Builder ;
7. ouvrir un `Chapter`, vérifier que les ancrages et jonctions GPX sont
   accessibles, que seuls leurs `status` et `reviewNote` sont modifiables, puis
   vérifier que les autres champs restent en lecture seule et que les fichiers
   GPX sources ne peuvent pas être remplacés.

Enfin, comparer les permissions du rôle API public et du token frontend avant
et après la commande : aucun droit ne doit avoir changé. Relancer le dry-run et
conserver le rapport sans dérive avec le compte rendu de recette.

## Retour arrière

Retirer d’abord manuellement toutes les affectations DataMaster. Le rôle peut
rester sans utilisateur ; la commande ne le supprime jamais. Revenir à la
dernière version validée de la matrice puis relancer dry-run et apply. Ne pas
rouvrir les six collections techniques aux contributeurs pour compenser une
erreur de provisionnement.

Les protections serveur sont retirées uniquement avec le commit qui les a
introduites et après vérification que les jobs catalogue restent protégés. Ce
lot ne change ni schéma, ni contenu public : aucun rollback de données métier
n’est nécessaire.
