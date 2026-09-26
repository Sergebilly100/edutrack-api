# Vérification des corrections du parcours école — 26 septembre 2026

**Conclusion : les corrections présentes ont été fiabilisées, mais le plan complet n’est pas terminé.** Les tests verts ci-dessous ne valident pas les fonctionnalités encore absentes. Ne pas présenter cette branche comme l’implémentation complète du nouveau parcours.

## Décisions du parcours déjà appliquées

Le rapport de recette initiale décrit le produit tel qu'il était avant les corrections. Les décisions ci-dessous ne doivent plus être signalées comme des frictions actuelles :

| Décision validée | Comportement livré | Limite réelle restante |
| --- | --- | --- |
| Assistant initial sans ajouts rapides | Les saisies rapides professeur, élève et créneau ont été retirées. L'assistant présente les prérequis, les liens de configuration et l'import des profils professeurs. | La validation de complétude et le retour guidé après chaque configuration restent à réaliser. |
| Première année par le super administrateur | L'ouverture de l'année reste une règle métier super administrateur et l'assistant l'explique. | L'assistant ne bloque pas encore sa finalisation si aucune année active n'existe. |
| Premier EDT après le parcours initial | L'EDT ne fait plus partie de l'onboarding. Sans période, son écran envoie directement vers l'import EDT contextualisé ; le premier import crée période technique et créneaux. | Les dates de l'import restent soumises aux règles de semaines de l'import existant. |
| Remises, tolérances et cache financier | Le dû est borné par le total ajusté ; les tolérances réduisent le reste sans gonfler les recettes ni les retards. Le recalcul contrôlé est versionné. | Le recalcul n'a pas été appliqué aux tenants réels pendant cette revue. |
| Risques enseignants | L'action « Professeurs à suivre » provient désormais des signaux d'absence enseignants, séparés des élèves à risque. | Les retards seuls ne sont pas encore intégrés à ce signal. |
| B04 et B05 | Le guide se ferme face à un dialogue, et les écrans contrôlés restent lisibles à 320, 360 et 393 px. | Les contrôles UI utilisent une API simulée et pas un téléphone Android réel. |

## Conditions de vérification

- Relecture des différences API/web, comparaison avec le plan approuvé et avec [la recette initiale](verification.md).
- Base PostgreSQL dédiée `edutrack_review_20260925`, créée vide puis initialisée depuis les migrations du dépôt. Aucun export de données de la base utilisateur.
- Tests API avec contrôleurs, services et PostgreSQL réels, sauf les suites historiques de contrats de permissions, d’administration et de planning qui simulent leurs dépendances.
- Tests Chromium avec serveur Vite dédié sur le port 5187 et **toutes les requêtes API simulées**. Ils valident le rendu et la navigation ; ils ne constituent pas une recette intégrale UI → API → base.
- Aucun tenant local existant n’a été supprimé ou modifié. Ni `db:migrate`, ni un seed global, ni le recalcul financier n’ont été exécutés sur la base utilisateur.
- La migration d’adresse est livrée et testée, mais n’est pas appliquée à la base locale utilisateur. Son application est un prérequis au déploiement du code qui lit cette colonne.

## Défauts corrigés pendant cette revue

| Défaut constaté | Correction et preuve |
|---|---|
| Le format `{ subscription, offer }` était envoyé par la route **EDT enfant**, alors que la route de statut renvoyait encore un objet brut ou `null`. | Restauration du contrat EDT ; enveloppe uniquement sur `/parent/subscription/status`. Offre lue dans le repository du tenant. Tests réels abonnement présent/absent, service désactivé, non monétisé ou tarif nul. |
| L’adresse des paramètres était validée puis omise lors du passage du contrôleur au service. | Transmission explicite de `address`. Vérification d’écriture/relecture onboarding, paramètres et administration, y compris création réelle d’une école et lecture de sa fiche. |
| Modifier le logo ou la politique QR d’une école sans adresse renvoyait une adresse vide rejetée par Zod. | Requêtes partielles sur les champs effectivement modifiés. La fiche super admin n’envoie plus un champ adresse vide non modifié. |
| Une erreur d’écriture des paramètres déclenchait un essai via un autre endpoint, y compris après un refus d’autorisation. | Repli limité au cas 404 ; un 403 reste un refus. Test frontend dédié. |
| La réponse d’écriture autorisée par `settings.school` renvoyait aussi les postes et utilisateurs administratifs. | Réponse limitée à l’école ; ces listes ne sont plus chargées par cette mutation. La séparation complète des **lectures** reste à faire. |
| La migration `0073` faisait échouer tous les nouveaux provisionnements de démo avec `DEMO_MIGRATION_REVIEW_REQUIRED`. | Migration publique relue et empreinte ajoutée au manifeste. Elle reste exclue du SQL exécuté sur les autres tenants par le provisionneur. Tests `empty`, `seeded`, collision, concurrence et rollback passent. |
| L’import EDT exécutait du SQL de contrôle dans le service, après une prévisualisation qui ne vérifiait pas les affectations. | Contrôle au repository et validation avant confirmation : professeur actif, non bloqué, association existante, classe active de l’année active. Nouvelle lecture des associations dans la transaction de confirmation. |
| Une erreur d’import pouvait laisser une période EDT créée sans ses cours. | Création de période déplacée dans la transaction des créneaux et de l’historique. Une erreur injectée après création de période prouve le rollback complet. |
| Un professeur sans affectation provoquait une erreur HTTP 500 en création manuelle. | Réponse 400 `TEACHER_ASSIGNMENT_REQUIRED`. Refus des comptes inactifs et classes hors année active ; conservation de `TEACHER_BLOCKED`. |
| Les variantes de noms de matières, par exemple Mathématiques/Mathématique, pouvaient invalider une association existante. | Comparaison avec la normalisation de matières déjà utilisée dans le produit. |
| Le réimport d’un professeur existant avait un `UPDATE users` sans `SET` (défaut antérieur aux corrections). | SQL corrigé et mise à jour réelle du profil/contrat testée. Cela ne remplace pas le nouvel import de profils demandé. |
| B07 était « corrigé » en supprimant toutes les actions enseignants, tout en les comptant encore dans le résultat. | Génération depuis `teacher_risk_status.absences_signal`, indépendante des risques élèves ; compteur corrigé et libellé « Professeurs à suivre ». La prise en compte dédiée des retards reste à spécifier/implémenter. |
| Après remise ou montant personnalisé, le cache pouvait attendre davantage que le total dû ; les élèves sous tolérance étaient comptés dans les retards agrégés. | Attendu borné au total annuel ajusté ; seules les lignes `late` alimentent le compteur de retards. `total_paid` reste constitué des seuls encaissements confirmés. |
| Le script de recalcul était placé dans `scripts/`, dossier ignoré par Git, et exécutait immédiatement tous les tenants actifs. | Script versionné dans `src/shared/database`, périmètre explicite, simulation par défaut, option `--apply`, transaction par école et fermeture des connexions. |
| Le paramètre `?type=schedule` replaçait l’import sur EDT à chaque rendu, même après un changement d’onglet. | Liste des types autorisés stabilisée. Changement d’onglet testé dans Chromium. |
| `/settings?tab=finance` n’était pas interprété ; le bouton de configuration des frais ouvrait le mauvais onglet. | Paramètre d’onglet pris en charge et validé selon les droits. Test navigateur. Le retour au paiement reste à implémenter. |
| B04 ne couvrait ni les dialogues d’alerte, ni certains redémarrages différés du guide. | Annulation des timers, fermeture du guide sans complétion, prise en compte des dialogues déjà ouverts, des alertes et du démontage. Cinq tests ciblés. |
| `payments.cancel` n’avait pas de case propre dans la matrice ; `attendance.view` était affiché deux fois. | Case d’annulation de paiement ajoutée, doublon supprimé, modèles SMS désactivés visuellement quand indisponibles. Le catalogue dynamique reste à faire. |

## Comparaison au plan approuvé

| Point | État après revue | Travail restant / observation |
|---|---|---|
| Adresse en base, onboarding, paramètres, création/fiche super admin | Vérifié côté API et contrats UI | Migration non appliquée aux bases existantes. Pas de recette navigateur complète de ces trois formulaires. |
| Première année ouverte par super admin | Règle préservée | Le texte de l’assistant explique cette dépendance. L’assistant ne vérifie pas qu’une année active existe avant de permettre sa finalisation. |
| Retrait des trois ajouts rapides B01/B02/B03 et de l’EDT initial | Présent | Les nouveaux liens de configuration ne constituent pas une validation de complétude ; les étapes peuvent être sautées. |
| Niveaux, matières, salles, frais avant les données massives | Partiel | Étapes présentes, mais absence de vérification des dépendances et de retour guidé après configuration dans un autre écran. |
| Profil historique élève sans classe ni inscription active | **Absent — bloquant** | `students.class_id` reste `NOT NULL`. L’import exige une classe et peut provisionner des parents. Aucune migration ni mode historique dédié. |
| Choix historique / reprise en cours d’année | **Absent** | Le choix n’est pas proposé par le nouvel assistant. |
| Reprise support avec inscriptions et paiements rapprochés | **Incomplet — bloquant** | Le parcours support existe, mais l’import des élèves écrit directement dans `students`, sans créer d’inscription. L’import des paiements impose `method: 'cash'`, la date du jour et ne conserve pas la référence importée. |
| Création atomique de classe à la première inscription, y compris import | **Absente — bloquant** | Le contrat d’inscription exige encore un `classId` existant. |
| Import initial professeur limité au profil/contrat | **Partiel** | Les matières ne sont plus obligatoires dans la validation, mais la colonne `Matières*` reste lue et peut modifier `teachers.subjects`. Modèle Excel, prévisualisation et comportement de réimport à aligner. |
| Import distinct `Matricule / Matière / Classes` | **Absent — bloquant** | Aucun type d’import pédagogique dédié avec validation ligne par ligne des dépendances et doublons. |
| Formulaire professeur avec blocs matière + plusieurs classes | **Absent — bloquant** | Le formulaire sélectionne globalement matières et classes, puis fait les associations par niveau. Il ne permet pas d’exprimer les groupes indépendants convenus. |
| Interdiction de planifier un professeur bloqué ou non affecté | Vérifiée sur les chemins de création/import contrôlés | Ne pas confondre ces gardes avec l’implémentation du parcours d’affectation. Une revue des autres chemins de copie/duplication de période reste nécessaire. |
| Pas de création implicite d’affectations par l’EDT | Présent et testé sur l’import | Le test conserve exactement l’association créée avant l’import. |
| Rappel des classes sans professeur principal | Non identifié dans le nouveau parcours | Ajouter le rappel non bloquant après affectation. |
| Premier EDT : redirection directe vers import contextualisé | Vérifié dans Chromium | Accès conditionné à `import.schedule`. La création manuelle reste indisponible sans période. |
| Période technique + créneaux dans une transaction | Vérifié en PostgreSQL | Les dates restent présentées sous forme de semaines lundi/dimanche par l’import existant ; à revoir si des dates d’application arbitraires sont attendues. |
| B06 : remise, montant personnalisé, échéancier, tolérance | Cache et statut individuel couverts par les tests ciblés | Total du plan moins remise, montant personnalisé prioritaire, échéancier individuel prioritaire, bornage à zéro, séparation recettes/tolérances. Le statut individuel hors cache applique aussi le plafond au dû ajusté. |
| Recalcul contrôlé des caches après déploiement | Commande livrée, non exécutée sur les tenants réels | À effectuer après déploiement avec un périmètre explicite. |
| F02 : aide contextualisée puis retour au paiement | **Partiel** | Code reconnu, message sans droits et lien Finance présents. Année/niveau concernés et retour automatique au dossier après enregistrement absents. |
| B07 : risques enseignants distincts des élèves | Corrigé pour les signaux d’absence existants | Les règles actuelles de risque enseignant comptent les absences. Le scénario reposant uniquement sur les retards n’est pas couvert. |
| B04 : dialogue prioritaire sur le guide | Tests unitaires positifs | Pas de recette E2E réelle de cette interaction effectuée dans cette revue. |
| B05 : mobile 320/360/393 | Contrôles Chromium positifs | API simulée, contrôle du débordement document + conteneur principal ; pas de test sur téléphone Android physique. |
| Statut parent explicite, offre tarifaire conditionnelle | API vérifiée | Abonnement actif et absence d’abonnement restent accessibles ; offre cachée si indisponible. Cartes dashboard/compte présentes, pas de nouveau test E2E dédié à ces cartes. |
| Matrice issue du seul catalogue backend | **Non réalisé** | Les groupes restent définis statiquement dans `RoleMatrix.tsx`. Aucun contrat distribuant `PERMISSION_KEYS` à l’interface ni test d’exhaustivité croisée. |
| Droits de présence sauvegardés, unicité `conduct.finalize` | Préservés dans les chemins inspectés | Ancien filtrage frontend supprimé ; contrainte d’exclusivité backend conservée. Matrice complète à recetter avec les droits de services activés/désactivés. |
| Lecture école distincte des postes | **Partiel** | L’écriture ne divulgue plus les postes/utilisateurs. La lecture frontend essaie encore `/permissions/config`, puis utilise des replis après 403/404. |
| Dépendances SMS/abonnements dans la matrice | **Partiel** | Les catégories abonnement sont encore masquées selon la monétisation ; activation du service et explication des dépendances à aligner avec le backend. |
| Provisionnement démo isolé | Vérifié | Empreintes du tenant préexistant de test identiques, création répétable sous de nouveaux noms, collisions refusées sans écriture. |

## Écarts prioritaires : sources et solutions attendues

1. **Historique et inscription.** [Schéma élève](../../src/shared/database/schema/tenant.schema.ts), [contrat inscription](../../src/modules/enrollments/enrollments.types.ts), [import élève](../../src/modules/import-export/import.repository.ts). Découpler profil/classe, introduire le mode historique sans inscription, puis créer la classe avec l’inscription dans une même transaction. Tester l’absence d’écritures financières sur l’historique.
2. **Reprise en cours d’année.** [Service de reprise](../../src/modules/finance/midyear-import.service.ts). Créer les inscriptions actives et rapprocher les paiements de ces inscriptions. Transporter et valider les colonnes montant/date/référence/moyen jusqu’à l’écriture, sans valeurs de remplacement silencieuses. La reprise actuelle ne doit pas être considérée conforme au plan.
3. **Affectations professeur.** [Formulaire actuel](../../../edutrack-web/src/modules/teachers/components/TeacherForm.tsx), [import actuel](../../src/modules/import-export/import.service.ts). Séparer import de profils et import d’affectations ; remplacer la sélection globale par les blocs demandés ; vérifier doublons, statut, année et cohérence de niveau ; signaler les professeurs principaux manquants.
4. **F02.** [Paiement inscription](../../../edutrack-web/src/modules/enrollments/EnrollmentPaymentPage.tsx). Transmettre année/niveau et URL du dossier aux frais ; au succès, invalider le résumé financier puis revenir au paiement. Le lien d’onglet seul ne termine pas le parcours.
5. **Permissions.** [Catalogue backend](../../src/modules/permissions/permissions.types.ts), [matrice](../../../edutrack-web/src/modules/settings/components/RoleMatrix.tsx). Exposer le catalogue, rendre chaque action à partir de celui-ci, expliciter les dépendances et séparer la lecture école/postes. Tester chaque permission et le refus des permissions conditionnelles indisponibles.
6. **Assistant initial.** [Assistant](../../../edutrack-web/src/modules/onboarding/OnboardingWizard.tsx). Valider l’état des étapes et organiser le retour depuis leurs écrans. Versionner et isoler par école la clé de progression : `onboarding_progress` reste globale, et un ancien brouillon peut être réutilisé pour une autre école.

## Tests et résultats

Avant correction : **6 échecs unitaires API** (manifeste démo et confirmation EDT), puis **6 échecs sur 17 tests d’intégration parent/démo**. Les 384 tests frontend alors présents étaient verts : ils ne couvraient pas ces régressions API.

Après correction :

| Contrôle | Résultat |
|---|---|
| API `npm run test:unit -- --run` | 554/554, 50 fichiers |
| Web `npm test` | 392/392, 82 fichiers |
| Intégration ciblée | 89 tests validés sur 8 fichiers : parent-auth, demo.provisioning, configuration-review, financial-cache, permissions, schedule.blocked-teacher, schedule.routes, admin.v3.routes |
| Chromium `playwright.review.config.ts` | 6 scénarios validés : 3 largeurs mobile, changement du type d’import, lien Finance, redirection premier EDT. Le scénario EDT a été rejoué après correction de sa fixture HTTP, initialement au format normalisé frontend au lieu du contrat API. |
| API build / web builds développement et production | Réussis ; avertissement Vite sur un chunk vendor dépassant 500 ko non compressés |
| API/web typecheck | Réussis ; le build web exécute également `tsc -b` |
| API/web lint complet | Réussis |
| `git diff --check` | Réussi |
| CLI de recalcul | Aide accessible ; absence de périmètre refusée avant connexion à la base |

Les 89 tests d’intégration sont le total des huit suites ciblées, avec six cas dans `configuration-review.routes.test.ts` après ajout du test de création réelle. Ce n’est pas la suite d’intégration complète du dépôt. La recette intégrale du parcours cible reste impossible à valider tant que les fonctions signalées absentes ne sont pas implémentées.

## Recalcul des caches à préparer pour le déploiement

Depuis `edutrack-api` ; ces commandes utilisent le `DATABASE_URL` de l’environnement :

```sh
# Consultation du périmètre ; aucune écriture par défaut
npm run finance:recalculate-caches -- --schema=school_demo_t3
npm run finance:recalculate-caches -- --all-active

# Exécution explicite sur un périmètre choisi, après migration/déploiement
npm run finance:recalculate-caches -- --schema=school_demo_t3 --apply
# Pour l’opération de déploiement autorisée sur toutes les écoles actives :
npm run finance:recalculate-caches -- --all-active --apply
```

Le script modifie les caches dérivés, pas les paiements ni les remises. Une transaction par école évite un cache partiellement reconstruit pour cette école ; l’opération ne constitue pas une transaction globale entre écoles. Aucun de ces recalculs n’a été appliqué aux tenants utilisateur pendant la revue.

## Auto-revue

- Contrôles métier de planning replacés dans le repository/service ; pas de SQL d’offre SMS dans le contrôleur parent.
- Pas de nouvelle dépendance npm, pas de modification des données métier utilisateur, pas de SMS ou courriel envoyé par la recette.
- Migration publique additive et idempotente ; manifeste de démo mis à jour sans ouvrir son périmètre SQL.
- Tests ajoutés sur les défauts constatés et leurs effets observables, notamment l’annulation transactionnelle EDT, la persistance de l’adresse, les tolérances, les remises, le guide et les refus d’autorisation.
- Les fixtures existantes ont été adaptées aux prérequis d’affectation ; les mocks de permissions sont réinitialisés entre tests pour éviter les réponses résiduelles.
- Les six écarts prioritaires ci-dessus restent ouverts. Aucune validation générale ni mise en production n’est annoncée.

Message de commit proposé pour **les corrections de revue uniquement** :

```text
fix: fiabiliser les corrections du parcours école et leur recette
```
