# Livraison continue du CMS GTHF

Date : 10 septembre 2026. Statut : **direction à implémenter**.
Ce document décrit la livraison propre à `gthdf-cms`. Il ne crée aucun workflow
et ne modifie aucune ressource de production. Le frontend conserve les
manifests et le déployeur GTHF commun ; `infra-sincere` porte les conventions
partagées de la plateforme.

## État de départ

Le CMS de production est `deployment/gthdf-cms`, namespace `gthdf-staging`,
sur `game-prod-ovh-gra`, contexte `microk8s`, accessible via `cms.gthf.fr`.
L'image observée pendant l'audit du 10 septembre est `gthdf-cms:staging` ; le
nom est historique et le tag mutable ne démontre pas son SHA source. Le domaine
`staging-cms.gthf.fr` sert le même CMS et les mêmes données de production.

Aucun workflow GitHub Actions n'est versionné dans ce dépôt. Le `Dockerfile`
construit Strapi sur Node 24 puis copie l'ensemble de `/app` dans l'image
runtime. Le playbook Ansible du frontend applique un overlay Kustomize déjà
présent sur la cible ; il ne construit ni ne transfère les images. Son
redémarrage commun CMS/frontend en cas de modification du Secret ou de
l'overlay doit devenir une activation limitée aux composants concernés.

## Direction retenue

Chaque push sur `main`, notamment après fusion d'une PR, doit lancer les
validations et la sélection sur **des runners hébergés par GitHub Actions**.
Les changements runtime déclenchent un build du SHA exact, une publication
**GHCR** avec un tag SHA non réaffecté et un digest conservé, puis un déploiement
automatique après validations vertes. Les PR exécutent les validations sans
publication ni activation de production et sans secrets de production.

Penthouse télécharge et déploie l'image par digest avec le déployeur GTHF
Ansible/Kustomize à une révision précise. Helm n'est pas requis. La politique
actuelle `imagePullPolicy: Never` et les références locales doivent être
adaptées pour GHCR ; les droits de publication du workflow et de lecture du
cluster restent distincts, limités et privés. La conservation des digests de
retour arrière fait partie de la configuration du registre. Le builder local
OVH est réservé au secours explicitement autorisé, avec les mêmes preuves de
version ; il ne constitue pas le chemin normal de livraison.

La cible est la convergence de la dernière version validée de `main` vers la
production. Une erreur de build ou de compatibilité bloque son activation,
conserve la dernière version saine et signale le décalage. Une recette échouée
après activation marque la livraison en échec et déclenche une reprise
compatible avec la base ; elle ne peut être déclarée réussie sur un HTTP 200.

## Sélection propre au CMS

Comparer le SHA cible à la **dernière livraison réussie et vérifiée** du CMS,
avec les empreintes d'entrées et digests conservés. Comparer seulement le dernier
commit du push ferait perdre les changements d'une livraison précédemment
échouée ou annulée. Sans référence fiable, avec un historique incomplet ou un
fichier non classé, reconstruire prudemment.

| Changement | Traitement attendu |
|---|---|
| `src/`, `config/`, dépendances et lockfile, `Dockerfile`, `.dockerignore`, configuration TypeScript, assets et autres entrées runtime | Tests CMS, contrôle de contrat, build et déploiement CMS |
| Schéma Strapi, contrôleur, permission ou format d'API public | Contrôle de compatibilité avec le frontend actif avant activation ; coordination si le contrat change |
| Script de migration, import catalogue, CSV ou donnée de référence | Classer selon l'usage réel ; revue de migration distincte, aucune écriture métier implicite |
| Tests ou workflows sans effet sur les entrées runtime | Validations concernées, réutilisation du digest existant si l'absence d'effet runtime est prouvée |
| Documentation narrative seule | Contrôles documentaires et résultat explicite sans changement runtime, une fois la frontière de build établie |

Le CMS copie actuellement presque tout le contexte dans l'image finale :
`docs/`, les README, tests et scripts ne sont pas exclus par `.dockerignore`.
Les exclusions et le Dockerfile doivent donc être revus avec les filtres.
Ne pas prétendre qu'un changement documentaire est hors image avant cette
vérification ; ne pas exclure par extension des données ou scripts nécessaires.

Le workflow démarre pour chaque PR et push `main`, puis un job calcule le plan.
Les jobs inutiles peuvent être sautés, mais un statut final stable vérifie que
tous les travaux requis ont réussi. Un job nécessaire annulé ou échoué fait
échouer ce statut. Un push documentaire après un build CMS échoué doit reprendre
les changements runtime en attente, même si son dernier diff n'est que du texte.
Une image réutilisée conserve son SHA source d'origine : le rapport distingue
ce SHA du SHA `main` traité sans reconstruire.

## Déploiement commun et schéma

L'activation vérifie l'identité de l'hôte, le contexte et le namespace, puis
prend **le verrou GTHF partagé avec le frontend** côté déployeur. Les groupes
`concurrency` de deux dépôts GitHub ne se coordonnent pas entre eux. Sous ce
verrou, vérifier que le SHA à activer n'est pas dépassé, relire la version du
frontend en ligne et préserver son digest ainsi que celui de PostgreSQL.
Un vieux workflow ne doit ni remplacer une release plus récente ni remettre
le frontend à une ancienne image depuis un overlay périmé.

Les builds dépassés peuvent être annulés ; une activation déjà commencée doit
terminer proprement son rollout ou sa reprise. Si `main` avance pendant
l'activation, le prochain traitement doit reprendre la tête plus récente.
Une livraison CMS indépendante n'entraîne aucun rebuild systématique du
frontend ou de PostgreSQL.

Strapi peut synchroniser son schéma au démarrage. Privilégier une évolution
additive compatible avec le frontend actif, valider le CMS puis livrer le
frontend qui utilise les nouveaux champs. Une rupture de contrat bloque la
livraison ordinaire tant que l'ordre et la compatibilité ne sont pas établis.
Le build Next lit aussi du contenu CMS : vérifier son contrat et conserver la
révision CMS dans sa provenance. La publication éditoriale ne produit pas un
push Git et relève de la revalidation du frontend, dont la fraîcheur doit être
mesurée séparément de celle des images.

Les migrations métier restent des opérations distinctes avec cible contrôlée,
dry-run, sauvegarde vérifiée et validation des résultats. Une migration
irréversible ou une restauration écrasante exige une instruction spécifique.
Les scripts `:remote` qui appellent `clever env` visent l'hébergement historique ;
ils ne deviennent pas des procédures OVH par leur nom. `seed:remote` est exclu
de la livraison de production. Le rollback réactive le digest précédent si
le schéma est compatible et conserve les champs additifs ; il ne restaure
jamais automatiquement la base.

## Validation et feedback attendu

Avant activation : tests existants via `npm test`, build Strapi, contrôle du
contrat public et des effets de schéma. Les tests d'intégration existants
restent sur des services de recette isolés, sans rediriger leurs écritures
vers la production. Les clés PostgreSQL, S3 et Strapi restent hors Git et hors
build ; le `Dockerfile` attend ces secrets uniquement au runtime.

Après activation : rollout CMS terminé, pods prêts, digest exécuté conforme,
PostgreSQL disponible, `/_health`, TLS et routage public valides. Compléter
avec une lecture authentifiée limitée d'un contenu publié connu, son média,
puis la page frontend qui le consomme. Ces contrôles sont en lecture seule ;
les domaines staging ne permettent pas des tests d'écriture isolés.

Ajouter une preuve de version non sensible du processus effectivement servi,
consultée sans cache, pour relier la réponse publique au SHA et au digest
attendus. Conserver dans le rapport GitHub le SHA `main` traité, le SHA CMS de
l'image, le digest, la révision du déployeur, la version frontend active,
l'heure UTC, les résultats, les durées et le rollback disponible. Mesurer le
temps fusion → production validée et l'écart entre `main` et la dernière
production validée ; un résultat sans changement runtime reste traçable.

## Ordre de réalisation et critères d'acceptation

1. Délimiter les entrées de l'image et versionner la sélection ainsi que son
   état de dernière production saine ; prévoir le cas sans référence initiale.
2. Créer les validations PR/main, le statut final et les builds sur runners
   GitHub, avec publication GHCR par SHA/digest sur `main` seulement.
3. Adapter le déployeur commun Ansible/Kustomize pour une livraison CMS seule,
   le téléchargement GHCR privé, le verrou partagé et le refus d'une version
   dépassée ; déclencher son activation automatiquement après CI verte.
4. Ajouter preuve de version, recette publique, rapport et rollback compatible.
5. Vérifier les cas CMS seul, documentation seule, migration bloquante, contrat
   coordonné, absence de référence initiale, push après build échoué, pushes
   CMS/frontend simultanés, ancien workflow retardé et rollback.

Les commandes actuelles, la cible de chaque migration et les limites du seed
sont détaillées dans le [README](../README.md#portée-des-commandes-distantes-et-des-migrations).
Les conventions GitHub utilisées sont décrites dans la
[syntaxe des workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
la [gestion de concurrence](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
et la [documentation GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Cette évolution n'est pas activée par la présente documentation. Aucun build,
import d'image, migration ou déploiement de production n'a été exécuté pour
cette mise à jour documentaire.
