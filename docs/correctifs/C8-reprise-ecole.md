# C8 — Reprise d’une école en cours d’année

## Parcours livré

L’écran est accessible depuis **menu super administrateur → Écoles → Voir détail → Reprise de données**, à côté de **Cycle scolaire**, pour une école dont la reprise est activée par le super administrateur. La fiche identifie explicitement l’école ; l’opérateur doit sélectionner son année active. Le directeur ne voit pas ce parcours dans le menu ou l’onboarding, ne charge aucune API d’école super administrateur en ouvrant son URL et reçoit un refus sur toutes les routes d’import.

Chaque fichier suit le parcours : analyse des colonnes → correspondances enregistrées → aperçu → acceptation de l’impact → confirmation. Les changements de fichier, de type, d’année ou de correspondances invalident l’aperçu. Les chargements sont visibles, les mutations produisent un toast et les erreurs proposent une reprise. Les listes vides affichent un état explicite et les tableaux restent dans leur conteneur défilant sur mobile.

## Règles et décisions

- Les profils historiques sont réutilisés seulement si le matricule et l’identité concordent. Les rattachements ambigus, profils inactifs, niveaux inconnus, classes incompatibles et inscriptions concurrentes sont signalés par ligne. Toutes les occurrences d’un doublon sont rejetées.
- Pour les seules lignes valides, les classes manquantes sont créées à la confirmation, une seule fois par libellé normalisé. Les inscriptions sont confirmées dans la classe et l’année sélectionnées. Le champ historique `students.class_id` ne sert pas de rattachement et n’est pas réécrit.
- Les paiements nécessitent une inscription confirmée unique et un plan de frais du niveau dans l’année. Le montant est validé sans arrondi, la date effective est conservée (formats ISO, français et Excel), la référence reste exacte, espaces inclus. Les dates hors année et les moyens inconnus sont des erreurs.
- Les codes financiers existants sont `cash`, `mobile_money`, `bank_transfer`. Un libellé école tel que « Orange Money » exige une traduction explicite. Aucune traduction de montant, date, référence ou matricule n’est autorisée, y compris dans un ancien profil de mapping enregistré.
- Un paiement porte le statut `confirmed` et la source existante `migration_import`. Le rapprochement utilise l’inscription confirmée et la paire élève/année utilisée par le modèle financier actuel. Les caches élève/école sont recalculés dans la transaction. Le journal de caisse existant exclut cette source : la reprise ne simule pas un encaissement nouveau.
- Une référence déjà importée est réutilisée uniquement si tous les champs financiers et l’élève concordent. Une référence différente en contenu est rejetée. Un nouvel aperçu permet une relance idempotente.
- La confirmation régénère un jeton HMAC lié au fichier, au mapping, à l’année, aux dépendances et à l’impact. Toute modification rend l’aperçu périmé. Une transaction sérialisable, un verrou de reprise et un verrou d’inscription empêchent les doubles écritures ; une erreur tardive annule profils, classes, inscriptions, paiements et caches.
- L’audit public enregistre l’UUID réel du super administrateur, l’école, l’année, le type et les compteurs. Les erreurs PostgreSQL brutes ne sont ni renvoyées ni journalisées. Le détail personnel du fichier ne figure pas dans cet audit.
- Les affectations professeurs restent une étape distincte : leur absence est visible dans l’aperçu et doit être traitée avant l’import d’emploi du temps. Elles ne bloquent pas la reprise élèves/paiements. Aucun contournement ni implémentation du futur import C10 n’est ajouté.

## API et migration

Les routes existantes `/api/v1/admin/schools/:tenantId/midyear-import/:importType` conservent leurs contrôles d’authentification et de rôle. Les types sont `levels`, `subjects`, `rooms`, `classes`, `students`, `payments`.

`POST /analyze`, `POST /preview` et `POST /confirm` reçoivent un fichier multipart et le paramètre obligatoire `school_year_id`. La confirmation exige également `preview_token` (64 caractères hexadécimaux). `GET /profile` et `PUT /profile` conservent le moteur partagé de correspondances. Un conflit renvoie le format standard `{ error, code, statusCode }`.

La migration idempotente **0075_midyear_mapping_platform_actor**, créée via Drizzle Kit en mode custom, supprime uniquement la contrainte qui obligeait l’auteur d’un mapping à être un utilisateur de l’école cible. Son UUID reste obligatoire : un administrateur plateforme peut appartenir à un autre tenant. Les autres contraintes sont conservées. La migration, son journal/snapshot et le manifeste de migrations démo sont livrés ensemble. Le test exécute la migration deux fois et vérifie un auteur extérieur à l’école.

Au déploiement, appliquer la procédure existante à **tous les tenants** avec `npm run db:migrate` depuis `edutrack-api`, avec la configuration de la base cible. Aucune base de production n’a été modifiée pendant ce correctif.

## Fichiers principaux

API : service et nouveau repository `src/modules/finance/midyear-import.*`, repository de résolution d’école `src/modules/admin/midyear-target.repository.ts`, contrôleur admin, composition dans `src/server.ts`, contrat partagé `src/shared/import-mapping/midyear.types.ts`, schéma/migration/manifeste, tests unitaires et d’intégration C8, adaptation des fixtures API/navigateur et du test existant de reprise.

Frontend : `AdminSchoolDetailPage.tsx`, `admin.api.ts`, `components/MidyearImportPanel.tsx`, tests du panneau et `e2e/critical/midyear-recovery.spec.ts`.

## Validation et auto-revue

- API : suite unitaire complète, 53 fichiers / 606 tests ; suite d’intégration concernée, 9 fichiers / 71 tests. Accès admin/directeur, aperçu, C7, création/réutilisation, fidélité financière, caisse, caches, erreurs tardives (y compris sauvegarde du mapping) et confirmations simultanées sont couverts.
- Frontend : suite complète, 86 fichiers / 446 tests, avec quatre workers ; 3 scénarios Playwright contre l’API réelle et PostgreSQL, depuis le menu Écoles jusqu’à la confirmation, ainsi que le refus directeur. Formats Android 393 × 851 et bureau 1280 × 900, sans débordement de page.
- Lint, vérification TypeScript, builds et `git diff --check` passent pour les deux projets. La migration est idempotente dans la base QA jetable. Les contrôles de configuration démo passent avec le nouveau manifeste.
- Le contrôle Android utilise Chromium avec émulation mobile ; aucun appareil physique Tecno/Itel n’est disponible dans cet environnement. Les tests d’intégration utilisent une base jetable et le navigateur utilise Redis QA isolé.

Auto-revue : les documents de référence et le bloc de consignes ont été lus intégralement ; les modifications de projet restent dans les deux dossiers autorisés. Les requêtes sont dans les repositories, le contrôleur admin reçoit une fabrique via un contrat partagé sans import croisé de module, les erreurs suivent le format standard et l’acteur utilise `request.user.userId`. Aucun secret, `any`, log de données personnelles, envoi SMS/PDF synchrone, nouvelle queue, token dans le stockage local, style inline ou couleur ajoutée n’est introduit. Les composants et tokens existants sont réutilisés ; le style de la navigation latérale est inchangé. Le parcours et les critères C8 sont livrés ; aucune régression n’est détectée par les vérifications exécutées. L’application de la migration en production et le contrôle sur appareil physique relèvent de la mise en service.

## Message de commit proposé

`fix(recovery): sécuriser la reprise scolaire réservée au super admin`
