# Démonstrations locales isolées

Depuis `edutrack-api`, avec les dépendances installées et `DATABASE_URL` configurée dans `.env` :

```sh
npm run demo:create -- --name=demo_t3 --type=seeded
npm run demo:create -- --name=demo_empty --type=empty
```

La base locale doit déjà posséder le schéma public de l'application à jour. La commande crée **uniquement un nouveau tenant**. Si le nom existe, elle échoue sans le modifier. Pour une nouvelle présentation, utiliser par exemple `demo_t3_02`. Aucun argument de reset/remplacement n'existe.

Le nom doit commencer par `demo_`, contenir uniquement des minuscules, chiffres et underscores simples, et avoir au plus 56 caractères. `demo_t3` donne le schéma `school_demo_t3` et le sous-domaine `demo-t3`. Seules les connexions PostgreSQL à `localhost`, `127.0.0.1` ou `::1`, sans paramètres d'URL, sont autorisées ; `NODE_ENV=production` est refusé.

## Accès et lancement du frontend

La commande affiche le chemin d'un fichier `.tmp/demos/<nom>-<suffixe>.json`, ignoré par Git, créé avec les permissions `0600`. Il contient les identifiants, le mot de passe aléatoire commun aux comptes de cette seule démo, les UUIDs, le calendrier et les contrôles. Aucun mot de passe n'est affiché dans les logs. Ne pas partager ce fichier publiquement.

- Direction : `direction@demo.example`.
- Professeurs du profil rempli : identifiants dans `seeded.teachers`.
- Parent abonné : `seeded.parentActive` ; parent sans abonnement : `seeded.parentUnsubscribed`.

Pour ouvrir un frontend distinct sans changer le `.env` ni la session de test existante, depuis `edutrack-web` :

```sh
VITE_DEFAULT_TENANT_SCHEMA=school_demo_t3 VITE_FORCE_TENANT_SCHEMA=true VITE_TENANT_SUBDOMAIN='' npm run dev -- --port 5175 --strictPort
```

Le backend habituel doit être démarré avec sa configuration locale. Si `CORS_ORIGINS` est restrictif, le port choisi doit être autorisé par l'API utilisée. Utiliser un profil de navigateur séparé pour éviter de réutiliser un JWT d'un autre tenant. Pour le profil vide, remplacer le schéma par `school_demo_empty`. L'ouverture de la première année scolaire relève actuellement du **super administrateur**, depuis Écoles → école concernée → Cycle scolaire ; le directeur ne dispose pas de cette commande.

## Histoire du profil `seeded`

Le Collège des Flamboyants est une école fictive de Yamoussoukro. Le calendrier est **glissant**, afin que les tableaux de bord fondés sur la date système aient du contenu dès la création : rentrée J−203, T1 terminé J−119, T2 terminé J−15, T3 commencé J−10, fin d'année J+77. Ce calendrier de simulation n'est pas le calendrier scolaire officiel ivoirien. Le 24 septembre 2026, son libellé est `03/2026 - 12/2026`.

| Données | Scénario |
| --- | --- |
| Structure | 6ème A, 4ème A, 3ème A ; 24 élèves par classe ; 3ème marquée classe d'examen |
| Enseignants | Six matières et six professeurs, permanents et vacataires ; professeur principal attribué à chaque classe |
| T1 et T2 | Deux évaluations par matière et classe, saisies complètes, calculs et clôtures réels, 144 bulletins générés et publiés |
| T3 | Quelques évaluations dans trois matières ; français partiellement saisi ; aucun bulletin publié |
| Conduite | Avis des enseignants et décision de chaque professeur principal pour T1/T2 |
| Scolarité | 300 000 FCFA annuels, trois seuils cumulés ; paiements espèces, mobile money et virement |
| Familles | Soldes annuels réglés, paiements réguliers ou irréguliers, 18 élèves en retard ; 9 remises sociales de 30 000 FCFA ; 9 paiements `waived_by_school` de 50 000 FCFA |
| Assiduité | Six semaines, week-ends et coupure T2/T3 exclus ; absences, retards, absences justifiées et validations en attente |
| Risques | Six élèves à risque et un enseignant avec signal d'absences lors de la recette |
| Parents | 72 comptes liés à leurs enfants : 48 abonnements actifs et payés, 24 sans abonnement |
| Actions | Générées après création par `runDashboardActionsForSchema`, le gestionnaire utilisé par le job existant ; aucune insertion manuelle |

Les moyennes, décisions, bulletins, caches financiers et risques passent par les services métier existants. Les dates historiques des évaluations et bulletins sont ensuite rétablies. « Bulletin généré » désigne le bulletin métier enregistré et publié ; le PDF reste produit à la demande par le mécanisme asynchrone habituel.

Aucun message SMS, email ou push n'est envoyé par le provisionnement. Le canal SMS du nouveau tenant est désactivé. Les paiements et contacts sont fictifs ; aucune transaction externe n'est réalisée. Les données vieillissent naturellement après création : créer un nouveau nom pour retrouver le scénario de début de T3.

**Comportement produit constaté :** les parents sans abonnement peuvent se connecter et consulter leurs enfants. Leur endpoint de statut d'abonnement retourne `404 SUBSCRIPTION_NOT_FOUND`, contre un abonnement actif pour les abonnés. Le seed conserve cette règle existante. Les écarts de calcul financier et de carte de risque professeur sont détaillés dans le [rapport de recette](verification.md).

## Profil `empty`

Il crée le schéma applicatif, le compte directeur et les entrées techniques du registre public, sans année, niveau, classe, matière, professeur, élève, parent, salle, créneau, paiement ni bulletin. Les règles de risque par défaut fournies par les migrations sont conservées : ce sont des paramètres techniques, pas un jeu de données scolaire. L'onboarding reste à faire.

L'école vide conservée localement reste vierge. Le parcours d'ajout progressif a été réalisé sur une autre instance de ce profil, dans une **base de validation séparée**, pour conserver un exemple vierge disponible. Voir le [rapport de recette](verification.md) pour les étapes et les blocages reproduits.

## Isolation, migrations et reprise

Les anciens `db:seed`, `db:seed:v2` et `createTenantSchema` ne sont pas utilisés : leur initialisation comporte des migrations publiques ou des boucles sur les autres schémas. La nouvelle commande réutilise les fichiers SQL Drizzle existants via un plan limité au seul nouveau schéma. Elle ne crée aucune nouvelle migration.

Le manifeste SHA-256 `src/shared/database/demo/migrations.manifest.json` verrouille les versions relues. Une migration ajoutée, retirée ou modifiée déclenche `DEMO_MIGRATION_REVIEW_REQUIRED` **avant toute écriture**. Pour maintenir ce manifeste, relire la migration et son périmètre, adapter si nécessaire `scopeDemoMigration`, mettre à jour son empreinte, puis rejouer les tests d'isolation. Ne pas régénérer le manifeste aveuglément.

La réservation du nom est verrouillée et vérifie le schéma PostgreSQL ainsi que le registre/sous-domaine. Schéma, registre et seed sont créés dans une transaction : une erreur les annule ensemble. Les doublons concurrents ne peuvent créer qu'un tenant. La génération d'actions intervient après commit, par le job existant ; si elle échoue, la commande le signale et conserve le chemin d'accès au tenant créé. Ne pas tenter de remplacer ce tenant : diagnostiquer le job ou utiliser un nouveau nom. Un fichier privé marqué `provisioning` peut rester après un échec transactionnel ; il ne prouve pas que le tenant existe.

## Vérification automatisée

```sh
npm run typecheck
npx eslint src/shared/database/demo
npm run test:unit -- --run
# DATABASE_URL_TEST doit désigner une base de test dédiée, jamais la base locale de travail.
npm run test:integration -- tests/integration/demo.provisioning.test.ts
```

Les tests utilisent `tests/integration/setup.ts`, créent des noms aléatoires `demo_*` et ne nettoient que ces noms. Ils couvrent création vide, refus de collision, rollback tardif, concurrence, bulletin/calcul/conduite, profils financiers et parents, job d'actions, et empreintes des données du tenant témoin préexistant. Le harness de tests standard ne doit jamais être dirigé vers la base des tenants de travail.
