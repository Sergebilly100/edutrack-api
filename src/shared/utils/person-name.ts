/**
 * Affichage uniforme des noms de personnes (élèves, professeurs, parents, utilisateurs) — AFFICHAGE UNIQUEMENT :
 * les données stockées ne sont jamais modifiées.
 *
 * Règles : NOM DE FAMILLE EN MAJUSCULES ; chaque prénom commence par une majuscule, le reste en minuscules
 * (« Jean-Pierre », « Mohamed Ady », « d'Arc ») ; les particules (de, du, van…) restent en minuscules dans les prénoms.
 * Ordre par défaut : « NOM Prénoms ».
 *
 * Même algorithme que `edutrack-web/src/shared/utils/person-name.ts` et que la fonction SQL `format_person_name`
 * (migration 0102) : les trois sont couverts par la même table de cas.
 * Copie conforme de `edutrack-web/src/shared/utils/person-name.ts` (deux dépôts séparés).
 */
export type PersonNameOrder = 'last-first' | 'first-last'

/** Ordre d'affichage par défaut dans les listes et documents. */
export const DEFAULT_PERSON_NAME_ORDER: PersonNameOrder = "last-first"

const PARTICLES = new Set(["de", "du", "des", "van", "von", "der", "den", "di", "da", "dos", "del", "la", "le"])

const collapse = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim()

export const formatLastName = (lastName: string | null | undefined): string => collapse(lastName).toLocaleUpperCase("fr-FR")

/** Majuscule à l'initiale de chaque mot, et après un trait d'union ou une apostrophe ; le reste en minuscules. */
const capitalizeWord = (word: string): string => {
  let result = ""
  let capitalizeNext = true
  for (const char of word) {
    result += capitalizeNext ? char.toLocaleUpperCase("fr-FR") : char
    capitalizeNext = char === "-" || char === "'" || char === "’"
  }
  return result
}

export const formatFirstNames = (firstNames: string | null | undefined): string =>
  collapse(firstNames).toLocaleLowerCase("fr-FR").split(" ").filter(Boolean).map((word, index) => {
    if (index > 0 && PARTICLES.has(word)) return word
    const elision = /^([dl])(['’])(.+)$/.exec(word)
    if (index > 0 && elision) return `${elision[1]}${elision[2]}${capitalizeWord(elision[3]!)}`
    return capitalizeWord(word)
  }).join(" ")

/** « KONÉ Aya Marie » (par défaut) ou « Aya Marie KONÉ » ; champs absents ignorés. */
export const formatPersonName = (
  person: { lastName?: string | null; firstName?: string | null },
  order: PersonNameOrder = DEFAULT_PERSON_NAME_ORDER,
): string => {
  const last = formatLastName(person.lastName)
  const first = formatFirstNames(person.firstName)
  return (order === "last-first" ? [last, first] : [first, last]).filter(Boolean).join(" ")
}

/** Initiales pour un avatar : première lettre du nom puis du premier prénom, en majuscules (« KA » pour KONÉ Aya). */
export const formatInitials = (person: { lastName?: string | null; firstName?: string | null }): string =>
  `${collapse(person.lastName).charAt(0)}${collapse(person.firstName).charAt(0)}`.toLocaleUpperCase('fr-FR')
