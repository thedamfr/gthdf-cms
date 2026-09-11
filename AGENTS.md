# Consignes des projets locaux

## Surveillance des livraisons et Telegram (autorisation du propriétaire)

Le propriétaire autorise, depuis le 11 septembre 2026, les contrôles renforcés
et les notifications ci-dessous lors d'un déploiement déjà autorisé. Cette
consigne complète les règles propres au projet ; elle n'autorise ni publication
ni déploiement supplémentaire.

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

## GitHub et revue des changements

Le propriétaire autorise les commits, le push de branches et l'ouverture de
pull requests nécessaires au travail demandé, sans confirmation supplémentaire.
Ouvrir une PR en draft pendant la préparation, puis la passer en Ready for review
lorsque les vérifications adaptées ont réussi. L'autorisation de fusion ou de
mise en production dépend des instructions de la tâche en cours.

Indiquer dans la PR les accès de recette réellement vérifiés, notamment les URLs
HTTPS Tailscale disponibles. Ne pas inventer d'URL Tailscale ; préciser lorsqu'un
environnement utilise un domaine public protégé par authentification.
