/**
 * Moteur générique d'import par mapping de colonnes (Tâche 4c, réutilisé par
 * l'import « prise en main » 8b via des profils import_type distincts).
 *
 * Principe : l'école fournit son fichier tel quel. Les en-têtes de colonnes
 * sont normalisés (NFKC + trim + espaces + casse) puis ré-associes aux champs
 * cibles du profil enregistré — indépendamment de l'ordre et de la casse.
 * `translateMappedValue` gère en plus les valeurs à traduire (ex. modes de
 * paiement : "Orange Money" → mobile_money).
 */
export type MappingValueTranslation = {
  sourceValue: string;
  targetValue: string;
};

export type MappingFieldDefinition = {
  id?: string;
  sourceColumnLabel: string;
  targetField: string;
  isRequired: boolean;
  translations: MappingValueTranslation[];
};

export const normalizeMappingLabel = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr');

export const resolveMappingByHeaders = (
  headers: readonly string[],
  fields: readonly MappingFieldDefinition[]
): {
  matched: MappingFieldDefinition[];
  unmatchedHeaders: string[];
  missingRequiredTargets: string[];
} => {
  const headerKeys = new Set(headers.map(normalizeMappingLabel));
  const fieldBySource = new Map(
    fields.map((field) => [normalizeMappingLabel(field.sourceColumnLabel), field] as const)
  );

  return {
    matched: headers.flatMap((header) => {
      const field = fieldBySource.get(normalizeMappingLabel(header));
      return field ? [{ ...field, sourceColumnLabel: header }] : [];
    }),
    unmatchedHeaders: headers.filter((header) => !fieldBySource.has(normalizeMappingLabel(header))),
    missingRequiredTargets: fields
      .filter((field) => field.isRequired && !headerKeys.has(normalizeMappingLabel(field.sourceColumnLabel)))
      .map((field) => field.targetField),
  };
};

export const translateMappedValue = (
  field: MappingFieldDefinition,
  sourceValue: string
): string | null => {
  const sourceKey = normalizeMappingLabel(sourceValue);
  return field.translations.find(
    (translation) => normalizeMappingLabel(translation.sourceValue) === sourceKey
  )?.targetValue ?? null;
};
