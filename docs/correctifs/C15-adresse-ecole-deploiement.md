# C15 — adresse école : procédure et preuve de recette

## État de l’outillage relu

- `0073_school_address.sql` ajoute `public.tenants.address varchar(255)` avec `IF NOT EXISTS`. La colonne est nullable, sans valeur par défaut ni mise à jour des lignes existantes.
- Le manifeste SHA-256 `src/shared/database/demo/migrations.manifest.json` contient 0073. Il protège le provisionnement de démo, mais ne pilote pas le déploiement des écoles existantes. Le journal Drizzle `meta/_journal.json` ne référence pas 0073.
- La commande du dépôt est `npm run db:migrate` depuis `edutrack-api` avec le `DATABASE_URL` **de la base choisie**. Elle exécute `src/shared/database/migrate-all-tenants.ts` : tous les fichiers SQL triés, sur tous les schémas non exclus, sans journal de versions ni transaction globale. Son périmètre dépasse 0073.
- `ansible/deploy.yml` redémarre le conteneur API et vérifie son état TCP/Consul ; le contrôle HTTP `/health` est commenté. Il ne lance aucune migration ni sauvegarde. Le `Dockerfile` de service ne copie pas `src/`, alors que `db:migrate` lit `src/shared/database/migrations` : la commande ne peut pas être lancée telle quelle **dans l’image de service**. Le dépôt ne décrit ni commande de restauration ni release command pour cet Ansible.

## Ordre contrôlé à appliquer à l’environnement cible

1. L’exploitant identifie la base de **préproduction** et la procédure de déploiement autorisée, les deux tenants de validation, le point de sauvegarde vérifié et la procédure de restauration déjà en usage. Vérifier quels autres SQL du dossier seraient rejoués par `db:migrate` avant de l’autoriser. Ne pas utiliser une base utilisateur pour la recette locale.
2. Préparer une sauvegarde récupérable et faire contrôler sa restauration en préproduction selon la procédure d’exploitation existante. Aucun script de restauration n’est présent dans ce dépôt ; son exécution et son résultat doivent être fournis par l’exploitant. En cas d’échec de migration, arrêter le déploiement API/web, conserver les journaux et choisir la reprise ou la restauration suivant cette procédure. Le runner n’assure pas de rollback global.
3. Sur un exécuteur approuvé **qui possède le checkout `edutrack-api` et ses dépendances**, configurer `DATABASE_URL` pour la base cible et lancer la commande existante `npm run db:migrate`. Vérifier le code de sortie et la liste des schémas traités. Aucun recalcul financier ne fait partie de C15 ; ne pas lancer `finance:recalculate-caches`.
4. Contrôler la colonne et les deux tenants autorisés en lecture SQL :

   ```sql
   SELECT column_name, is_nullable, data_type, character_maximum_length
   FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'address';

   SELECT id, schema_name, name, city, address, logo_url, allow_teacher_qr_skip
   FROM public.tenants
   WHERE id IN ('<uuid-tenant-adresse>', '<uuid-tenant-historique>');
   ```

   Comparer `name`, `city`, `logo_url` et la politique QR avec l’instantané de lecture préalable. La première école doit conserver son adresse exacte ; la seconde doit rester à `NULL` si elle n’a pas été ciblée pour la saisie. Vérifier `GET /api/v1/school/info` sous le compte directeur et `GET /api/v1/admin/schools/:id` sous le compte super administrateur.
5. Après ce contrôle, déployer l’API, puis le web par la procédure autorisée. Tester les trois parcours avec les seuls tenants de validation. Vérifier les réponses API et les mêmes lignes SQL après les mutations. Comparer les autres tenants en lecture avant/après ; aucun autre tenant ne doit être écrit par la **recette**. L’application de la migration, elle, concerne tous les schémas du runner.

La séquence ci-dessus est préparée, mais **aucune préproduction ni base utilisateur n’a été migrée dans cette tâche**. Le nom de l’environnement, l’exécuteur, les identifiants des tenants et la procédure de restauration restent à confirmer par l’exploitation ; la commande n’est pas encore approuvée pour une base utilisateur.

## Résultat sur bases locales jetables, 28 septembre 2026

- Sur une base ne contenant que la migration `0000`, deux tenants existaient avant 0073 et la colonne `address` était absente. Après 0073, les deux lignes étaient conservées avec `address=NULL`. Après avoir renseigné l’un d’eux puis rejoué 0073, l’adresse renseignée et l’adresse nulle ont été conservées, ainsi que `plan` et `status`. Une même table publique ne peut pas avoir simultanément des lignes « avec adresse » et « sans adresse » **avant la création de la colonne** ; le contrôle de rejeu couvre le cas de colonne déjà présente.
- Sur une autre base jetable avec deux schémas d’école, la commande réelle `npm run db:migrate` a terminé avec `All tenants migrated successfully`. La lecture SQL après exécution a donné un tenant `NULL` et un tenant `Rue C15, Bouaké`. Une assertion SQL a confirmé, pour les deux lignes, la conservation des noms, villes, plans, statuts et logos (`true`). Ce test confirme le runner sur cette fixture ; il ne remplace pas la préproduction et ne prouve pas que tous les anciens SQL sont sans effet sur une base historique réelle.
- Six tests d’intégration API dans `configuration-review.routes.test.ts` passent : 0073 rejouée, école historique sans adresse modifiable par politique QR et logo, trois écritures partielles/relectures SQL, création super administrateur et connexion/lecture du directeur créé.
- Trois tests Playwright C15 passent avec API Fastify et PostgreSQL réels, sans réponse HTTP simulée : création/édition super administration et relecture API directeur, saisie onboarding et rechargement, modification d’un autre paramètre sur école sans adresse puis saisie dans paramètres et relecture après rechargement. La fixture C15 utilise ses propres tenant et services locaux ; un reset SQL de son seul tenant prépare le cas historique.

## Compte rendu post-déploiement à compléter

| Contrôle | Résultat |
| --- | --- |
| Préproduction : migration et restauration vérifiée | Non exécuté ; environnement et procédure non fournis |
| Tenant autorisé avec adresse : SQL + API + directeur | En attente du déploiement autorisé |
| Tenant historique autorisé sans adresse : mutation non liée + SQL/API | En attente du déploiement autorisé |
| Tenants non ciblés : comparaison de lecture avant/après recette | En attente du déploiement autorisé |

**Auto-revue.** Les consignes standard et les références AGENTS/DESIGN/PRODUCT/PROJECT ont été lues ; les modifications restent dans `edutrack-api` et `edutrack-web`. Aucune migration existante, calcul financier, donnée d’école utilisateur, queue, secret, style de navigation, schéma ou notification n’a été modifié. L’UI utilise les composants et tokens existants, une action de 48 px et le feedback de mutation existant. Les écritures API restent partielles. Les tests ciblés et les vérifications TypeScript passent ; la mise en service et le contrôle post-déploiement restent explicitement en attente de l’environnement et de la procédure autorisés.

Message de commit proposé : `fix(schools): enable address editing and add controlled C15 rollout checks`
