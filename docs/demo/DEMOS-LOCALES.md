# Lancer deux démonstrations locales

Ce guide crée deux écoles de démonstration **isolées** dans PostgreSQL :

1. une école vide, pour présenter le parcours de configuration depuis le début ;
2. une école déjà remplie, pour présenter immédiatement les écrans métier.

Les commandes ci-dessous ne remplacent ni ne réinitialisent une démo existante. Chaque
nouveau nom crée un nouveau tenant. Garder donc les noms proposés, ou leur ajouter un
suffixe numérique (`demo_empty_02`, `demo_seeded_02`, etc.).

## 1. Préparer l'environnement local

Les fichiers de configuration locale sont déjà présents dans cette copie de travail :
`edutrack-api/.env` et `edutrack-web/.env.local` (ou `.env.development`). Vérifier leurs
valeurs avant de lancer les commandes. Aucun fichier `.env.example` n'est versionné dans
ce dépôt.

Depuis la racine du dépôt, installer les dépendances si nécessaire, puis démarrer
l'infrastructure :

```sh
cd edutrack-api
npm ci
docker compose up -d postgres redis
npm run db:migrate               # seulement si la base locale n'est pas déjà à jour

cd ../edutrack-web
npm ci
```

Avant de continuer, vérifier que `edutrack-api/.env` contient une `DATABASE_URL` locale
valide. Le provisionnement de démo refuse une base distante et refuse aussi de s'exécuter
en production.

Les deux frontends de ce guide utilisent les ports `5175` et `5176`. Ajouter ces origines
à `CORS_ORIGINS` dans `edutrack-api/.env`, puis redémarrer l'API :

```env
CORS_ORIGINS=http://localhost:5173,http://localhost:5175,http://localhost:5176,http://localhost:4173
```

> Si la plateforme locale ne possède encore aucun compte super-administrateur, exécuter
> une seule fois `npm run db:seed` depuis `edutrack-api`. Cette initialisation crée aussi
> l'école standard `school_sainte_marie`, indépendante des deux démos de ce guide. Elle
> crée le compte `admin@edutrack.ci` avec le mot de passe `Test1234!`. Ne pas utiliser
> cette commande pour recréer les démos ci-dessous. L'API doit également conserver
> `school_sainte_marie` comme `AUTH_ADMIN_SCHEMA` (ou comme
> `AUTH_DEFAULT_TENANT_SCHEMA`) pour que ce compte puisse utiliser `/admin/login`.

## 2. Créer les deux démos

Depuis `edutrack-api` :

```sh
npm run demo:create -- --name=demo_empty_01 --type=empty
npm run demo:create -- --name=demo_seeded_01 --type=seeded
```

Chaque commande affiche le chemin d'un fichier privé sous
`edutrack-api/.tmp/demos/`. Ce fichier contient le mot de passe aléatoire et les
identifiants de la démo ; il ne faut ni le versionner ni le partager. Les deux comptes de
direction utilisent l'adresse `direction@demo.example`, mais ont chacun leur propre mot
de passe, à lire dans leur fichier JSON.

Les schémas créés sont :

| Démo | Schéma PostgreSQL | Contenu |
| --- | --- | --- |
| École vide | `school_demo_empty_01` | Compte direction et réglages techniques uniquement ; aucune année, classe, élève ou paiement. |
| École avec seed | `school_demo_seeded_01` | Collège fictif prérempli : classes, élèves, enseignants, évaluations, assiduité, finance, parents et alertes. |

## 3. Démarrer l'API

Dans un premier terminal, depuis `edutrack-api` :

```sh
npm run dev
```

L'API est disponible sur `http://localhost:3000`.

## 4. Lancer l'école vide

Dans un deuxième terminal, depuis `edutrack-web` :

```sh
VITE_DEFAULT_TENANT_SCHEMA=school_demo_empty_02 \
VITE_FORCE_TENANT_SCHEMA=true \
VITE_TENANT_SUBDOMAIN='' \
npm run dev -- --port 5175 --strictPort
```

Ouvrir `http://localhost:5175`, puis se connecter avec :

- identifiant : `direction@demo.example` ;
- mot de passe : champ `password` du fichier `.tmp/demos/demo_empty_01-*.json`.

### Parcours conseillé pour la démo vide

1. Se connecter au super-administrateur via `http://localhost:5175/admin/login`.
2. Aller dans **Écoles**, ouvrir `Collège des Flamboyants - Démo demo_empty_01`, puis
   **Cycle scolaire** pour ouvrir la première année. Cette action est réservée au
   super-administrateur.
3. Revenir à la session direction dans une fenêtre ou un profil de navigateur séparé.
4. Montrer la configuration de l'école, les niveaux/classes, les matières, les
   enseignants, puis l'import ou l'inscription des élèves.

Utiliser un profil de navigateur distinct pour la session super-administrateur et celle
de direction : cela évite qu'un jeton de connexion d'une autre école soit réutilisé.

## 5. Lancer la démo avec données de seed

Dans un troisième terminal, depuis `edutrack-web` :

```sh
VITE_DEFAULT_TENANT_SCHEMA=school_demo_seeded_01 \
VITE_FORCE_TENANT_SCHEMA=true \
VITE_TENANT_SUBDOMAIN='' \
npm run dev -- --port 5176 --strictPort
```

Ouvrir `http://localhost:5176`, puis utiliser :

- direction : `direction@demo.example` ;
- mot de passe : champ `password` du fichier `.tmp/demos/demo_seeded_01-*.json` ;
- autres comptes (professeurs et parents) : sections `seeded.teachers`,
  `seeded.parentActive` et `seeded.parentUnsubscribed` du même fichier.

Le scénario seedé est volontairement calé autour de la date de création. Pour retrouver
les alertes, échéances et évaluations proches de la date du jour lors d'une future
présentation, créer une nouvelle démo seedée avec un nouveau nom.

## 6. Arrêter ou refaire une démo

Arrêter les serveurs avec `Ctrl+C` dans leurs terminaux. PostgreSQL et Redis peuvent
rester démarrés pour la prochaine session.

Une démo créée ne se remplace pas. Pour repartir à zéro, créer un nouveau tenant :

```sh
cd edutrack-api
npm run demo:create -- --name=demo_empty_02 --type=empty
npm run demo:create -- --name=demo_seeded_02 --type=seeded
```

Puis remplacer le schéma et, si les deux applications tournent simultanément, choisir de
nouveaux ports dans les commandes Vite.

