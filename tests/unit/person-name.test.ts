import { describe, expect, it } from 'vitest'

import { formatFirstNames, formatInitials, formatLastName, formatPersonName } from '../../src/shared/utils/person-name.js'

/** Table de cas partagée avec l'API et la fonction SQL format_person_name (mêmes entrées, mêmes sorties). */
const CASES: Array<{ label: string; last: string | null; first: string | null; expected: string }> = [
  { label: "cas simple", last: "Koné", first: "Aya", expected: "KONÉ Aya" },
  { label: "prénoms composés (trait d'union)", last: "Kouassi", first: "jean-pierre", expected: "KOUASSI Jean-Pierre" },
  { label: "plusieurs prénoms", last: "Koffi", first: "Mohamed ady", expected: "KOFFI Mohamed Ady" },
  { label: "apostrophe dans le nom", last: "N'Guessan", first: "Awa", expected: "N'GUESSAN Awa" },
  { label: "accents et majuscule accentuée", last: "éric", first: "ÉRIC", expected: "ÉRIC Éric" },
  { label: "nom tout en majuscules", last: "KOUASSI", first: "AMINATA", expected: "KOUASSI Aminata" },
  { label: "nom tout en minuscules", last: "yao", first: "fatou", expected: "YAO Fatou" },
  { label: "particule dans les prénoms", last: "Dupont", first: "marie de la croix", expected: "DUPONT Marie de la Croix" },
  { label: "particule du / van", last: "Martin", first: "jean du pont", expected: "MARTIN Jean du Pont" },
  { label: "particule en première position", last: "Gaulle", first: "de", expected: "GAULLE De" },
  { label: "élision d' en prénom", last: "Arc", first: "jeanne d'arc", expected: "ARC Jeanne d'Arc" },
  { label: "nom composé", last: "koné-traoré", first: "aïcha", expected: "KONÉ-TRAORÉ Aïcha" },
  { label: "espaces multiples et bords", last: "  Bamba  ", first: "  grâce   marie ", expected: "BAMBA Grâce Marie" },
  { label: "prénom manquant", last: "Yao", first: null, expected: "YAO" },
  { label: "nom manquant", last: null, first: "Awa", expected: "Awa" },
  { label: "les deux manquants", last: null, first: null, expected: "" },
  { label: "chaînes vides", last: "", first: "   ", expected: "" },
]

describe("formatPersonName (NOM Prénoms)", () => {
  it.each(CASES)("$label", ({ last, first, expected }) => {
    expect(formatPersonName({ lastName: last, firstName: first })).toBe(expected)
  })

  it("ordre configurable : Prénoms NOM", () => {
    expect(formatPersonName({ lastName: "koné", firstName: "aya marie" }, "first-last")).toBe("Aya Marie KONÉ")
    expect(formatPersonName({ lastName: null, firstName: "Awa" }, "first-last")).toBe("Awa")
  })

  it("ne modifie jamais les données d'entrée (affichage seulement)", () => {
    const person = { lastName: "koné", firstName: "aya" }
    formatPersonName(person)
    expect(person).toEqual({ lastName: "koné", firstName: "aya" })
  })

  it("formatLastName et formatFirstNames sont utilisables séparément", () => {
    expect(formatLastName("n'guessan")).toBe("N'GUESSAN")
    expect(formatFirstNames("JEAN-PIERRE de la fontaine")).toBe("Jean-Pierre de la Fontaine")
  })
})

describe('formatInitials', () => {
  it('initiales du nom puis du prénom, en majuscules', () => {
    expect(formatInitials({ lastName: 'koné', firstName: 'aya' })).toBe('KA')
    expect(formatInitials({ lastName: 'Éric', firstName: null })).toBe('É')
    expect(formatInitials({})).toBe('')
  })
})
