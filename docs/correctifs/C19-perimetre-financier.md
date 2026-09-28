# C19 — périmètre financier des inscriptions confirmées

La finance V2 retient uniquement les élèves actifs qui ont une inscription `confirmed` dans l'année demandée et une classe active de cette même année. Une valeur dans `students.class_id` ne suffit pas à établir cette confirmation. Les paiements et tolérances sources ne sont jamais modifiés par le recalcul des caches.

## Audit préalable

Depuis `edutrack-api`, lancer `npm run finance:recalculate-caches -- --all-active` pour obtenir, par école et par année, le nombre de profils ayant une classe sans inscription confirmée et le nombre de caches élèves hors périmètre. La commande est une simulation par défaut : elle ne modifie aucune donnée. Pour limiter l'audit à une école, utiliser `--schema=school_nom` à la place de `--all-active`.

Audit en lecture seule du 28 septembre 2026 sur la base locale : `school_sainte_marie` compte 39 profils actifs avec classe et sans inscription confirmée dans son année active, dont 36 sans inscription V2, 2 `pending_cashier` et 1 `blocked_unpaid`. Son compteur de caches hors périmètre est 0. `school_demo_t3` compte 0 profil et 0 cache hors périmètre. Les autres écoles actives examinées n'avaient pas d'année scolaire. Ces comptes décrivent l'état au moment de l'audit et doivent être vérifiés de nouveau avant une reprise.

## Reprise contrôlée

1. Vérifier chaque dossier ambigu avec une preuve métier de confirmation (registre d'inscription validé ou décision explicite du responsable de l'école). Ne jamais déduire `confirmed` de `students.class_id`, d'un paiement isolé ou de la présence d'un cache.
2. Traiter les dossiers `pending_cashier` et `blocked_unpaid` par leurs flux métier normaux. Pour les profils sans inscription V2, créer ou confirmer l'inscription uniquement après validation du niveau, de la classe et de l'année par le responsable.
3. Relancer la simulation et comparer les compteurs. Puis exécuter `npm run finance:recalculate-caches -- --schema=school_nom --apply` pour une école approuvée, ou `--all-active --apply` après validation de toutes les écoles. Chaque école est recalculée dans une transaction ; les anciennes lignes de cache hors périmètre sont supprimées. Ne pas utiliser `--apply` pour confirmer des inscriptions : cette commande ne change que les caches dérivés.
4. Comparer les résumés école, niveau, classe et élèves après recalcul. Conserver le rapport de simulation et la validation métier avec le procès-verbal de reprise.
