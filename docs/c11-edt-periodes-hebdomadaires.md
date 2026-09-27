# C11 — Import EDT et périodes hebdomadaires complètes

## Résultat

L’import EDT exige deux dates explicites : un lundi et un dimanche, dans cet ordre. Les dates impossibles, incomplètes et les formats non ISO sont refusés au dry-run et à la confirmation. L’API ne se replie plus sur une période active lorsque les dates sont absentes. Les créations, duplications et modifications des bornes de périodes suivent aussi la règle. Une modification partielle vérifie les bornes résultantes avec celles déjà enregistrées, dans une transaction sérialisable.

Le formulaire présente uniquement « Du lundi » et « Au dimanche ». Les deux champs sont initialement vides. Aucun nom de période ni fin d’année scolaire n’est proposé. Le sélecteur natif est conservé ; les erreurs précises s’affichent dès la sélection et sont reliées aux champs par `aria-invalid` et `aria-describedby`, avec `role="alert"`. Les champs ont une hauteur tactile de 48 px. Une borne incohérente reste visible pour être corrigée.

L’aperçu avant confirmation affiche les deux dates en français, le nombre de semaines complètes et le nombre de créneaux hebdomadaires validés par le serveur. Ce dernier réutilise `report.valid` ; aucun calcul de lignes ou d’occurrences n’est dupliqué. Les avertissements sur les occurrences passées et la reconnaissance des chevauchements conservent leur fonctionnement. Un brouillon ancien portant une période partielle ne peut pas être confirmé.

La période technique conserve le libellé généré existant : `Import EDT YYYY-MM-DD - YYYY-MM-DD`. Les créneaux et l’historique restent dans la même transaction, désormais sérialisable. Les chevauchements sont revérifiés dans cette transaction, avec la reconnaissance explicite existante. Les affectations sont également relues dans la transaction : professeur actif, non bloqué, association exacte matière–classe, classe active et année active, avec cohérence du niveau. Aucun import EDT ne crée d’affectation.

## Navigation et calendrier

Aucun nouvel écran ni item de menu n’a été créé. L’écran EDT reste accessible depuis **Vie scolaire → Emploi du temps**. Sans période applicable, l’action principale **Importer l’EDT** ouvre directement `/import?type=schedule` ; l’ajout manuel reste indisponible. Après import, la sélection d’une semaine couverte permet les ajouts manuels selon les droits existants. L’import reste aussi accessible depuis **Administration → Import de données**. L’EDT reste hors de la configuration initiale.

**Écart constaté et signalé :** le code existant autorise les créneaux uniquement du lundi au samedi et exclut explicitement le dimanche dans l’API, la résolution des cours et la grille. La consigne de ne pas modifier le calendrier scolaire est respectée : les périodes incluent le dimanche, mais les jours d’enseignement restent inchangés. Les tests vérifient chacun des six jours d’enseignement sur deux semaines complètes. La question posée sur l’inclusion de créneaux le dimanche reste sans réponse au moment de cette recette ; ce septième jour n’est donc pas certifié comme disponible. Une décision explicite est nécessaire si le critère « chacun des jours » doit également inclure le dimanche.

Les nouvelles bornes ne peuvent pas débuter en milieu de semaine ; le formulaire précise qu’un changement prend effet au lundi suivant. Les dates du calendrier scolaire et les mécanismes existants de cours ponctuels ne sont pas modifiés. Les périodes historiques stockées ne sont pas migrées automatiquement ; si leurs dates sont modifiées, les bornes résultantes doivent être complètes.

## Fichiers

| Zone | Fichiers |
|---|---|
| Validation API | nouveau `src/shared/utils/schedule-period.ts` ; `src/modules/schedule/schedule.schemas.ts`, `schedule.service.ts`, `schedule.controller.ts` |
| Import API | `src/modules/import-export/import.service.ts`, `import.repository.ts` |
| Formulaire | `src/modules/import-export/ImportWizard.tsx` ; nouveau `schedule-period.ts` ; `src/shared/components/DateInput.tsx` |
| Tests API | nouveaux `tests/unit/schedule-period.test.ts`, `tests/integration/schedule-import.weeks.test.ts` ; adaptation de `tests/unit/import.service.test.ts`, `schedule.service.test.ts`, `tests/integration/schedule.routes.test.ts`, `qa.school-workflows.routes.test.ts` |
| Tests frontend | nouveau `src/modules/import-export/__tests__/schedule-period.test.ts` ; adaptation de `ImportWizard.test.tsx` |
| Navigateur | nouveau `e2e/critical/schedule-import-weeks.spec.ts` ; adaptation de `teacher-assignments.spec.ts` |

La logique de dates est isolée des composants. La validation API est partagée entre modules via `shared/`. Aucun schéma, paquet ni migration n’a été ajouté. Les changements indépendants en cours dans les fichiers de professeurs et leurs assertions ont été conservés. Dans `SchedulePage.tsx`, seuls deux espaces résiduels sur des lignes vides ont été nettoyés à la revue ; le déplacement du rappel de couverture effectué en parallèle a été conservé.

## Recette et auto-revue

Avant modification : **64 tests unitaires API** et **43 tests frontend** ciblés passaient. Les premiers tests d’intégration ne pouvaient pas démarrer sans `DATABASE_URL_TEST` ; un cluster PostgreSQL 17 et Redis dédiés ont ensuite été créés selon la recette existante, sans utiliser la base de développement.

Validation finale :

- API : **659/659 tests unitaires**, **442/442 tests d’intégration**.
- Frontend : **524/524 tests** ; y compris restauration d’un aperçu ancien avec des bornes partielles.
- Navigateur : **5/5 parcours C10/C11 réels** ; les deux parcours C11 couvrent Android émulé et bureau, incluant l’ajout manuel du samedi et sa lecture persistée.
- Builds TypeScript/API et frontend/PWA : réussis. Lints des deux projets : réussis. `git diff --check` : réussi.

Les tests d’intégration C11 utilisent les vrais endpoints et PostgreSQL. Ils couvrent le premier import sans période, l’aperçu sans écriture, la confirmation, les ajouts manuels sur douze dates couvertes, les bornes invalides même avec reconnaissance des conflits, les chevauchements, les professeurs bloqués/inactifs/non affectés après aperçu, la relecture des affectations dans la transaction, les modifications partielles et le rollback après l’insertion effective de l’historique. Les comptages vérifient explicitement l’absence d’affectation implicite et d’orphelins.

La recette navigateur C10 a révélé une fixture devenue incohérente avec la fermeture des imports initiaux : l’école partagée était déjà configurée, donc son import initial professeur retournait 403 avant le parcours EDT. Le test prépare maintenant uniquement l’école jetable authentifiée en phase initiale pour cet import, puis restaure sa valeur antérieure dans un `finally`. Le test attend également le formulaire EDT directement affiché dans l’import courant, au lieu d’un ancien bouton de sélection devenu absent. Aucune restriction produit n’a été assouplie. Les anciens scénarios nominaux de duplication ont aussi été adaptés à des dates lundi–dimanche.

Auto-revue : périmètre limité aux deux projets autorisés ; code existant et documents standard lus ; aucune nouvelle logique métier ou requête DB dans les contrôleurs ; pas de nouvel import croisé entre modules ; erreurs `{ error, code, statusCode }` et routes `/api/v1/` conservées ; `request.user.userId` conservé ; aucun schéma, secret, log personnel, envoi SMS/PDF, queue ou canal de notification ajouté ; composants shadcn et tokens DESIGN conservés ; aucun changement visuel du menu ; états de chargement/erreur/confirmation et toasts conservés ; validations sensibles testées isolément, chemin critique testé en intégration et navigateur. Aucun échec des suites unitaires, d’intégration, frontend et navigateur finales ; aucune régression détectée dans le périmètre validé. Le périmètre des périodes et des jours d’enseignement existants est accompli ; l’ambiguïté sur les créneaux du dimanche reste explicitement documentée ci-dessus.

Limites : Chromium à 393 × 851 avec touch/mobile et à 1280 × 900 ; aucun Tecno/Itel physique disponible. L’avertissement préexistant sur la taille des chunks frontend et la dépréciation des requêtes parallèles du client PostgreSQL restent présents. Aucun environnement de production n’a été modifié.

Message de commit proposé : `fix(schedule): imposer des périodes EDT complètes du lundi au dimanche`.
