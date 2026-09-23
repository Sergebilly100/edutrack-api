import { describe, expect, it } from 'vitest';

import {
  resolveMappingByHeaders,
  translateMappedValue,
  type MappingFieldDefinition,
} from '../../src/shared/import-mapping/engine.js';

const fields: MappingFieldDefinition[] = [
  { sourceColumnLabel: 'Matricule Élève', targetField: 'matricule', isRequired: true, translations: [] },
  {
    sourceColumnLabel: 'Mode', targetField: 'method', isRequired: true,
    translations: [{ sourceValue: 'Orange Money', targetValue: 'mobile_money' }],
  },
];

describe('generic import mapping engine', () => {
  it('réassocie les colonnes sans dépendre de leur ordre ni de la casse', () => {
    const result = resolveMappingByHeaders(['MODE', 'Matricule  Élève', 'Note'], fields);
    expect(result.matched.map((field) => field.targetField)).toEqual(['method', 'matricule']);
    expect(result.unmatchedHeaders).toEqual(['Note']);
    expect(result.missingRequiredTargets).toEqual([]);
  });

  it('signale uniquement les champs obligatoires dont la colonne a disparu', () => {
    expect(resolveMappingByHeaders(['Mode'], fields).missingRequiredTargets).toEqual(['matricule']);
  });

  it('traduit une valeur fixe sans dépendre de la casse', () => {
    expect(translateMappedValue(fields[1]!, ' orange money ')).toBe('mobile_money');
    expect(translateMappedValue(fields[1]!, 'Chèque')).toBeNull();
  });
});
