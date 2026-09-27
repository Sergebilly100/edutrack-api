# C10 — Profils, contrats et affectations des professeurs

## Comportement livré

L’import initial du directeur crée ou réimporte uniquement l’identité, les contacts et le contrat. Les anciennes colonnes Matières/Classes sont ignorées et retirées de l’aperçu. Le réimport conserve `teachers.subjects` et les associations pédagogiques. Le modèle Excel ne contient plus de matière ; sa feuille INSTRUCTIONS explique les contrats et l’affectation après les inscriptions. Les anciens en-têtes Téléphone*/Email* restent acceptés.

Le formulaire individuel contient des blocs indépendants : une matière et plusieurs classes de l’année active. Il restitue les associations existantes et résout chaque matière selon le niveau de chaque classe. Mathématiques → 4e A, 2nde C et Chimie → 3e B produisent exactement trois associations. Les blocs incomplets et les doublons sont refusés avant envoi, puis contrôlés par l’API. Les professeurs bloqués ou inactifs gardent leurs informations modifiables, avec les affectations verrouillées.

Le super administrateur dispose du même moteur d’import dans Données professeurs et dans la reprise C8. Le format est `Matricule | Matière | Classes`, avec les classes séparées par des virgules. Chaque groupe est atomique : une valeur invalide exclut toute sa ligne. Les erreurs précisent ligne, colonne, valeur et cause. Aucun professeur, niveau, matière ou classe n’est créé par cet import. Les doublons du fichier et les associations déjà présentes sont refusés.

Un aperçu signé couvre le fichier, le mapping, l’année et les dépendances. La confirmation revalide les données dans la transaction C8 ; un changement de statut ou de dépendance impose un nouvel aperçu. L’écriture et l’audit sont atomiques. Les confirmations individuelles recontrôlent aussi les associations dans une transaction sérialisable ; la modification du profil et des associations utilise désormais une seule transaction.

Le rappel des classes sans professeur principal s’affiche dans le formulaire et après les mutations/imports. Il ne bloque jamais l’opération ; l’échec du chargement de ce rappel ne transforme pas une sauvegarde réussie en erreur.

Les gardes EDT conservent l’exigence d’un professeur actif, non bloqué et d’une association exacte matière–classe de l’année active. La duplication d’une période applique ces gardes à tous les créneaux copiés dans une transaction. L’import EDT ne crée aucune association.

## Navigation vérifiée

- Directeur : **Vie scolaire → Professeurs → fiche professeur → Infos** ; le formulaire de création permet également les blocs.
- Import initial directeur : **Administration → Import de données → Importer les professeurs** ; aucune entrée d’import d’affectations dans l’onboarding.
- Super administrateur : **Écoles → Voir détail → Données professeurs**.
- École en reprise : **Écoles → Voir détail → Reprise de données → Professeurs : affectations**, après les étapes de création des classes/inscriptions.
- Professeur principal : **Académique → Structure scolaire → Classes**.

L’onglet Données professeurs est disponible aussi pour une école hors reprise. Il prolonge la fiche école existante, sans nouvelle route ni modification visuelle de la barre latérale.

## Décisions techniques et fichiers

La cohérence matière/niveau existait déjà dans `TeachersRepository.countValidTeachingAssignments` (`c.level_id = sub.level_id`). C10 la conserve et complète le contrôle de l’année active ; aucune nouvelle règle de niveau n’a été inventée. Les associations des années historiques sont conservées quand les blocs de l’année active sont remplacés. Les listes d’associations exposées au formulaire portent sur les classes actives de l’année active.

Le moteur de reprise étant déjà hébergé dans le module finance, C10 étend ce moteur et son branchement admin existant. Le validateur pur partagé évite un nouvel import croisé entre modules. Aucun schéma ni dépendance n’est ajouté. Les traductions de valeurs sont interdites pour les affectations afin de conserver les identités de rapprochement ; la normalisation existante des libellés et des matières reste utilisée.

| Zone | Fichiers créés/modifiés |
|---|---|
| API import initial | `src/modules/import-export/import.service.ts`, `import.repository.ts`, `import.types.ts`, `templates/teachers.xlsx` |
| API affectations | nouveau `src/shared/import-mapping/teacher-assignments.ts`, `midyear.types.ts`, `src/modules/finance/midyear-import.service.ts`, `midyear-import.repository.ts`, `src/modules/admin/admin.controller.ts` |
| API individuel et EDT | `src/modules/teachers/teachers.service.ts`, `teachers.repository.ts`, `teachers.types.ts`, `src/modules/schedule/schedule.service.ts`, `schedule.repository.ts` |
| Frontend individuel | nouveau `src/modules/teachers/teaching-assignments.ts`, `components/TeacherForm.tsx`, `TeacherDetailPage.tsx`, `TeachersPage.tsx`, `teachers.api.ts` |
| Frontend imports | `src/modules/import-export/ImportWizard.tsx`, `src/modules/admin/components/MidyearImportPanel.tsx`, `AdminSchoolDetailPage.tsx`, `admin.api.ts` |
| API tests | nouveaux `tests/unit/teacher-assignments.test.ts`, `tests/integration/teacher-assignments.routes.test.ts` ; adaptation des tests teachers, import, packaging du modèle, schedule et du scénario nominal de duplication `qa.school-workflows.routes.test.ts` |
| Frontend tests | nouveau `src/modules/teachers/__tests__/teaching-assignments.test.ts` ; adaptation de TeacherForm, ImportWizard et MidyearImportPanel ; nouveau `e2e/critical/teacher-assignments.spec.ts` |

## Validation et auto-revue

Baseline avant modification : 111 tests unitaires API ciblés et 59 tests frontend ciblés passaient.

Résultats finaux :

- API : **635/635** tests unitaires (54 fichiers), **432/432** tests d’intégration (53 fichiers).
- Frontend : **486/486** tests (89 fichiers).
- Playwright `critical-real` : **3/3** parcours C10, Android émulé, bureau et fiche école super administrateur.
- Lint et build TypeScript des deux projets : réussis ; build PWA réussi. Le frontend conserve l’avertissement existant sur la taille de certains chunks.
- `git diff --check` : réussi dans les deux projets.

Les fixtures nominales de deux tests EDT ont été complétées pour fournir une affectation valide de l’année active, puisque le refus d’une ancienne affectation incomplète est maintenant le comportement attendu. Un test de dashboard a dépassé son attente lors du passage frontend exécuté en parallèle du navigateur et des builds ; la suite frontend complète relancée passe sans modification de ce module.

Les nouveaux tests couvrent la normalisation des listes, les groupes sur plusieurs niveaux, les doublons et dépendances ambiguës/absentes, les statuts, l’année active, le réimport sans mutation pédagogique, la conservation historique, la confirmation périmée, le rollback intégral et les gardes EDT manuel/import/duplication. Le navigateur utilise de vrais endpoints et PostgreSQL, sans interception API : inscription avec création de classe, encaissement, blocs individuels, rechargement et premier import EDT.

Les consignes d’architecture, d’isolation tenant, de validation dans les services, d’absence de données personnelles dans les nouveaux logs, de composants shadcn et de tokens DESIGN ont été vérifiées. Les états de chargement, erreur avec reprise, vide et confirmation sont présents. Les nouvelles commandes et sélections de blocs ont une cible tactile d’au moins 48 px. L’accès super administrateur est vérifié depuis la navigation réelle. Le diff est limité aux deux projets autorisés.

Auto-revue : le périmètre fonctionnel C10 est intégralement implémenté, aucun écart produit ni régression détectée. Les consignes standard sont respectées pour le code et les contrôles disponibles ; la vérification matérielle demandée reste limitée comme indiqué ci-dessous.

Limite de validation : Chromium a été testé à 393 × 851 avec touch/mobile et à 1280 × 900, sans débordement horizontal du formulaire. Aucun téléphone Tecno/Itel physique n’était disponible ; cette vérification matérielle n’est pas certifiée. La base de tests isolée utilise PostgreSQL 17 local. Aucun environnement de production n’a été modifié.

Message de commit proposé : `fix(teachers): séparer profils initiaux et affectations pédagogiques`.
