import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Garde-fou : un nom affiché (PDF, export, message, réponse d'API) n'est jamais concaténé à la main.
 * - SQL : `format_person_name(prénom, nom)` (migration 0102) au lieu de `concat_ws(' ', prénom, nom) AS …`.
 * - JS : `formatPersonName` (shared/utils/person-name.ts).
 * Les recherches (ILIKE sur une concaténation) ne sont pas concernées : elles ne sont pas affichées.
 */
const SRC = path.resolve(process.cwd(), 'src');
const FIRST = String.raw`(?:first_?[nN]ame)`;
const LAST = String.raw`(?:last_?[nN]ame)`;
const OUTPUT_AS = String.raw`(?=\s*(?:\)\s*)?(?:END\s+)?AS\b)`;
const SQL_PATTERNS: RegExp[] = [
  new RegExp(String.raw`concat_ws\(\s*' ',\s*\w+\.${FIRST}\s*,\s*\w+\.${LAST}\s*\)${OUTPUT_AS}`),
  new RegExp(String.raw`concat_ws\(\s*' ',\s*\w+\.${LAST}\s*,\s*\w+\.${FIRST}\s*\)${OUTPUT_AS}`),
  new RegExp(String.raw`CONCAT\(\s*\w+\.${FIRST}\s*,\s*' '\s*,\s*\w+\.${LAST}\s*\)${OUTPUT_AS}`),
  new RegExp(String.raw`CONCAT\(\s*\w+\.${LAST}\s*,\s*' '\s*,\s*\w+\.${FIRST}\s*\)${OUTPUT_AS}`),
];
const JS_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\$\{[^}]*\b${FIRST}\b[^}]*\}\s*\$\{[^}]*\b${LAST}\b[^}]*\}`),
  new RegExp(String.raw`\$\{[^}]*\b${LAST}\b[^}]*\}\s*\$\{[^}]*\b${FIRST}\b[^}]*\}`),
];

/** Exceptions justifiées : clés de rapprochement, recherche ou valeur stockée — jamais un affichage. */
const ALLOWED: Array<{ file: string; reason: string }> = [
  { file: 'modules/import-export/import.service.ts', reason: 'clés de rapprochement et nom de professeur enregistré à l’import (normalisation à l’écriture proposée à part)' },
  { file: 'modules/teachers/teachers.controller.ts', reason: 'nom du professeur enregistré à la création (valeur stockée)' },
  { file: 'modules/finance/financial-cache.service.ts', reason: 'texte de recherche (insensible aux accents), non affiché' },
];

const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
  const full = path.join(dir, entry);
  if (statSync(full).isDirectory()) return ['migrations', 'demo', 'migrations_backup'].includes(entry) ? [] : walk(full);
  return entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !/seed/.test(entry) ? [full] : [];
});

describe('affichage des noms côté API : aucune concaténation directe prénom/nom', () => {
  it('passe par format_person_name (SQL) ou formatPersonName (JS)', () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      const relative = path.relative(SRC, file).split(path.sep).join('/');
      if (relative === 'shared/utils/person-name.ts' || ALLOWED.some((item) => item.file === relative)) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if ([...SQL_PATTERNS, ...JS_PATTERNS].some((pattern) => pattern.test(line))) {
          violations.push(`${relative}:${index + 1}  ${line.trim().slice(0, 110)}`);
        }
      });
    }
    expect(violations, `Utilisez format_person_name / formatPersonName :\n${violations.join('\n')}`).toEqual([]);
  });

  it('les exceptions déclarées existent toujours', () => {
    for (const item of ALLOWED) expect(() => statSync(path.join(SRC, item.file))).not.toThrow();
  });
});
