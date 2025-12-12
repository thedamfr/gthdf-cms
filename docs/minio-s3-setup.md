# Configuration MinIO/S3 pour Strapi

## Problème Résolu

Configuration du stockage d'objets S3-compatible avec MinIO pour les uploads de fichiers dans Strapi 5.32.0.

## Contexte

- **Strapi**: v5.32.0
- **Provider**: @strapi/provider-upload-aws-s3@5.32.0
- **Storage**: MinIO (S3-compatible)
- **SDK**: AWS SDK v3

## Solution Implémentée

### 1. Infrastructure Docker

```yaml
# docker-compose.yml
minio:
  image: minio/minio:latest
  container_name: gthdf-minio
  command: server /data --console-address ":9001"
  restart: unless-stopped
  ports:
    - "9000:9000"   # API S3
    - "9001:9001"   # Console web
  environment:
    MINIO_ROOT_USER: gthdf
    MINIO_ROOT_PASSWORD: gthdfpassword
  volumes:
    - miniodata:/data
```

### 2. Variables d'Environnement

```env
# .env
AWS_ACCESS_KEY_ID=gthdf
AWS_SECRET_ACCESS_KEY=gthdfpassword
AWS_REGION=us-east-1
AWS_BUCKET=gthdf-media
AWS_CDN_URL=http://127.0.0.1:9000/gthdf-media
```

### 3. Configuration Strapi Upload

```typescript
// config/plugins.ts
export default () => ({
  upload: {
    config: {
      provider: 'aws-s3',
      providerOptions: {
        baseUrl: env('AWS_CDN_URL', 'http://127.0.0.1:9000/gthdf-media'),
        rootPath: '',
        s3Options: {
          credentials: {
            accessKeyId: env('AWS_ACCESS_KEY_ID'),
            secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
          },
          region: env('AWS_REGION', 'us-east-1'),
          params: {
            Bucket: env('AWS_BUCKET'),
          },
          endpoint: 'http://127.0.0.1:9000',
          forcePathStyle: true, // CRITIQUE pour MinIO
          tls: false,           // HTTP local
          bucketEndpoint: false,
        },
      },
    },
  },
});
```

### 4. Content Security Policy (CSP)

```typescript
// config/middlewares.ts
export default [
  'strapi::logger',
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'https:'],
          'img-src': [
            "'self'",
            'data:',
            'blob:',
            'http://127.0.0.1:9000', // MinIO domain only
          ],
          'media-src': [
            "'self'",
            'data:',
            'blob:',
            'http://127.0.0.1:9000', // MinIO domain only
          ],
          upgradeInsecureRequests: null,
        },
      },
    },
  },
  // ... autres middlewares
];
```

**IMPORTANT**: CSP doit référencer uniquement le domaine (`http://127.0.0.1:9000`), pas le chemin complet du bucket.

### 5. Création du Bucket

**⚠️ Point Critique**: Le bucket DOIT être créé via l'API S3 (AWS SDK), pas via le CLI MinIO (`mc`).

```javascript
// create-bucket.js
import { S3Client, CreateBucketCommand, ListBucketsCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'gthdf',
    secretAccessKey: 'gthdfpassword',
  },
  forcePathStyle: true,
  tls: false,
});

const bucketName = 'gthdf-media';

try {
  await s3Client.send(new CreateBucketCommand({ Bucket: bucketName }));
  console.log(`Bucket ${bucketName} created successfully`);
} catch (err) {
  console.error('Error:', err);
}
```

**Exécution**:
```bash
node create-bucket.js
```

### 6. Configuration Bucket Policy (Public Read)

```json
// minio-policy.json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::gthdf-media/*"
    }
  ]
}
```

**Application de la policy** (via s3cmd):
```bash
s3cmd setpolicy minio-policy.json s3://gthdf-media \
  --host=http://127.0.0.1:9000 \
  --host-bucket=http://127.0.0.1:9000/gthdf-media \
  --access_key=gthdf \
  --secret_key=gthdfpassword \
  --no-ssl
```

## Points Techniques Clés

### MinIO a deux APIs distinctes

1. **API Native MinIO** (port 9001): Console web d'administration
2. **API S3-compatible** (port 9000): Compatible AWS SDK

**Conséquence**: Les buckets créés via `mc` (CLI MinIO) ne sont PAS visibles par l'AWS SDK. Il faut créer les buckets via l'API S3.

### Configuration Provider v5

Le provider @strapi/provider-upload-aws-s3 v5 requiert:
- Configuration dans `s3Options.credentials` (pas à la racine)
- `params.Bucket` à la racine de `s3Options` (pas dans `credentials`)
- `forcePathStyle: true` pour MinIO
- `bucketEndpoint: false` pour éviter les URLs bucket.*

### CSP et MinIO

Le Content Security Policy doit autoriser:
- Le domaine complet: `http://127.0.0.1:9000`
- Pas le chemin du bucket dans la directive CSP
- `upgradeInsecureRequests: null` pour HTTP local

## Vérification

### 1. Test Upload

```bash
# Accéder à l'admin Strapi
open http://localhost:1337/admin

# Upload > Upload files
# Les images doivent s'afficher sans erreur CSP dans la console
```

### 2. Vérifier MinIO

```bash
# Console MinIO
open http://127.0.0.1:9001

# Login: gthdf / gthdfpassword
# Vérifier bucket gthdf-media et fichiers uploadés
```

### 3. Test URL Publique

```bash
# Les fichiers doivent être accessibles publiquement
curl http://127.0.0.1:9000/gthdf-media/thumbnail_image.png
# Devrait retourner 200 OK
```

## Erreurs Communes Résolues

### ❌ NoSuchBucket
**Cause**: Bucket créé via `mc mb` au lieu de l'AWS SDK  
**Solution**: Utiliser `create-bucket.js`

### ❌ CSP Violation
**Cause**: CSP directive avec chemin complet du bucket  
**Solution**: Utiliser uniquement le domaine dans CSP

### ❌ Access Denied (403)
**Cause**: Bucket policy non appliquée  
**Solution**: `s3cmd setpolicy` avec credentials MinIO

### ❌ Provider Deprecated Warning
**Cause**: Configuration à la racine de `providerOptions`  
**Solution**: Wrapper dans `s3Options: {}`

## Fichiers Concernés

- `config/plugins.ts` - Configuration upload provider
- `config/middlewares.ts` - CSP pour MinIO URLs
- `docker-compose.yml` - Service MinIO
- `.env` - Credentials et bucket name
- `create-bucket.js` - Script création bucket (one-time)
- `minio-policy.json` - Policy public read (one-time)

## Production

Pour la production, remplacer:
- `http://127.0.0.1:9000` → URL publique MinIO/S3
- Credentials dans secrets manager
- HTTPS (TLS: true)
- CORS policy restrictive
