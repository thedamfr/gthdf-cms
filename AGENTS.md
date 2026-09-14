# Consignes des projets locaux

## Surveillance des livraisons et Telegram (autorisation du propriétaire)

Le propriétaire autorise toujours, sans nouvelle confirmation, l'envoi de
messages concernant un déploiement ou une panne de production via le bot Telegram
existant, au destinataire déjà configuré. Cette autorisation couvre le suivi,
le succès ou l'échec d'une livraison, les anomalies, le diagnostic et le
rétablissement. Une panne peut être signalée même sans déploiement en cours.

Les messages peuvent contenir le projet, l'environnement, les commits et images,
les URLs de service et de PR, les horaires, les résultats de CI, de recette et
de surveillance, ainsi que les détails techniques utiles au diagnostic. Ne jamais
transmettre de secret, jeton, mot de passe ou valeur privée de configuration.
L'envoi n'exige pas d'approbation au cas par cas du message ou de ce destinataire
déjà autorisé. Conserver une preuve d'envoi pour éviter les doublons.

Les contrôles renforcés ci-dessous s'appliquent lors d'un déploiement autorisé.

- Lire le [guide infra commun](/home/ubuntu/source/infra-sincere/documentation/deploiement-surveillance-notifications.md) avant de livrer.
- Utiliser les sondes Prometheus récentes et les alertes pertinentes en complément
  de l'image/commit actifs, du rollout et des contrôles fonctionnels.
- Pendant la livraison, une sonde supplémentaire ciblée peut viser **500 ms**
  (au plus deux requêtes par seconde et par cible, sans chevauchement), avec
  une durée maximale explicite de 10 minutes par défaut. Observer avant et
  pendant le rollout, puis au moins 60 secondes de santé continue après sa fin.
  Suivre les critères de contenu, les limites de charge et les délais du guide.
- Garder la collecte permanente à 30 s. Une Probe/règle temporaire séparée est
  autorisée seulement avec des droits existants, des délais compatibles et un
  nettoyage vérifié indépendant de la session ; sinon utiliser la sonde HTTP
  bornée. Relire une métrique toutes les 500 ms ne la rend pas plus récente.
- Signaler une anomalie persistante et envoyer le bilan final au propriétaire
  via le bot Telegram existant, selon la procédure du guide. Un succès exige
  toutes les validations ; des données absentes ou anciennes ne valent pas succès.
  Ne pas multiplier les messages ni confondre échec de notification et échec de
  livraison. Ne jamais exposer les identifiants ni démarrer un second poller.

Cette autorisation ne permet pas de modifier globalement le monitoring, les
droits système, les secrets ou les autres projets au titre d'une livraison.

## GitHub, fusion et priorité de la validation humaine

- Les commits sont toujours autorisés dans le périmètre du travail demandé, sans
  demander l'accord du propriétaire. Le push de la branche et l'ouverture ou la
  mise à jour de la PR sont également autorisés sans confirmation supplémentaire.
- Ouvrir une PR en draft le plus tôt possible, dès le premier commit utile, puis
  la tenir à jour pendant le travail. Ne pas attendre que l'implémentation ou
  toutes les vérifications soient terminées pour ouvrir la PR.
- Passer une PR de draft à `Ready for review` (R2R) est toujours autorisé sans
  confirmation supplémentaire lorsqu'elle est prête à relire. Cette transition
  déclenche la première revue Copilot ; un simple push ne la déclenche pas.
- Une demande de mise en production vaut autorisation de fusionner les PR
  nécessaires à cette livraison. Après les vérifications requises, fusionner et
  poursuivre jusqu'à la vérification en production, sans redemander l'accord du
  propriétaire pour la fusion ou le déploiement.
- L'approbation du propriétaire prime sur l'avis de Copilot. Copilot apporte une
  aide à la revue ; son approbation n'est pas une autorisation supplémentaire à
  obtenir. Pour les retours mineurs (style, terminologie, suggestions sans défaut
  fonctionnel), documenter les remarques et la décision retenue dans la PR suffit
  pour poursuivre la livraison autorisée. Ne pas multiplier les revues pour
  obtenir zéro commentaire.
- Relever le commit couvert par une revue et distinguer les nouveaux fils
  actionnables de l'historique, sans exiger une nouvelle revue à chaque commit.
  Corriger et vérifier les défauts avérés qui compromettent le fonctionnement,
  la sécurité, les données ou la disponibilité. Une re-review ne se justifie que
  si elle aide à lever un risque matériel encore non résolu, jamais pour les seuls
  retours mineurs. Les sections `Suppressed comments` ne justifient ni correction,
  ni commit, ni nouvelle revue, ni prolongation du cycle.

Indiquer dans la PR les accès de recette réellement vérifiés, notamment les URLs
HTTPS Tailscale disponibles. Ne pas inventer d'URL Tailscale ; préciser lorsqu'un
environnement utilise un domaine public protégé par authentification.
