# IvoirEdu (EduTrack CI)

> **IvoirEdu** - SaaS de gestion scolaire **offline-first** pour les écoles privées de
> Côte d'Ivoire.
> *« Le seul outil qui prouve que les cours ont été donnés. »*
>
> Le nom *EduTrack* étant déjà utilisé par d'autres plateformes, le produit est
> commercialisé sous la marque **IvoirEdu**. Le code et les dépôts conservent encore le
> préfixe `edutrack-` ; les deux noms désignent le même projet.

Version : **1.0.0** stable.

---

## Ce que fait l'application

- **Onboarding par import Excel** : une nouvelle école importe ses élèves, professeurs et
  emploi du temps via des modèles `.xlsx` générés par l'app, avec prévisualisation
  (dry-run) avant validation et historique des imports.
- **Présence professeurs & élèves offline-first** : pointage par scan de QR code de salle,
  fonctionnant sans réseau (PWA) puis synchronisé automatiquement.
- **Validations horaires** : contrôle des heures réelles, géolocalisation, scans de fin
  manquants, sanctions et recalcul de salaire.
- **Facturation & salaires** : fiches de salaire professeur, suivi des paiements et
  génération de **PDF réels** (relevé de présences, historique de paiements, revenus,
  fiche de salaire).
- **Abonnements parents & revenus** : souscriptions SMS/email, commission plateforme.
- **Portail parent** : consultation des présences, absences et emploi du temps des enfants.
- **Notifications multi-canal** : SMS (AfricasTalking), e-mail (Brevo), in-app, et
  **notifications push PWA** (prof + parent) via Web Push/VAPID - en complément, jamais
  en remplacement des SMS/email. L'app guide l'utilisateur pour s'installer sur son
  téléphone et activer les notifications.
- **Documents administratifs** : upload de pièces (diplôme, CNI, contrat, photo, relevé)
  sur Cloudflare R2 (repli local en dev).
- **Console super-admin multi-tenant**, rôles & permissions granulaires.

> ℹ️ L'application **ne gère pas encore** les notes ni les bulletins scolaires.

---

## Architecture (2 dépôts)

Le projet est composé de deux applications, chacune avec son propre dépôt git, versionnées
ensemble en `1.0.0` :

| Dossier | Rôle | Stack |
|---|---|---|
| `edutrack-api/` | API backend | Fastify 5, TypeScript strict, Drizzle ORM, BullMQ, PostgreSQL, Redis |
| `edutrack-web/` | Frontend PWA | React 18, Vite 5, vite-plugin-pwa (Workbox), shadcn/ui, TanStack Query v5 |

- **Multi-tenancy** : un schéma PostgreSQL dédié par école, isolation totale des données.
- **Jobs asynchrones** : SMS, e-mails et exports PDF passent par des files **BullMQ** sur
  Redis (jamais synchrones).
- **Offline-first** : la PWA met les pointages en file locale et les synchronise au retour
  du réseau.

---

## Prérequis

- **Node.js 20 LTS**
- **PostgreSQL 16** (ou 17)
- **Redis 7**
- *(optionnel)* **Cloudflare R2** pour le stockage des documents - sinon repli sur le
  disque local en développement.
- *(optionnel)* Comptes **Africa's Talking** / **smsmode** (SMS) et **Brevo** (e-mail) -
  un mode mock est disponible (`SMS_MOCK`, `EMAIL_MOCK`).

Le plus simple en local : lancer Postgres et Redis via le `docker-compose.yml` fourni dans
`edutrack-api/`.

---

# Config BACKEND

## Variables d'environnement

Chaque dépôt fournit un fichier d'exemple à copier :

```bash
cp edutrack-api/.env.example edutrack-api/.env
```

### Backend (`edutrack-api/.env`)

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Connexion PostgreSQL |
| `DATABASE_URL_TEST` | Base utilisée par les tests d'intégration (repli sur `DATABASE_URL`) |
| `REDIS_URL` | Connexion Redis (BullMQ) |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | Clés RSA pour signer/vérifier les JWT (RS256) |
| `JWT_EXPIRY` / `JWT_REFRESH_EXPIRY` | Durées de vie des tokens |
| `CORS_ORIGINS` | Origines autorisées (obligatoire en prod) |
| `SALARY_EXPORT_SIGNING_SECRET` | Secret de signature des liens de téléchargement d'export |
| `R2_*` (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_BUCKET`, `R2_ENDPOINT`, `R2_PUBLIC_URL`) | Stockage des documents (Cloudflare R2) ; repli local si absent |
| `DOCUMENTS_LOCAL_STORAGE_ROOT` / `BILLING_EXPORT_DIR` | Répertoires de repli local (documents / exports PDF) |
| `QR_SCAN_BASE_URL` / `APP_BASE_URL` / `API_PUBLIC_URL` | URLs publiques (QR codes, liens, Swagger) |
| `TENANT_BASE_DOMAINS` | Domaines racines où les écoles sont servies, séparés par virgule (ex. `ivoiredu.ci,novatrixsys.com`) |
| `TENANT_ENV_PREFIXES` | Préfixes d'environnement à ignorer avant le sous-domaine tenant (défaut : `dev,staging,preprod`) |
| `TENANT_HOST_MAPPINGS` | Mapping explicite host → tenant, séparé par virgule (ex. `dev.ivoiredu.novatrixsys.com:school_sainte_marie`) |
| `AFRICASTALKING_*`, `SMSMODE_*`, `SMS_MOCK` | Fournisseurs SMS |
| `EMAIL_PROVIDER`, `BREVO_API_KEY`, `EMAIL_FROM`, `EMAIL_MOCK` | E-mail |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push (notifications PWA). Si absentes, le push est désactivé proprement |
| `ENABLE_SWAGGER` | Expose la doc Swagger UI (`/docs`) hors développement |

> La liste complète et commentée est dans `edutrack-api/.env.example`.

---

## Démarrage local

IvoirEdu expose un **site web/PWA** en plus de l'API. En local, le site est servi
par Vite depuis `edutrack-web/` et consomme l'API Fastify depuis `edutrack-api/`.

```bash
# 1) Dépendances d'infrastructure (depuis edutrack-api/)
cd edutrack-api
docker compose up -d postgres redis

# 2) Backend
cp .env.example .env            # puis renseigner JWT_*, secrets, etc.
npm install
npm run db:migrate              # applique les migrations à tous les schémas tenants
npm run db:seed                 # (optionnel) données de démonstration
npm run dev                     # API sur http://localhost:3000

# 3) Frontend (dans un autre terminal, depuis edutrack-web/)
cd ../edutrack-web
cp .env.example .env
npm install
npm run dev                     # web sur http://localhost:5173
```

- Site web / PWA IvoirEdu : <http://localhost:5173>
- API backend : <http://localhost:3000>
- Documentation Swagger UI : <http://localhost:3000/docs> (activée hors prod, ou avec
  `ENABLE_SWAGGER=true`)

### Accès au site local

1. Démarrer l'API sur `http://localhost:3000`.
2. Démarrer le frontend sur `http://localhost:5173`.
3. Ouvrir <http://localhost:5173> dans le navigateur.

Le site détecte `localhost` et peut envoyer `VITE_DEFAULT_TENANT_SCHEMA` au login pour
travailler sur une école de démonstration, par défaut `school_sainte_marie`. Hors
localhost, le tenant est résolu par le domaine/sous-domaine.

### Configuration serveur locale

Backend (`edutrack-api/.env`) :

```env
PORT=3000
DATABASE_URL=postgresql://edutrack:edutrack@localhost:5432/edutrack
REDIS_URL=redis://localhost:6379
APP_BASE_URL=http://localhost:5173
API_PUBLIC_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:5173,http://localhost:4173
QR_SCAN_BASE_URL=http://localhost:5173
AUTH_DEFAULT_TENANT_SCHEMA=school_sainte_marie
```
---

## Commandes de build & vérification

### Backend (`edutrack-api/`)

```bash
npm run typecheck && npm run lint && npm run test   # vérification complète
npm run build                                        # compile + copie les polices PDF
```

Les tests d'intégration nécessitent PostgreSQL et Redis accessibles
(`docker compose up -d postgres redis`).

---
