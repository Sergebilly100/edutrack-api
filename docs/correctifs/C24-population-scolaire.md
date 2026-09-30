# C24 — population scolaire confirmée

`confirmedSchoolStudent` (`src/shared/database/confirmed-school-membership.ts`) est le contrat SQL commun aux requêtes scolaires et au périmètre financier C19. Le couple élève, année et classe n'est éligible que si le profil est actif, l'inscription est `confirmed`, la classe appartient à l'année et elle est active. Le prédicat `EXISTS` empêche un double comptage si des lignes héritées se répètent.

La vue `students_with_class` reste un outil de lecture des profils et dossiers historiques. Elle ne constitue jamais une preuve d'appartenance pour les classes, notes, bulletins, conduite, présences, décisions, risques, abonnements ou portail parent. Les listes et fiches d'inscription, pièces et paiements continuent à afficher un dossier en attente par son identifiant.

Les ajustements individuels de **Paramètres > Finance** transmettent `school_year_id` à `/students/financial-profiles` et ne proposent que les élèves inscrits confirmés pour l'année. **Encaissements > Enregistrement** utilise `/students/cashier-candidates`, accessible avec `payments.record` et limité aux données nécessaires à la caisse. Cette recherche ajoute les réinscriptions bloquées pour impayé avec l'année de la dette antérieure, à laquelle le paiement est affecté. Une fois cette dette soldée, le paiement manuel fait passer le dossier à `pending_cashier`. Sans `school_year_id`, la recherche de dossiers financiers reste large pour le suivi historique. Le paiement qui confirme une inscription en attente reste dans le parcours d'inscription ; les plans de frais par niveau restent configurables avant l'arrivée des élèves.

Une réinscription `blocked_unpaid` sans inscription confirmée dans une année antérieure ne peut pas être proposée comme dette encaissable : l'année d'affectation du règlement est inconnue et l'API des paiements refuse un versement sans inscription confirmée. Le dossier doit être vérifié et régularisé à partir des pièces de l'école ; un paiement isolé ou la classe conservée sur le profil ne prouve pas une inscription antérieure.

Les bulletins déjà publiés restent consultables dans les archives si leur ancienne classe a été désactivée : leur lecture exige toujours l'inscription confirmée dans la classe et l'année du bulletin, sans imposer que cette classe soit encore active.

La confirmation du paiement valide l'inscription et recalcule le cache financier dans une transaction. Elle invalide aussi les moyennes de la nouvelle année et l'état de risque dérivés de l'élève dans cette même transaction. Les notes, présences, documents et inscriptions sources sont conservés. La page de confirmation invalide les caches de requête des écrans concernés.

## Diagnostic préalable à une reprise

Depuis `edutrack-api`, utiliser `npm run population:diagnose -- --schema=school_nom` ou `--all-active`. La commande ouvre une transaction `READ ONLY` par tenant et affiche, par année, les profils actifs ayant une classe historique, les inscriptions par statut, l'effectif attendu, les sources pédagogiques hors portée et les lignes dérivées hors portée (moyennes, bulletins, décisions, présences, conduite, risque, liens parents et cache financier). Elle ne modifie rien. Examiner les identifiants et les preuves métier avant toute confirmation de dossier ; ne jamais déduire `confirmed` d'une ancienne classe ou d'un cache.

Les index existants `enrollments_student_year_unique` et `idx_enrollments_year_status` couvrent déjà les recherches par élève/année et année/statut. Aucun nouvel index n'a été ajouté sans plan `EXPLAIN (ANALYZE, BUFFERS)` sur une base de test représentative. Comparer le plan et les temps des listes, du dashboard et des bulletins avant d'ajouter un index `(school_year_id, class_id, status, student_id)` avec Drizzle Kit si nécessaire.

La recette d'intégration exige `DATABASE_URL_TEST` vers une base jetable provisionnée. Les tests C24 couvrent les quatre statuts, le profil V1, le tableau de bord, les classes, les risques, les abonnements, les bulletins et l'invalidation à la confirmation. Le module Paramètres n'effectue aucun chargement d'effectif ou de liste d'élèves.
