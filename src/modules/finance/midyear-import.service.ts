import { validateTeacherAssignmentRows } from '../../shared/import-mapping/teacher-assignments.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  normalizeMappingLabel, resolveMappingByHeaders, translateMappedValue,
  type MappingFieldDefinition,
} from '../../shared/import-mapping/engine.js';
import { parseMappingWorkbook, type ParsedMappingWorkbook } from '../../shared/import-mapping/workbook.js';
import type { TenantDb } from '../../shared/database/db.js';
import { isMatriculeUniqueViolation, matriculeKey } from '../../shared/utils/matricule.js';
import {
  MidyearImportError, type RecoveryImpact, type RecoveryPreview, type RecoveryRow,
} from '../../shared/import-mapping/midyear.types.js';
import { MidyearImportRepository, type RecoverySnapshot } from './midyear-import.repository.js';

export { MidyearImportError } from '../../shared/import-mapping/midyear.types.js';

type TargetDef = { key: string; required: boolean };
export const MIDYEAR_IMPORTS: Record<string, { targets: TargetDef[] }> = {
  levels: { targets: [{ key: 'nom', required: true }, { key: 'ordre', required: false }] },
  subjects: { targets: [{ key: 'niveau', required: true }, { key: 'matiere', required: true }, { key: 'coefficient', required: true }] },
  rooms: { targets: [{ key: 'nom', required: true }, { key: 'capacite', required: false }] },
  classes: { targets: [{ key: 'nom', required: true }, { key: 'niveau', required: true }] },
  students: { targets: [
    { key: 'matricule', required: true }, { key: 'nom', required: true }, { key: 'prenom', required: true },
    { key: 'niveau', required: true }, { key: 'classe', required: true }, { key: 'parent_phone', required: false },
  ] },
  teacher_assignments: { targets: ['matricule', 'matiere', 'classes'].map((key) => ({ key, required: true })) },
  payments: { targets: ['matricule', 'montant', 'date', 'reference', 'method'].map((key) => ({ key, required: true })) },
};
const PAYMENT_METHODS = new Set(['cash', 'mobile_money', 'bank_transfer']);
// JWT signing material is shared by API instances; changing it invalidates outstanding previews.
const PREVIEW_SECRET = process.env.JWT_PRIVATE_KEY ?? randomBytes(32).toString('hex');
const text = (value: unknown) => String(value ?? '').trim();
const key = normalizeMappingLabel;
const matches = <T>(rows: T[], label: string, getLabel: (row: T) => string | null) =>
  rows.filter((row) => key(getLabel(row) ?? '') === key(label));
const matchesMatricule = <T>(rows: T[], value: string, getValue: (row: T) => string | null) =>
  rows.filter((row) => matriculeKey(value) !== null && matriculeKey(getValue(row)) === matriculeKey(value));

export const parseRecoveryAmount = (value: string): string | null => {
  const compact = value.replace(/[\s\u00a0]/g, '').replace(',', '.');
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(compact) || Number(compact) <= 0) return null;
  return compact;
};
export const parseRecoveryDate = (value: string | number): string | null => {
  let candidate: string;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0 || value > 2_958_465) return null;
    candidate = new Date(Date.UTC(1899, 11, 30) + value * 86_400_000).toISOString().slice(0, 10);
  } else {
    const french = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(value.trim());
    candidate = french ? `${french[3]}-${french[2]}-${french[1]}` : value.trim();
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const date = new Date(`${candidate}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === candidate ? candidate : null;
};
const emptyImpact = (): RecoveryImpact => ({ profilesCreated: 0, profilesReused: 0, classesCreated: 0, classesReused: 0,
  enrollmentsCreated: 0, enrollmentsReused: 0, paymentsCreated: 0, paymentsReused: 0 });

/** Pure row validation, shared by preview and the locked confirmation. */
export function validateRecoveryRows(importType: string, rows: RecoveryRow[], snapshot: RecoverySnapshot) {
  if (importType === 'teacher_assignments') {
    const result = validateTeacherAssignmentRows(rows, { teachers: snapshot.teachers ?? [], assignments: snapshot.assignments ?? [], classes: snapshot.classes, subjects: snapshot.subjects });
    return { ...result, totalRows: rows.length,
      impact: { ...emptyImpact(), assignmentsCreated: result.validRows.reduce((count, row) => count + row.teachingAssignments.length, 0) },
      classesWithoutTeacherAssignments: snapshot.classes.filter((c) => c.isActive && !c.hasAssignments && !result.validRows.some((row) => row.teachingAssignments.some((pair) => pair.classId === c.id))).length,
      classesWithoutHomeroomTeacher: snapshot.classes.filter((c) => c.isActive && !c.homeroomTeacherId).map(({ id, name }) => ({ id, name })),
    };
  }
  const validRows: RecoveryRow[] = [];
  const errors: RecoveryPreview['errors'] = [];
  const impact = emptyImpact();
  const createdClasses = new Set<string>();
  const reusedClasses = new Set<string>();
  const identities = new Map<string, number>();
  const classLevels = new Map<string, Set<string>>();
  for (const row of rows) {
    const v = row.values;
    const identity = importType === 'students' ? matriculeKey(v.matricule) ?? '' : key(importType === 'payments' ? v.reference : importType === 'subjects' ? `${v.niveau}/${v.matiere}` : v.nom);
    identities.set(identity, (identities.get(identity) ?? 0) + 1);
    if (importType === 'students') {
      const levels = classLevels.get(key(v.classe)) ?? new Set<string>();
      levels.add(key(v.niveau)); classLevels.set(key(v.classe), levels);
    }
  }
  for (const input of rows) {
    const row: RecoveryRow = { rowNumber: input.rowNumber, values: { ...input.values } };
    const v = row.values;
    const reasons: string[] = [];
    const identity = importType === 'students' ? matriculeKey(v.matricule) ?? '' : key(importType === 'payments' ? v.reference : importType === 'subjects' ? `${v.niveau}/${v.matiere}` : v.nom);
    if ((identities.get(identity) ?? 0) > 1) reasons.push('Doublon dans le fichier, corrigez toutes les lignes concernées');
    for (const target of MIDYEAR_IMPORTS[importType].targets) {
      if (target.required && !v[target.key]?.trim()) reasons.push(`${target.key} manquant`);
    }
    const lengths: Record<string, number> = { matricule: 50, nom: 100, prenom: 100, classe: 100, niveau: 100, reference: 255, parent_phone: 20 };
    for (const [field, max] of Object.entries(lengths)) if ((v[field]?.length ?? 0) > max) reasons.push(`${field} trop long (maximum ${max})`);
    if (v.parent_phone && !/^\+?\d{8,15}$/.test(v.parent_phone)) reasons.push('Téléphone parent invalide');
    if (importType === 'classes' || importType === 'students' || importType === 'subjects') {
      const levels = matches(snapshot.levels, v.niveau, (level) => level.name);
      if (levels.length !== 1) reasons.push(levels.length ? 'Niveau ambigu' : 'Niveau inconnu');
      else row.levelId = levels[0].id;
    }
    if (importType === 'classes' || importType === 'students') {
      const className = importType === 'classes' ? v.nom : v.classe;
      const classes = matches(snapshot.classes, className, (item) => item.name);
      if (classes.length > 1) reasons.push('Classe ambiguë dans l’année sélectionnée');
      else if (classes[0]) {
        if (!classes[0].isActive || classes[0].levelId !== row.levelId) reasons.push('Classe inactive ou rattachée à un autre niveau');
        else { row.classId = classes[0].id; row.reused = true; }
      }
    }
    if (importType === 'students') {
      if ((classLevels.get(key(v.classe))?.size ?? 0) > 1) reasons.push('La même classe est associée à plusieurs niveaux dans le fichier');
      const profiles = matchesMatricule(snapshot.students, v.matricule, (student) => student.matricule);
      if (profiles.length > 1) reasons.push('Matricule ambigu');
      else if (profiles[0]) {
        const student = profiles[0];
        if (key(student.firstName) !== key(v.prenom) || key(student.lastName) !== key(v.nom)) reasons.push('Matricule déjà utilisé par une autre identité');
        if (!student.isActive || student.lifecycleStatus !== 'active') reasons.push('Profil élève inactif');
        row.studentId = student.id;
        const enrollments = snapshot.enrollments.filter((e) => e.studentId === student.id);
        if (enrollments.length > 1) reasons.push('Inscriptions concurrentes');
        else if (enrollments[0]) {
          if (enrollments[0].status !== 'confirmed' || enrollments[0].classId !== row.classId) reasons.push('Inscription concurrente dans une autre classe ou non confirmée');
          else row.enrollmentId = enrollments[0].id;
        }
      }
    }
    if (importType === 'payments') {
      const amount = parseRecoveryAmount(v.montant);
      const date = parseRecoveryDate(v.date);
      if (!amount) reasons.push('Montant invalide (positif, au plus deux décimales)');
      else v.montant = amount;
      if (!date) reasons.push('Date de paiement invalide');
      else { v.date = date; if (date < snapshot.year.startDate || date > snapshot.year.endDate) reasons.push('Date hors de l’année sélectionnée'); }
      if (!PAYMENT_METHODS.has(v.method)) reasons.push('Moyen de paiement inconnu, renseignez une traduction explicite');
      const profiles = matchesMatricule(snapshot.students, v.matricule, (student) => student.matricule);
      if (profiles.length !== 1) reasons.push(profiles.length ? 'Matricule ambigu' : 'Matricule introuvable');
      else {
        const student = profiles[0];
        row.studentId = student.id;
        if (!student.isActive || student.lifecycleStatus !== 'active') reasons.push('Profil élève inactif');
        const enrollments = snapshot.enrollments.filter((e) => e.studentId === student.id);
        const enrollment = enrollments[0];
        const assignedClass = snapshot.classes.find((c) => c.id === enrollment?.classId);
        if (enrollments.length !== 1 || enrollment?.status !== 'confirmed' || !assignedClass?.isActive) reasons.push('Aucune inscription confirmée associable dans l’année sélectionnée');
        else {
          row.enrollmentId = enrollment.id; row.classId = assignedClass.id;
          if (!snapshot.plans.some((p) => p.levelId === assignedClass.levelId)) reasons.push('Plan de frais manquant pour le niveau et l’année');
        }
        const payments = snapshot.payments.filter((p) => p.reference !== null && key(p.reference) === key(v.reference));
        if (payments.length > 1) reasons.push('Référence de paiement ambiguë');
        else if (payments[0]) {
          const p = payments[0];
          if (p.studentId === student.id && Number(p.amount) === Number(amount) && p.date === date && p.method === v.method && p.reference === v.reference && p.status === 'confirmed' && p.source === 'migration_import') row.reused = true;
          else reasons.push('Référence déjà utilisée par un paiement différent');
        }
      }
    }
    if (importType === 'levels' || importType === 'rooms') {
      const items = matches(importType === 'levels' ? snapshot.levels : snapshot.rooms, v.nom, (item) => item.name);
      if (items.length > 1) reasons.push('Nom ambigu');
      else row.reused = items.length === 1;
      const number = importType === 'levels' ? v.ordre : v.capacite;
      if (number && (!/^\d+$/.test(number) || Number(number) > 2147483647)) reasons.push('Ordre ou capacité invalide');
    }
    if (importType === 'subjects') {
      v.coefficient = v.coefficient.replace(',', '.');
      if (!/^\d+(\.\d{1,3})?$/.test(v.coefficient) || Number(v.coefficient) <= 0 || Number(v.coefficient) >= 1000) reasons.push('Coefficient invalide');
      const subjects = snapshot.subjects.filter((item) => item.levelId === row.levelId && key(item.name) === key(v.matiere));
      if (subjects.length > 1) reasons.push('Matière ambiguë');
      else row.reused = subjects.length === 1;
    }
    if (reasons.length) {
      const matriculeCollision = importType === 'students' && reasons.some((reason) => reason.includes('Matricule déjà utilisé') || reason.includes('Matricule ambigu') || reason.includes('Doublon dans le fichier'));
      errors.push({ rowNumber: row.rowNumber, reason: reasons.join(' ; '), ...(matriculeCollision ? { code: 'MATRICULE_ALREADY_EXISTS' } : {}) });
      continue;
    }
    if (importType === 'students') {
      impact[row.studentId ? 'profilesReused' : 'profilesCreated'] += 1;
      impact[row.enrollmentId ? 'enrollmentsReused' : 'enrollmentsCreated'] += 1;
      (row.classId ? reusedClasses : createdClasses).add(key(v.classe));
    }
    if (importType === 'classes') (row.classId ? reusedClasses : createdClasses).add(key(v.nom));
    if (importType === 'payments') impact[row.reused ? 'paymentsReused' : 'paymentsCreated'] += 1;
    validRows.push(row);
  }
  impact.classesCreated = createdClasses.size; impact.classesReused = reusedClasses.size;
  return { validRows, errors, totalRows: rows.length, impact,
    classesWithoutTeacherAssignments: snapshot.classes.filter((c) => c.isActive && !c.hasAssignments).length + createdClasses.size };
}

export class MidyearImportService {
  constructor(private readonly repository: MidyearImportRepository) {}

  private config(importType: string) {
    const config = MIDYEAR_IMPORTS[importType];
    if (!config) throw new MidyearImportError('Type d’import inconnu', 400, 'IMPORT_TYPE_UNKNOWN');
    return config;
  }
  getProfile(importType: string) {
    this.config(importType);
    return this.repository.getActiveProfile(`midyear_${importType}`);
  }
  private validateMappingFields(importType: string, fields: MappingFieldDefinition[]) {
    const config = this.config(importType);
    const targets = fields.map((field) => field.targetField);
    if (new Set(targets).size !== targets.length || new Set(fields.map((f) => key(f.sourceColumnLabel))).size !== targets.length) {
      throw new MidyearImportError('Chaque colonne et champ cible ne peut être mappé qu’une fois', 400, 'MAPPING_TARGET_DUPLICATED');
    }
    if (targets.some((target) => !config.targets.some((item) => item.key === target))) throw new MidyearImportError('Champ cible inconnu', 400, 'MAPPING_TARGET_UNKNOWN');
    const missing = config.targets.filter((t) => t.required && !targets.includes(t.key));
    if (missing.length) throw new MidyearImportError(`Champs obligatoires non mappés : ${missing.map((t) => t.key).join(', ')}`, 400, 'MAPPING_REQUIRED_FIELDS_MISSING');
    if (fields.some((field) => new Set(field.translations.map((translation) => key(translation.sourceValue))).size !== field.translations.length)) {
      throw new MidyearImportError('Chaque valeur source ne peut avoir qu’une traduction', 400, 'MAPPING_TRANSLATION_AMBIGUOUS');
    }
    if (importType === 'payments' && fields.some((f) => f.translations.length && (f.targetField !== 'method' || f.translations.some((t) => !PAYMENT_METHODS.has(t.targetValue))))) {
      throw new MidyearImportError('Seul le moyen de paiement accepte des traductions explicites vers cash, mobile_money ou bank_transfer', 400, 'MAPPING_METHOD_TRANSLATIONS_INVALID');
    }
    if (importType === 'teacher_assignments' && fields.some((field) => field.translations.length)) {
      throw new MidyearImportError('Les matricules, matières et classes doivent être conservés sans traduction', 400, 'MAPPING_ASSIGNMENT_TRANSLATIONS_INVALID');
    }
    return config;
  }
  async saveProfile(input: { importType: string; label?: string; actorUserId: string; fields: MappingFieldDefinition[] }) {
    const config = this.validateMappingFields(input.importType, input.fields);
    return this.repository.saveActiveProfile({ ...input, importType: `midyear_${input.importType}`,
      fields: input.fields.map((f) => ({ ...f, isRequired: config.targets.some((t) => t.key === f.targetField && t.required) })) });
  }
  private async parse(file: Buffer) {
    try { return await parseMappingWorkbook(file); }
    catch { throw new MidyearImportError('Le fichier Excel est vide ou illisible, vérifiez ses en-têtes', 400, 'IMPORT_FILE_INVALID'); }
  }
  async analyze(importType: string, file: Buffer, yearId: string) {
    const config = this.config(importType);
    await this.repository.snapshot(yearId);
    const workbook = await this.parse(file);
    const profile = await this.getProfile(importType);
    const resolution = resolveMappingByHeaders(workbook.headers, profile?.fields ?? []);
    const missingTargets = config.targets.filter((t) => t.required && !resolution.matched.some((f) => f.targetField === t.key)).map((t) => t.key);
    return { headers: workbook.headers, rowCount: workbook.rows.length, matchedFields: resolution.matched,
      unmatchedHeaders: resolution.unmatchedHeaders, profile, missingTargets, sampleRows: workbook.rows.slice(0, 10),
      distinctValuesByColumn: Object.fromEntries(workbook.headers.map((header) => [header, [...new Set(workbook.rows.map((r) => text(r.values[header])).filter(Boolean))].slice(0, 100)])) };
  }
  private mappedRows(importType: string, workbook: ParsedMappingWorkbook, fields: MappingFieldDefinition[]) {
    const config = this.config(importType);
    const resolution = resolveMappingByHeaders(workbook.headers, fields);
    const missing = config.targets.filter((t) => t.required && !resolution.matched.some((f) => f.targetField === t.key));
    if (missing.length) throw new MidyearImportError(`Colonnes introuvables : ${missing.map((t) => t.key).join(', ')}`, 422, 'MAPPING_COLUMNS_MISSING');
    return workbook.rows.map((row) => ({ rowNumber: row.rowNumber, values: Object.fromEntries(config.targets.map((target) => {
      const field = resolution.matched.find((f) => f.targetField === target.key);
      const raw = field ? row.values[field.sourceColumnLabel] : '';
      // Preserve school references verbatim. Excel dates may be serial numbers.
      let value = target.key === 'reference' ? String(raw ?? '') : text(raw);
      if (importType === 'payments' && target.key === 'date') value = parseRecoveryDate(raw) ?? value;
      if (field?.translations.length) value = translateMappedValue(field, value) ?? value;
      return [target.key, value];
    })) }));
  }
  async preview(importType: string, file: Buffer, yearId: string): Promise<RecoveryPreview> {
    const workbook = await this.parse(file);
    const profile = await this.getProfile(importType);
    if (!profile) throw new MidyearImportError('Configurez d’abord le mapping', 409, 'MAPPING_PROFILE_REQUIRED');
    this.validateMappingFields(importType, profile.fields);
    const snapshot = await this.repository.snapshot(yearId);
    const preview = validateRecoveryRows(importType, this.mappedRows(importType, workbook, profile.fields), snapshot);
    const previewToken = createHmac('sha256', process.env.JWT_PRIVATE_KEY ?? PREVIEW_SECRET).update(JSON.stringify({ importType, yearId, fileHash: createHash('sha256').update(file).digest('hex'), profile, snapshot, preview })).digest('hex');
    return { schoolYearId: yearId, ...preview, previewToken };
  }
  async confirm(importType: string, file: Buffer, yearId: string, token: string, actorUserId: string) {
    try {
      return await this.repository.transaction(yearId, async (repository) => {
        const preview = await new MidyearImportService(repository).preview(importType, file, yearId);
        if (!/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(preview.previewToken, 'hex'))) {
          throw new MidyearImportError('Les données ou le fichier ont changé, prévisualisez de nouveau avant de confirmer', 409, 'RECOVERY_PREVIEW_STALE');
        }
        await repository.apply(importType, preview.validRows, yearId, actorUserId);
        await repository.recordAudit(importType, yearId, actorUserId, preview.impact);
        const reusedCount = preview.validRows.filter((row) => importType === 'students' ? Boolean(row.enrollmentId) : row.reused).length;
        return { createdCount: preview.validRows.length - reusedCount, reusedCount, errors: preview.errors, totalRows: preview.totalRows, impact: preview.impact, classesWithoutHomeroomTeacher: preview.classesWithoutHomeroomTeacher };
      });
    } catch (error) {
      if (error instanceof MidyearImportError) throw error;
      // PostgreSQL error messages can contain personal data. No raw errors in HTTP/logs.
      if (isMatriculeUniqueViolation(error)) throw new MidyearImportError('Ce matricule est déjà utilisé', 409, 'MATRICULE_ALREADY_EXISTS');
      throw new MidyearImportError('La reprise a été annulée intégralement. Corrigez le fichier puis prévisualisez de nouveau.', 409, 'RECOVERY_WRITE_FAILED');
    }
  }
}
export const buildMidyearImportService = (db: TenantDb) => new MidyearImportService(new MidyearImportRepository(db));
