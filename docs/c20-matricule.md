# C20 — Portée et déploiement des matricules

Décision produit confirmée le 28 septembre 2026 : l'unicité est **séparée par population et par tenant**. Un élève et un professeur peuvent avoir le même matricule. Deux élèves, ou deux professeurs, ne le peuvent pas.

Le matricule reste facultatif pour la création et la modification des profils. Plusieurs valeurs `NULL` sont autorisées. Lorsqu'il est fourni, seuls les espaces périphériques sont retirés à l'écriture ; la comparaison ignore la casse. Les caractères internes, y compris les espaces, sont significatifs. La reprise de mi-année conserve son besoin existant de matricule dans ses fichiers élèves et paiements, afin de rapprocher les lignes d'un dossier ; cela ne rend pas la colonne obligatoire dans les profils.

La migration Drizzle Kit `0079_matricule_normalized_unique.sql` ajoute un index unique sur `lower(btrim(matricule))` dans chaque table. `tenant-init.ts` et `migrate-all-tenants.ts` vérifient d'abord les collisions normalisées. Si elles existent, ils arrêtent la migration et rapportent uniquement les UUID des lignes en conflit, classés par population. Aucun profil n'est fusionné, renommé ou écrasé automatiquement. Résoudre manuellement chaque groupe, puis relancer la migration sur tous les tenants. Les index sont idempotents et acceptent les `NULL`.

La recherche `/api/v1/students/profiles` destinée à la Nouvelle inscription a été retirée. Une nouvelle inscription crée un profil. Les élèves existants passent par les candidats et les décisions de l'onglet Réinscriptions.
