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
C'est un **écart à corriger** : ce domaine ne permet pas une recette avec
écritures indépendante, malgré son nom.

Aucun workflow GitHub Actions n'est versionné dans ce dépôt. Le `Dockerfile`
construit Strapi sur Node 24 puis copie l'ensemble de `/app` dans l'image
runtime. Le playbook Ansible du frontend applique un overlay Kustomize déjà
présent sur la cible ; il ne construit ni ne transfère les images. Son
redémarrage commun CMS/frontend en cas de modification du Secret ou de
l'overlay doit devenir une activation limitée aux composants concernés.

## Staging complet du produit

La cible de base est **un staging complet GTHF**, isolé de la production et
partagé de façon coordonnée par les agents. Il comprend un CMS Strapi, un
frontend et un PostgreSQL dédiés, avec les extensions et comportements métier
attendus en production. La copie d'un frontend qui lit encore le CMS de
production ou un CMS qui utilise sa base ne remplit pas cette exigence.

Le namespace de recette, ses identités, sa base, ses rôles PostgreSQL, ses PVC
et caches sont distincts de la production historique `gthdf-staging`. Les
médias ont un espace objet et des identifiants dédiés, limités à cet espace,
de préférence un bucket séparé. ConfigMaps, Secrets, clés Strapi, utilisateurs
de recette, jetons API/preview et URLs sont propres au staging. Le frontend
et le CMS de recette utilisent des origines frontend, CMS et média cohérentes,
avec CORS, TLS et authentification fonctionnels. Aucun workload ou test de
staging ne reçoit un droit d'écriture sur la base ou les médias de production.

Un jeu de seeds relu ou une copie ponctuelle maîtrisée des données et médias
alimente la recette, avec anonymisation si nécessaire, réécriture des URLs et
contrôle de la cible d'import. La copie reste à sens unique vers le staging ;
les contenus, volumes et secrets de recette ne sont jamais promus en production.
Les tâches sortantes utilisent une destination de recette appropriée. La
configuration réelle de la base, des uploads et des permissions doit être
vérifiée avant la première opération CRUD. Les éventuelles suppressions de
données/instances suivent un périmètre et une politique explicitement autorisés.

Les agents conservent des checkouts indépendants, puis réservent et identifient
la version du staging partagé pour la séquence déploiement, recette et
démonstration. Le rapport donne la tâche en cours et les digests CMS/frontend.
Un autre agent ou workflow attend avant de remplacer la version présentée ;
le verrou d'activation seul ne protège pas une démonstration après le rollout.
Une instance par PR peut être étudiée ensuite selon la capacité du serveur,
mais n'est pas une exigence du présent plan.

La parité est fonctionnelle : vraies API, administration, base et stockage,
avec un jeu représentatif qualifié pour les parcours GTHF. Il faut pouvoir
se connecter, créer et modifier un brouillon, publier, consulter le résultat
dans Next.js, utiliser la preview protégée, uploader et lire un média, puis
supprimer uniquement les objets de recette créés. Vérifier la persistance
après redémarrage contrôlé des workloads de staging. Les sondes HTTP et un
CMS factice ne démontrent pas ce fonctionnement complet.

## Direction retenue

Chaque push sur `main`, notamment après fusion d'une PR, doit lancer les
validations et la sélection sur **des runners hébergés par GitHub Actions**.
Les changements runtime déclenchent un build du SHA exact, une publication
**GHCR** avec un tag SHA non réaffecté et un digest conservé, puis un déploiement
automatique après validations vertes **et qualification sur le staging complet**.
Les PR exécutent les validations sans publication ni activation de production
et sans secrets de production. Aucun déploiement éphémère par PR n'est imposé.
Une démonstration candidate sur le staging partagé est une opération de
recette coordonnée, construite par GitHub Actions et distincte d'une promotion
de production.

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
dans l'environnement ciblé, avec les empreintes d'entrées et digests conservés.
Le staging et la production conservent chacun leur référence réussie : une
recette de staging ne fait pas avancer l'état de production. Comparer seulement
le dernier commit du push ferait perdre les changements d'une livraison précédemment
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
prend **le verrou GTHF partagé avec le frontend pour cet environnement** côté
déployeur. Les verrous staging et production sont distincts. Pour le staging
partagé, respecter aussi sa réservation de recette/démonstration. Les groupes
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

La promotion doit réutiliser le même digest qualifié sur staging lorsque la
configuration de l'image est portable au runtime. Le Dockerfile CMS attend
déjà les identifiants PostgreSQL, Strapi et S3 au runtime, mais il faut vérifier
aussi les URLs de l'administration construite. Le frontend intègre actuellement
des `NEXT_PUBLIC_*` et des contenus CMS au build : la promotion du même digest
n'est pas encore une propriété démontrée de l'ensemble GTHF. Si des images
staging et production distinctes restent nécessaires, construire les deux du
même SHA avec GitHub Actions, conserver leurs entrées et digests et qualifier
également l'artefact de production dans une recette isolée adaptée. Une recette
d'un autre digest ne suffit pas ; si cette qualification est impossible, la
promotion reste bloquée. Les volumes, données et secrets de staging ne suivent
jamais la promotion d'image.

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

Avant activation en production : tests existants via `npm test`, build Strapi,
contrôle du contrat public et des effets de schéma, puis recette CRUD/médias
complète sur le staging dont l'isolation est prouvée. Fournir l'URL de
démonstration, les conditions d'accès, les versions et les résultats réels.
Les tests d'intégration existants restent sur des services de recette isolés, sans rediriger leurs écritures
vers la production. Les clés PostgreSQL, S3 et Strapi restent hors Git et hors
build ; le `Dockerfile` attend ces secrets uniquement au runtime.

Après activation : rollout CMS terminé, pods prêts, digest exécuté conforme,
PostgreSQL disponible, `/_health`, TLS et routage public valides. Compléter
avec une lecture authentifiée limitée d'un contenu publié connu, son média,
puis la page frontend qui le consomme. Ces contrôles sont en lecture seule ;
les domaines staging historiques partagés ne permettent pas des tests
d'écriture isolés. Les nouveaux tests CRUD appartiennent exclusivement au
staging complet séparé.

Ajouter une preuve de version non sensible du processus effectivement servi,
consultée sans cache, pour relier la réponse publique au SHA et au digest
attendus. Conserver dans le rapport GitHub le SHA `main` traité, le SHA CMS de
l'image, le digest, la révision du déployeur, la version frontend active,
l'heure UTC, les résultats, les durées et le rollback disponible. Mesurer le
temps fusion → production validée et l'écart entre `main` et la dernière
production validée ; un résultat sans changement runtime reste traçable.

## Ordre de réalisation et critères d'acceptation

1. Construire et vérifier le staging complet frontend/CMS/PostgreSQL avec
   stockage, médias, configuration, secrets et données de recette isolés ;
   coordonner sa version et la réservation des démonstrations entre agents.
2. Délimiter les entrées de l'image et versionner la sélection ainsi que son
   état de dernière production saine ; prévoir le cas sans référence initiale.
3. Créer les validations PR/main, le statut final et les builds sur runners
   GitHub, avec publication des releases de production sur GHCR par SHA/digest
   sur `main` seulement.
4. Adapter le déployeur commun Ansible/Kustomize pour une livraison CMS seule,
   le téléchargement GHCR privé, le verrou partagé et le refus d'une version
   dépassée ; qualifier le candidat sur le staging puis promouvoir les artefacts
   automatiquement après validation, en respectant la réservation de recette.
5. Ajouter preuve de version, recette staging complète, contrôles de production
   en lecture seule, rapport et rollback compatible.
6. Vérifier les cas CMS seul, documentation seule, migration bloquante, contrat
   coordonné, absence de référence initiale, push après build échoué, pushes
   CMS/frontend simultanés, ancien workflow retardé et rollback. Vérifier aussi
   le CRUD et les uploads sans effet production, la persistance staging, la
   coordination de deux agents et l'échec de recette bloquant la promotion.

Les commandes actuelles, la cible de chaque migration et les limites du seed
sont détaillées dans le [README](../README.md#portée-des-commandes-distantes-et-des-migrations).
Les conventions GitHub utilisées sont décrites dans la
[syntaxe des workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
la [gestion de concurrence](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
et la [documentation GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Cette évolution n'est pas activée par la présente documentation. Aucun build,
import d'image, migration ou déploiement de production n'a été exécuté pour
cette mise à jour documentaire.
