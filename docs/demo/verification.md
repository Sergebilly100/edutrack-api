# Recette initiale du démarrage à vide — 24 septembre 2026

## Statut de ce document

Ce document est l'archive de la recette effectuée **avant** les corrections du parcours. Il conserve volontairement les réponses HTTP, captures et reproductions du 24 septembre ; ses constats ne décrivent donc pas l'état courant du produit.

L'état courant et les vérifications associées sont dans la [vérification des corrections du 26 septembre](corrections-verification.md). Ce second rapport distingue les décisions déjà appliquées des travaux restant réellement à faire.

| Décision discutée | État actuel | Référence détaillée |
| --- | --- | --- |
| Retirer les ajouts rapides de professeur, d'élève et de créneau de l'assistant | Appliqué. L'assistant dirige désormais vers les configurations et l'import initial des profils professeurs ; il ne crée plus ces contrats incomplets. | [Comparaison au plan](corrections-verification.md#comparaison-au-plan-approuvé) |
| Réserver l'ouverture de la première année au super administrateur | Règle métier conservée et expliquée dans l'assistant. Ce n'est plus un point de friction à corriger. | [Comparaison au plan](corrections-verification.md#comparaison-au-plan-approuvé) |
| Créer le premier EDT après les inscriptions et les affectations | Appliqué. Sans période, l'écran EDT redirige vers l'import contextualisé ; l'EDT ne fait plus partie de la configuration initiale. | [Comparaison au plan](corrections-verification.md#comparaison-au-plan-approuvé) |
| Corriger les remises, tolérances et caches financiers | Appliqué et couvert par des tests ciblés ; le recalcul est livré en mode simulation par défaut. | [B06 dans la comparaison](corrections-verification.md#comparaison-au-plan-approuvé) |
| Distinguer les professeurs à suivre des risques élèves | Appliqué pour les signaux d'absence enseignants ; le cas reposant uniquement sur les retards reste à préciser. | [B07 dans la comparaison](corrections-verification.md#comparaison-au-plan-approuvé) |
| Corriger le guide et le rendu mobile | Appliqué et vérifié par les tests ciblés et les viewports 320, 360 et 393 px. | [B04/B05 dans la comparaison](corrections-verification.md#comparaison-au-plan-approuvé) |

Les sections suivantes restent utiles comme preuve de la recette initiale, mais sont libellées explicitement comme historiques afin de ne pas être confondues avec le plan livré.

## Constat de la recette initiale et environnement

Le provisionnement des deux profils fonctionnait. Le parcours à vide avait été exécuté jusqu'à une inscription confirmée, un encaissement, une salle, un cours visible et la finalisation de l'onboarding. **À cette date, le parcours n'était pas exempt de bugs** : les trois saisies rapides de l'assistant étaient incompatibles avec les contrats API. Les corrections de ces constats sont documentées dans le rapport de suivi ; elles ne faisaient pas partie du livrable initial.

Recette sur Chromium local via Playwright, interface React et contrôleurs/services/PostgreSQL réels, sans simulation de réponses HTTP. Base séparée `edutrack_demo_validation_20260924`, tenant `school_demo_empty_browser`, créé avec le profil `empty`, et tenant d'authentification super administrateur distinct. API de recette sur 3101, frontend sur 5174 ; les processus utilisateur sur les ports habituels n'ont pas été remplacés. Les workers et les envois externes sont neutralisés dans le serveur de recette. Les formulaires, autorisations, imports et écritures métier utilisent le vrai code applicatif.

Contrôle complémentaire à 393 × 851 pixels. **Pas de téléphone physique Tecno/Itel ni de Chrome Android réel disponible** : le contrôle mobile est une émulation de viewport Chromium. SMS/email/push, rendu PDF en worker, GPS, caméra/QR et fonctionnement hors ligne ne sont pas validés par cette recette.

L'instance locale livrée `school_demo_empty` est restée vierge : le remplissage manuel a porté sur l'instance distincte de la base de validation.

## Étapes exécutées le 24 septembre — état historique avant corrections

| Étape | Navigation et saisie | Résultat observé |
| --- | --- | --- |
| 1 | Création `empty`, connexion du directeur | Redirection vers `/onboarding`, sans année, classe, professeur ou élève |
| 2 | Assistant → Infos école : nom, téléphone, adresse | Enregistrement accepté, passage à l'étape Professeurs |
| 3 | Assistant → ajout professeur : nom, matière, vacataire | `POST /api/v1/teachers` → **400 BAD_REQUEST** ; impossible de continuer sans professeur (B01) |
| 4 | Accès direct à `/academic/school-years` pour quitter le blocage | État vide explicite : l'année doit être ouverte par le super administrateur ; aucune erreur serveur |
| 5 | Académique → Niveaux : création de 3ème, classe d'examen | Création réussie. Classes affiche ensuite le besoin d'une année active |
| 6 | Autre session, Super admin → Écoles → école de recette → Cycle scolaire | Ouverture de `09/2026 - 06/2027`, du 01/09/2026 au 30/06/2027, trois trimestres : **201** |
| 7 | Académique → Classes, puis Matières | Création de `3ème A`, puis Mathématique, coefficient 4, rattachée au niveau : réussie |
| 8 | Vie scolaire → Professeurs → Ajouter | Le guide automatique recouvre le dialogue ouvert (B04). Rechargement puis fermeture du guide avant ouverture du formulaire |
| 9 | Formulaire complet professeur | Aminata Démo, email fictif, vacataire à 3 500 FCFA/h, matière et classe attribuées : **201** |
| 10 | Vie scolaire → Inscriptions → Nouvelle inscription | Aya Recette, matricule fictif, année et classe sélectionnées ; aucun document requis ; dossier créé et terminé |
| 11 | Inscriptions → Caisse, avant configuration des frais | **409 TUITION_PLAN_REQUIRED**, message expliquant le plan manquant ; aucune erreur silencieuse |
| 12 | Administration → Paramètres → Finance | Plan 300 000 FCFA, seuil du 01/09/2026 à 100 000 FCFA : enregistrement réussi |
| 13 | Retour Caisse | Versement espèces de 25 000 FCFA, référence `DEMO-CASH-001` : dossier **Confirmée** ; tableau financier : 25 % du cumul attendu, reste à date 75 000 FCFA |
| 14 | Vie scolaire → Salles & QR Codes | État vide lisible, puis création de Salle Démo 1, capacité 35 : réussie |
| 15 | Vie scolaire → Emploi du temps | Aucune période active ; Ajouter un créneau désactivé. Renvoi vers Import de données (F03) |
| 16 | Import → Emploi du temps | Fichier d'un cours fictif, période 28/09–04/10/2026, lundi 08:00–09:00 ; validation : **1 ligne valide, 0 erreur** |
| 17 | Confirmation de l'import puis semaine suivante | **1 enregistrement importé**, période et créneau créés ; Mathématique visible dans 3ème A ([capture](evidence/first-schedule.png)) |
| 18 | Retour `/onboarding`, actualisation des professeurs | Le professeur créé est reconnu, compteur 1, Continuer activé |
| 19 | Assistant → Élèves, saisie rapide | Koffi Assistant, classe 3ème A : `POST /api/v1/students` → **400 BAD_REQUEST** (B02). Passage à l'étape suivante autorisé |
| 20 | Assistant → Emploi du temps, saisie rapide | Professeur existant, 3ème A, mardi, 08:00–10:00 : `POST /api/v1/schedule` → **400 BAD_REQUEST** (B03) |
| 21 | Assistant → Continuer → Accéder au tableau de bord | Finalisation réussie après contournements ; tableau de bord fonctionnel, données saisies visibles |
| 22 | Tableau de bord et Inscriptions, viewport mobile | Inscriptions consultable ; plusieurs blocs du tableau de bord débordent et sont rognés (B05) |

Aucune erreur JavaScript non interceptée ni réponse HTTP 500 observée sur ces étapes. Le `401` de rafraîchissement sans cookie lors du premier chargement est suivi du formulaire de connexion normal ; ce n'est pas un blocage.

## Bugs reproduits avant corrections — état historique

### B01 — Ajout rapide professeur bloquant dans l'onboarding

- **Gravité : haute.** Nouveau directeur, étape 2, saisie d'un nom, d'une matière et du type vacataire, puis Ajouter le professeur.
- Attendu : création ou formulaire permettant de renseigner tous les champs obligatoires.
- Observé : `400 {"error":"Validation error","code":"BAD_REQUEST","statusCode":400}` ; Continuer reste désactivé, Passer cette étape est désactivé, aucun lien direct vers le formulaire complet.
- Cause confirmée par lecture : `OnboardingWizard.tsx` / `onboarding.api.ts` envoient `{name, subjects, type}`. `teachers.types.ts` exige notamment un contact et une rémunération selon le contrat ; le formulaire rapide n'offre pas ces champs.
- Contournement testé : ouvrir un écran hors assistant par URL, puis Vie scolaire → Professeurs ; créer via le formulaire complet ; revenir dans l'assistant et actualiser. Le professeur est bien reconnu.

### B02 — Ajout rapide élève rejeté

- **Gravité : moyenne**, étape facultative mais action annoncée non fonctionnelle.
- Étape 3 : prénom, nom, classe existante, Ajouter l'élève → **400 BAD_REQUEST**, toast générique « Validation error » ([capture](evidence/onboarding-student-400.png)).
- Cause : payload `{first_name, last_name, class_name}`, tandis que `students.types.ts` exige `class_id` UUID.
- Contournement testé : Vie scolaire → Inscriptions → Nouvelle inscription ; puis poursuivre l'assistant sans utiliser la saisie rapide.

### B03 — Ajout rapide créneau rejeté

- **Gravité : moyenne.** Étape 4, professeur existant, classe, jour et créneau proposés par l'assistant → **400 BAD_REQUEST**, toast générique.
- Cause : l'assistant envoie un nom de classe et un libellé de créneau. `schedule.schemas.ts` exige une période, les UUIDs de classe/salle, une matière et un créneau ou des heures explicites ; plusieurs champs sont absents du formulaire.
- Contournement testé : import Excel avec période explicite ; le cours est ensuite visible dans l'emploi du temps.

### B04 — Guide automatique superposé au dialogue professeur

- **Gravité : moyenne.** Première visite de Professeurs, ouvrir Ajouter avant le démarrage différé du guide.
- Observé : guide et formulaire ouverts simultanément ; les interactions avec le guide sont interceptées par la superposition du dialogue, le formulaire n'est plus utilisable normalement ([capture](evidence/tour-over-dialog.png)).
- Contournement testé : recharger, cliquer « Passer le tour » avant d'ouvrir Ajouter. Aucun changement CSS ou comportemental effectué ici.

### B05 — Tableau de bord rogné en largeur mobile

- **Gravité : moyenne.** Viewport 393 × 851, rechargement complet après finalisation de l'onboarding.
- Observé : carte de pilotage et actions larges d'environ **421 px**, portions de texte/graphique coupées à droite ([capture](evidence/mobile-dashboard.png)). `documentElement.scrollWidth` ne dépasse pas le viewport : un simple test de défilement horizontal ne détecte donc pas le contenu rogné.
- La reproduction est limitée à Chromium avec viewport mobile, à confirmer sur Tecno/Itel.

## Frictions et dépendances observées avant corrections — état historique

- **F01 — Ouverture de l'année réservée au super administrateur.** Constat de cadrage du 24 septembre : le code V2 refuse cette opération au directeur (`403` confirmé en intégration). La décision ultérieure a confirmé qu'il s'agit d'une règle métier, à préserver et à expliquer dans l'assistant, non d'un défaut.
- **F02 — Tarif à configurer avant passage en caisse.** Le `409` est utile et explicite, mais ne propose pas de lien vers Administration → Paramètres → Finance. L'utilisateur doit retrouver cet écran puis revenir au dossier. Le règlement fonctionne dès que le plan existe.
- **F03 — Première période d'emploi du temps peu découvrable.** L'écran demande de « créer une période », sans commande locale. Le bouton d'import conduit à un assistant initialement positionné sur Élèves ; il faut sélectionner Emploi du temps, fournir les dates et importer un fichier. Ce chemin crée correctement période, créneau horaire et cours.
- **F04 — Import intégré à l'assistant non contextualisé.** Les étapes Professeurs et Emploi du temps affichent toutes deux l'import initialement positionné sur Élèves. Le type doit être choisi manuellement, bien que l'étape annonce déjà ce qu'il faut importer.

## Anomalies métier révélées par le seed avant corrections — état historique

Ces points ne provenaient pas du provisionnement. B06 et B07 ont depuis été corrigés ; les reproductions ci-dessous sont conservées pour expliquer leur origine et leurs données de test.

- **B06 — Signe de la remise dans le cache financier.** Plan de 300 000 FCFA, remise positive de 30 000 FCFA : montant métier attendu 270 000 FCFA. `finance.service.ts` soustrait correctement la remise, mais `financial-cache.repository.ts` additionne `plan_total + discount_amount`. Lecture effective dans `school_demo_t3` : `total_due_year = 330000.00`. Les neuf familles remisées conservent des données source correctes et un échéancier individualisé ; le seed ne falsifie pas la remise pour masquer le bug. Corriger le calcul puis recalculer les caches dans une tâche dédiée.
- **B07 — Action « professeurs à risque » issue du compteur élèves.** Le job a réellement produit quatre types : `teacher_absences_high` (6 absences sur 7 jours), `validations_pending` (3 décisions), `student_at_risk` (6 élèves) et `teacher_at_risk` (« 3 prof(s) au niveau critique »). Or le calcul des risques enseignants identifie un seul professeur avec signal d'absences. `DashboardActionsService.generateAll` réutilise `countRiskByLevel()` basé sur `student_risk_status` pour cette carte. La liste des vrais risques enseignants reste alimentée séparément.

## Parents et périmètre d'accès observés le 24 septembre — état historique

Deux connexions réelles avaient été vérifiées par tests d'intégration : parent abonné et parent sans abonnement. Chacun pouvait se connecter et lister uniquement son enfant. À cette date, le statut d'abonnement était `200 active` pour le premier et `404 SUBSCRIPTION_NOT_FOUND` pour le second. Le contrat de statut a depuis été corrigé : il retourne explicitement l'absence d'abonnement et l'offre éventuelle de l'école ; voir le [rapport de suivi](corrections-verification.md#comparaison-au-plan-approuvé).

## Isolation et validation technique de la recette initiale

- Provisionnement réel par la nouvelle commande dans la base locale : `school_demo_t3` et `school_demo_empty`. Aucun tenant préexistant supprimé, réinitialisé ou ciblé par une mutation du script.
- Comparaison avant/après sur **579 tables préexistantes**, réparties entre le schéma public et neuf schémas scolaires. Les données scolaires et les lignes publiques préexistantes étaient inchangées lors du provisionnement. Une différence apparente des modèles SMS venait du filtre de comparaison `NOT IN` appliqué à des `tenant_id NULL` ; la lecture complète a confirmé une empreinte identique, sans correction de données.
- Une relecture ultérieure a relevé une évolution des jetons de rafraîchissement de `school_sainte_marie` dans l'environnement utilisateur resté actif. Elle n'était pas présente dans la comparaison immédiatement après les deux créations ; le script ne cible jamais cette table. Les empreintes sont une observation à un instant donné, pas un gel des processus locaux concurrents.
- Tests d'intégration : empreinte de toutes les lignes du tenant témoin avant/après, création vide, collision refusée, erreur tardive annulant schéma et registre, concurrence à un seul gagnant, seed complet, isolation JWT, connexions parents, régénération d'actions sans doublon ouvert.
- **553 tests unitaires passés** (50 fichiers), dont 23 nouveaux tests de garde et calendrier.
- **4 tests d'intégration du provisionnement passés** ; **29 tests d'intégration existants passés** après modifications (notes, conduite, bulletins, cache financier, risques, actions).
- TypeScript strict, lint des nouveaux scripts et build API : réussis. Aucun nouveau test UI n'a été ajouté ; cette tâche ne modifie pas le frontend.
- Réexécution réelle de `demo:create` avec `demo_t3` : refus `DEMO_ALREADY_EXISTS`, code de sortie 1, aucun remplacement. Fichiers d'accès contrôlés en `0600`, répertoire en `0700`.

Les traces détaillées de recette et identifiants restent dans les dossiers `.tmp` ignorés. Les quatre captures sélectionnées dans `evidence/` ne contiennent que les données fictives de la recette.

## Auto-revue et périmètre de livraison

- Consignes standard et références du projet lues ; exploration des modules réels avant implémentation. Les écarts avec le prompt (année ouverte par le super administrateur, accès parent de base autorisé, calendrier glissant) sont explicités.
- Modifications de cette tâche limitées à `edutrack-api` : commande/package, scripts sous `src/shared/database/demo`, tests, README et présent rapport. Aucune nouvelle page ni navigation à intégrer.
- Aucune migration inventée ni modification des migrations existantes ; réutilisation contrôlée des SQL Drizzle, exclusion des opérations publiques/globales. Réservation et transaction protègent les tenants existants.
- TypeScript sans `any` ajouté ; accès DB du code livré dans le repository ; orchestration dans `shared/database` utilisant les services métier, sans nouvel import entre modules métier.
- Aucun secret versionné, aucune donnée personnelle réelle dans les fixtures ou captures, aucun envoi de message ni traitement PDF synchrone, aucune nouvelle queue.
- Aucun correctif des bugs recensés. Les modifications parallèles déjà présentes dans `dashboard-actions.service.ts` et `TeachersPage.tsx` ont été laissées intactes et ne font pas partie de ce livrable.
- Aucune régression détectée par les vérifications exécutées. Les trois livrables fonctionnels sont réalisés ; la recette conclut à des bugs et fournit leur reproduction, sans prétendre que le parcours est sans erreur. La vérification sur appareil Android physique reste hors des moyens disponibles.

Message de commit proposé pour les seuls fichiers de cette tâche :

```text
feat(demo): provision isolated empty and early-T3 tenants
```
