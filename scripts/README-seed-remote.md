# Seed Remote Database

Script pour seeder une base PostgreSQL distante (production) avec les données d'exemple.

## Prérequis

- Accès à la base de données distante (credentials Clever Cloud)
- Variables d'environnement locales configurées (APP_KEYS, JWT_SECRET, etc.)
- Fichiers de seed dans `data/data.json` et `data/uploads/`

## Usage

### 1. Configurer les variables d'environnement

```bash
export DATABASE_HOST_REMOTE="your-postgres-host.clever-cloud.com"
export DATABASE_PORT_REMOTE="5432"
export DATABASE_NAME_REMOTE="your_database_name"
export DATABASE_USERNAME_REMOTE="your_username"
export DATABASE_PASSWORD_REMOTE="your_password"

# Optionnel: S3/MinIO distant (si différent du local)
export AWS_ENDPOINT_REMOTE="https://your-s3-endpoint.com"
export AWS_CDN_URL_REMOTE="https://cdn.your-domain.com/media"
```

### 2. Lancer le script

```bash
./scripts/seed-remote.sh
```

## Ce que fait le script

1. **Vérifie** que les variables d'environnement requises sont définies
2. **Sauvegarde** votre `.env` local dans `.env.backup`
3. **Crée** un `.env` temporaire avec la config de la base distante
4. **Exécute** `node scripts/seed.js` contre la base distante
5. **Restaure** votre `.env` local original
6. **Nettoie** les fichiers temporaires

## Sécurité

- Le script utilise `DATABASE_SSL=true` pour les connexions distantes
- Votre `.env` local est automatiquement restauré même en cas d'erreur
- Les fichiers temporaires sont supprimés après succès

## Variables d'environnement requises

### Base de données distante
- `DATABASE_HOST_REMOTE` - Hostname PostgreSQL (ex: `xxx-postgresql.services.clever-cloud.com`)
- `DATABASE_PORT_REMOTE` - Port (défaut: `5432`)
- `DATABASE_NAME_REMOTE` - Nom de la base
- `DATABASE_USERNAME_REMOTE` - Username
- `DATABASE_PASSWORD_REMOTE` - Password

### Optionnelles (S3/MinIO distant)
- `AWS_ENDPOINT_REMOTE` - Endpoint S3 de production
- `AWS_CDN_URL_REMOTE` - URL CDN publique

## Exemple complet

```bash
# Clever Cloud PostgreSQL credentials
export DATABASE_HOST_REMOTE="bxxxxx-postgresql.services.clever-cloud.com"
export DATABASE_PORT_REMOTE="5432"
export DATABASE_NAME_REMOTE="bxxxxx"
export DATABASE_USERNAME_REMOTE="uxxxxx"
export DATABASE_PASSWORD_REMOTE="your-secure-password"

# S3 Cellar (Clever Cloud)
export AWS_ENDPOINT_REMOTE="https://cellar-c2.services.clever-cloud.com"
export AWS_CDN_URL_REMOTE="https://cellar-c2.services.clever-cloud.com/gthdf-media"

# Run seed
./scripts/seed-remote.sh
```

## Troubleshooting

### Connection timeout
- Vérifiez que votre IP est autorisée sur Clever Cloud
- Vérifiez les credentials (host, port, username, password)

### SSL Error
- Le script utilise `DATABASE_SSL=true` par défaut
- Si nécessaire, ajustez dans le script

### Permission denied
```bash
chmod +x scripts/seed-remote.sh
```

### Seed déjà importé
Le script vérifie si les données ont déjà été importées via `pluginStore`.
Pour réimporter, il faut d'abord vider la base de données.

## Notes

- ⚠️ **Ne commit pas** les variables d'environnement sensibles
- 💾 Le script sauvegarde automatiquement votre `.env` local
- 🔄 En cas d'erreur, votre config locale est restaurée
- 🗑️ Les fichiers temporaires sont nettoyés automatiquement
