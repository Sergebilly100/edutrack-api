import { normalizeMappingLabel } from './engine.js';
import { matriculeKey } from '../utils/matricule.js';
import { normalizeSubjectKey } from '../utils/subject-normalization.js';

export type AssignmentPair = { teacherId: string; subjectId: string; classId: string };
export type AssignmentSnapshot = {
  teachers: Array<{ id: string; matricule: string | null; isActive: boolean; isBlocked: boolean }>;
  classes: Array<{ id: string; name: string; levelId: string | null; isActive: boolean }>;
  subjects: Array<{ id: string; name: string; levelId: string }>;
  assignments: AssignmentPair[];
};
export type AssignmentInputRow = { rowNumber: number; values: Record<string, string> };
export type AssignmentIssue = { rowNumber: number; reason: string; column: string; value: string };

// Preserve repeated and empty values: validation must report them, never silently repair a row.
export const splitAssignmentClasses = (value: string): string[] =>
  value.split(',').map((name) => name.normalize('NFKC').trim().replace(/\s+/g, ' '));

/** A group is atomic. Every occurrence of a duplicate pair is rejected before writing. */
export function validateTeacherAssignmentRows(rows: AssignmentInputRow[], snapshot: AssignmentSnapshot) {
  const candidates = rows.map((row) => {
    const errors: AssignmentIssue[] = [];
    const pairs: AssignmentPair[] = [];
    const issue = (column: string, value: string, reason: string) => errors.push({ rowNumber: row.rowNumber, column, value, reason });
    const { matricule = '', matiere = '', classes = '' } = row.values;
    const teachers = snapshot.teachers.filter((teacher) => matriculeKey(matricule) && matriculeKey(teacher.matricule) === matriculeKey(matricule));
    if (teachers.length !== 1) issue('Matricule', matricule, teachers.length ? `Matricule ambigu : ${matricule}` : `Professeur introuvable : ${matricule}`);
    else if (!teachers[0].isActive || teachers[0].isBlocked) issue('Matricule', matricule, `Professeur bloqué ou inactif : ${matricule}`);
    if (!matiere.trim() || !snapshot.subjects.some((subject) => normalizeSubjectKey(subject.name) === normalizeSubjectKey(matiere))) {
      issue('Matière', matiere, `Matière inconnue : ${matiere}`);
    }
    for (const name of splitAssignmentClasses(classes)) {
      const classMatches = snapshot.classes.filter((item) => name && normalizeMappingLabel(item.name) === normalizeMappingLabel(name));
      if (classMatches.length !== 1) { issue('Classes', name, classMatches.length ? `Classe ambiguë : ${name}` : `Classe inconnue dans l’année active : ${name || '(vide)'}`); continue; }
      const schoolClass = classMatches[0];
      if (!schoolClass.isActive) { issue('Classes', name, `Classe inactive : ${name}`); continue; }
      const subjects = snapshot.subjects.filter((subject) => subject.levelId === schoolClass.levelId && normalizeSubjectKey(subject.name) === normalizeSubjectKey(matiere));
      if (subjects.length !== 1) { issue('Matière', matiere, subjects.length ? `Matière ambiguë pour ${name} : ${matiere}` : `Matière absente du niveau de ${name} : ${matiere}`); continue; }
      if (teachers.length === 1) pairs.push({ teacherId: teachers[0].id, classId: schoolClass.id, subjectId: subjects[0].id });
    }
    return { row, pairs, errors };
  });
  const pairKey = (pair: AssignmentPair) => `${pair.teacherId}:${pair.subjectId}:${pair.classId}`;
  const occurrences = new Map<string, number>();
  for (const { pairs } of candidates) for (const pair of pairs) occurrences.set(pairKey(pair), (occurrences.get(pairKey(pair)) ?? 0) + 1);
  const existing = new Set(snapshot.assignments.map(pairKey));
  for (const candidate of candidates) for (const pair of candidate.pairs) {
    const name = snapshot.classes.find((item) => item.id === pair.classId)!.name;
    if ((occurrences.get(pairKey(pair)) ?? 0) > 1) candidate.errors.push({ rowNumber: candidate.row.rowNumber, column: 'Classes', value: name, reason: `Association dupliquée dans le fichier : ${candidate.row.values.matiere} → ${name}` });
    if (existing.has(pairKey(pair))) candidate.errors.push({ rowNumber: candidate.row.rowNumber, column: 'Classes', value: name, reason: `Association déjà existante : ${candidate.row.values.matiere} → ${name}` });
  }
  return {
    validRows: candidates.filter((candidate) => candidate.errors.length === 0).map(({ row, pairs }) => ({ ...row, teachingAssignments: pairs })),
    errors: candidates.flatMap((candidate) => candidate.errors),
  };
}
