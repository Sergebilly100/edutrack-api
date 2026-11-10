import { describe, expect, it, vi } from 'vitest';

import type { DashboardActionsRepository } from '../../src/modules/dashboard-actions/dashboard-actions.repository.js';
import { DashboardActionsService } from '../../src/modules/dashboard-actions/dashboard-actions.service.js';

const build = (riskCounts: Record<string, number>) => {
  const replaceType = vi.fn().mockResolvedValue(undefined);
  const repository = {
    replaceType,
    countRiskByLevel: vi.fn().mockResolvedValue(riskCounts),
    countTeachersAtRisk: vi.fn().mockResolvedValue(1),
    listBlockedClasses: vi.fn().mockResolvedValue([{ classId: 'c1', className: '6ème A', periodLabel: 'Trimestre 2', incomplete: 1 }]),
  };
  return { service: new DashboardActionsService(repository as unknown as DashboardActionsRepository), replaceType };
};
const messagesOf = (replaceType: ReturnType<typeof vi.fn>) =>
  replaceType.mock.calls.flatMap(([, items]) => (items as Array<{ message?: string }>).map((item) => item.message ?? ''));

describe('messages des actions prioritaires', () => {
  it('sont en français lisible : ni jargon technique ni "(s)"', async () => {
    const { service, replaceType } = build({ warning: 3, critical: 2 });
    await service.generateAll({ weeklyAbsenceCount: 5, salaryPendingCount: 1, pendingValidations: 2, commissionOverdueCount: 1 });
    const messages = messagesOf(replaceType);
    expect(messages).toContain('5 élèves à suivre');
    expect(messages).toContain('1 fiche de salaire à terminer');
    expect(messages).toContain('2 décisions à prendre sur les pointages');
    expect(messages).toContain('En 6ème A (Trimestre 2), les moyennes de 1 matière ne sont pas validées : les bulletins ne peuvent pas être générés. Les professeurs doivent clôturer ces matières.');
    for (const message of messages) {
      expect(message).not.toMatch(/warning|critical|\(s\)/i);
    }
  });

  it('accorde le singulier', async () => {
    const { service, replaceType } = build({ warning: 1 });
    await service.generateAll({});
    expect(messagesOf(replaceType)).toContain('1 élève à suivre');
  });
});

const fullConfig = {
  activeYear: true, schoolInfoComplete: true, levels: true, subjects: true, rooms: true, fees: true, teachers: true,
  requiredDocuments: true, scheduleConfigured: true, gradingPeriods: true, reminderRules: true, riskRules: true,
  hasLogo: true, hasSeal: true,
};
const itemsByType = (replaceType: ReturnType<typeof vi.fn>) =>
  new Map(replaceType.mock.calls.map(([type, items]) => [type as string, items as Array<{ priority: string; message: string }>]));

describe('actions de configuration', () => {
  it('école entièrement configurée : aucune action de configuration', async () => {
    const { service, replaceType } = build({});
    await service.generateAll({ config: fullConfig });
    const byType = itemsByType(replaceType);
    for (const [type, items] of byType) if (type.startsWith('config_')) expect(items, type).toEqual([]);
  });

  it('chaque prérequis manquant crée son action avec une priorité et un message clair', async () => {
    const { service, replaceType } = build({});
    await service.generateAll({ config: { ...fullConfig, subjects: false, requiredDocuments: false, reminderRules: false, riskRules: false, scheduleConfigured: false } });
    const byType = itemsByType(replaceType);
    expect(byType.get('config_subjects')).toEqual([expect.objectContaining({ priority: 'high', message: 'Aucune matière n’est configurée.' })]);
    expect(byType.get('config_required_documents')?.[0].priority).toBe('medium');
    expect(byType.get('config_reminder_rules')).toHaveLength(1);
    expect(byType.get('config_risk_rules')).toHaveLength(1);
    expect(byType.get('config_schedule')?.[0].priority).toBe('high');
    expect(byType.get('config_levels')).toEqual([]);
  });

  it("identité visuelle : message selon l'élément manquant", async () => {
    const run = async (hasLogo: boolean, hasSeal: boolean) => {
      const { service, replaceType } = build({});
      await service.generateAll({ config: { ...fullConfig, hasLogo, hasSeal } });
      return itemsByType(replaceType).get('config_document_identity')?.[0]?.message;
    };
    expect(await run(false, false)).toMatch(/logo et le cachet/);
    expect(await run(false, true)).toMatch(/logo de l’école manque/);
    expect(await run(true, false)).toMatch(/cachet de l’école manque/);
    expect(await run(true, true)).toBeUndefined();
  });

  it("sans année active, les actions qui en dépendent (frais, emploi du temps, périodes) ne s'ajoutent pas", async () => {
    const { service, replaceType } = build({});
    await service.generateAll({ config: { ...fullConfig, activeYear: false, fees: false, scheduleConfigured: false, gradingPeriods: false } });
    const byType = itemsByType(replaceType);
    expect(byType.get('config_active_year')).toHaveLength(1);
    expect(byType.get('config_fees')).toEqual([]);
    expect(byType.get('config_schedule')).toEqual([]);
    expect(byType.get('config_grading_periods')).toEqual([]);
  });

  it('décisions de conduite : message accordé', async () => {
    const { service, replaceType } = build({});
    await service.generateAll({ conductPendingStudents: 12, conductPendingClasses: 2 });
    expect(itemsByType(replaceType).get('conduct_decision_pending')?.[0].message).toBe('12 élèves attendent une décision de conduite (2 classes).');
    const second = build({});
    await second.service.generateAll({ conductPendingStudents: 1, conductPendingClasses: 1 });
    expect(itemsByType(second.replaceType).get('conduct_decision_pending')?.[0].message).toBe('1 élève attend une décision de conduite (1 classe).');
  });

  it('le compteur élèves à suivre utilise la source alignée sur la page', async () => {
    const { service, replaceType } = build({ warning: 9, critical: 9 });
    await service.generateAll({ studentsAtRiskCount: 4 });
    expect(itemsByType(replaceType).get('student_at_risk')?.[0].message).toBe('4 élèves à suivre');
  });
});
