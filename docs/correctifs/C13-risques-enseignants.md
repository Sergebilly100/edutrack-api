# C13 — Retards enseignants et « Professeurs à suivre »

Implémentation et critères d’acceptation validés. Aucun seuil de nombre de retards n’a été inventé.

## Décision et comportement

L’exploration de `risk.calculations`, du repository, des paramètres et des migrations a confirmé uniquement le seuil historique d’absences (3 sur une fenêtre configurée à 30 jours par défaut) et la tolérance de pointage de 15 minutes. Aucune règle de risque de retards n’existait.

La réponse produit reçue pendant la tâche demande une configuration du nombre de retards et des minutes, sur 30 jours, appliquée également au statut du pointage.

- `teacher/lateness` dans `risk_alert_rules` : nombre entier positif explicitement renseigné, `lateMinutes` entier positif ou nul, période fixe de 30 jours, activation indépendante.
- Sans configuration : le signal de retard reste inactif ; le pointage conserve la tolérance existante de 15 minutes.
- Un pointage dépassant la tolérance configurée devient `late`. Le pointage à la limite reste `present`, conformément à la comparaison existante. Après la fin du créneau, il reste `absent`.
- La tolérance s’applique immédiatement aux prochains pointages et au pointage créé lors d’un saut de l’étape QR. Sa valeur reste utilisée lorsque le signal de risque est désactivé. Les statuts historiques sont conservés.
- Source de risque : `attendances_teacher.status = 'late'`, sur J-29 à aujourd’hui inclus. J-30 et les dates futures sont exclus. Le calcul d’absences B07 et sa fenêtre configurée sont conservés.
- `teacher_risk_status` porte deux indicateurs indépendants : `absences_signal` et `lateness_signal`. Un signal donne `attention` (« À suivre »), deux donnent `warning` (« Vigilance »).
- Le job et le pilotage agrégé comptent les enseignants par absence **ou** retard : une personne cumulant les deux compte une fois. Les comptes inactifs et les enseignants bloqués sont exclus, même si leur ancien statut de risque subsiste.
- L’action élèves reste séparée. L’historique des actions et l’index d’unicité des actions ouvertes de 0065 sont conservés ; deux exécutions réelles du worker ne créent pas deux actions ouvertes.

## Fichiers

API :

- `src/modules/risk/risk.calculations.ts`, `risk.types.ts`, `risk.controller.ts`, `risk.service.ts`, `risk.repository.ts` : configuration validée, calcul pur, persistance et liste des motifs.
- `src/modules/attendance/attendance.repository.ts`, `attendance.service.ts`, `src/shared/utils/attendance.ts` : tolérance configurée pour le pointage et le statut.
- `src/modules/dashboard-actions/dashboard-actions.repository.ts`, `src/modules/dashboard/dashboard.repository.ts` : compte enseignant unique et indicateurs agrégés. Le service dashboard-actions possédait déjà la bonne séparation entre enseignants et élèves ; son orchestration est conservée.
- `src/shared/database/schema/tenant.schema.ts`, migrations `0077_risk_schema_declarations.sql`, `0078_teacher_lateness.sql`, journal et snapshots Drizzle : déclaration des tables existantes puis ajout des colonnes. Génération Drizzle Kit, SQL limité aux tables de risque, opérations rendues idempotentes.
- `tests/unit/risk.service.test.ts`, `tests/unit/shared/utils/attendance.test.ts`, `tests/unit/attendance.service.test.ts`, `tests/integration/dashboard-actions.teachers.test.ts` : nouveaux cas et adaptation du mock de configuration.

Web :

- `src/modules/risk/risk.api.ts`, `components/RiskAlertRules.tsx` : paramètres de retards sans valeur implicite de nombre.
- `src/modules/dashboard/dashboard.api.ts`, `dashboard-action-notifications.ts`, `RiskDetailsPage.tsx`, `tabs/OverviewTab.tsx`, `src/App.tsx` : motifs, total unique, navigation et permission `teachers.view`.
- Tests `DashboardPage`, `RiskDetailsPage`, `dashboard.api`, `RiskAlertRules` et `e2e/critical/teacher-risk.spec.ts` : libellé, motifs, navigation, séparation des accès, configuration et parcours navigateur réel.

## Accessibilité depuis l’interface

La configuration est accessible depuis **Paramètres → Risques → Retards professeur**.

La liste existante est accessible depuis **Tableau de bord → Actions prioritaires → Professeurs à suivre**, ainsi que **Risques élèves et professeurs → Retards répétés**. Le lien ouvre directement l’onglet Professeurs sur les fenêtres glissantes utilisées pour l’action ; le filtre mensuel reste disponible pour une consultation historique.

Aucun nouvel écran ni menu n’a été créé. Un utilisateur disposant uniquement de `teachers.view` peut ouvrir la liste sans déclencher de requêtes élèves.

## Vérifications

Baselines avant modification : 46 tests unitaires API, 15 tests d’intégration risque/assiduité/dashboard-actions, 11 tests frontend.

Résultats après correction :

| Vérification | Résultat |
| --- | --- |
| Unitaires API risque, assiduité, géovalidation, dashboard-actions | 52 réussis |
| Intégration risque, assiduité, dashboard-actions et C13 | 17 réussis |
| Frontend dashboard et règles de risque | 30 réussis |
| Chromium tactile Android, 393 × 851, API et jobs réels | 1 réussi |
| TypeScript API et web | Réussi |
| ESLint des fichiers de production concernés et du scénario navigateur | Réussi |
| `git diff --check` API et web | Réussi |
| Rejeu des migrations et runner officiel sur deux tenants jetables | Réussi |

Le parcours d’intégration couvre configuration invalide/valide, pointage à la limite et au-delà, risque de retards seul, bornes temporelles, combinaison, compteur unique, désactivation, séparation des élèves, exclusion bloqué/inactif et régénération répétée.

La recette navigateur vérifie l’enregistrement avec toast, l’actualisation du dashboard après génération du job, le libellé, la navigation et le motif « Retards », sans débordement horizontal.

Les avertissements existants React Router, Recharts dans les tests DOM et `pg` étaient déjà présents dans les baselines. Aucune régression détectée dans le périmètre vérifié.

## Auto-revue des consignes standard

- Consignes standard lues intégralement, ainsi que `archives/AGENTS.md`, `DESIGN.md`, `PRODUCT.md`, `PROJECT.md`. Exploration du code réel effectuée avant implémentation ; l’absence de seuil de retards a été signalée et la décision produit obtenue.
- Toutes les modifications de projet sont limitées à `edutrack-api` et `edutrack-web` ; les changements préexistants ailleurs sont conservés.
- Architecture controller/service/repository respectée, accès DB tenant via Drizzle dans les repositories, aucun nouvel import intermodules backend, aucune nouvelle queue, aucun nouveau SMS/PDF/notification envoyé.
- TypeScript strict, aucun nouvel `any`, validation Zod et erreurs HTTP standard conservées, usage `userId` conservé, aucun secret ni détail personnel ajouté aux logs ou aux agrégats.
- Schéma déclaré et migrations générées par Drizzle Kit, rejouables et compatibles avec le runner de tous les tenants. Les migrations sont fournies pour le déploiement ; seule la base jetable de recette a été migrée pendant cette tâche.
- UI conforme aux composants et tokens existants : shadcn, TanStack Query, toast de mutation, états chargement/erreur/vide conservés, nouvelles commandes et liens de risque de 48 px minimum, aucun style inline/hex/composant natif ajouté, aucune modification visuelle de la barre latérale.
- Découvrabilité vérifiée depuis les écrans existants ; aucun nouvel écran sans route/menu.
- Tests de baseline, unitaires métier, intégration avec `tests/integration/setup.ts`, frontend et navigateur exécutés. Les quatre critères d’acceptation sont satisfaits.
- Résumé, décisions, fichiers, vérifications et message de commit fournis dans ce document.

Limite matérielle : Android a été testé par émulation Chromium tactile ; aucun appareil physique Tecno/Itel n’est disponible dans cet environnement. La suite globale hors périmètre et un déploiement production ne sont pas revendiqués.

## Message de commit proposé

`fix(risk): include configured teacher lateness in dashboard follow-up`
