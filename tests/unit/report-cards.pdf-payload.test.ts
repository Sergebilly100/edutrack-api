import { describe, expect, it, vi } from 'vitest';

import type { ReportCardsRepository } from '../../src/modules/report-cards/report-cards.repository.js';
import { ReportCardsService } from '../../src/modules/report-cards/report-cards.service.js';

const card = {
  id: 'card-1', student_id: 'student-1', student_name: 'Mariam Yao', class_id: 'class-1', class_name: '3ème A',
  grading_period_id: 'period-1', period_label: 'Trimestre 1', school_year_label: '2026-2027',
  general_average: '14.650', rank: 1, class_average: '13.100', class_min_average: '10.760', class_max_average: '14.650',
  class_headcount: 24, status: 'published', generated_at: '2026-10-01T00:00:00Z', published_at: null, decision: null,
};
const lines = [
  { id: 'l-math', subject_id: 'math', subject_name: 'Mathématiques', line_type: 'subject', subject_average: '12.33', subject_coefficient: '4', subject_rank: 14 },
  { id: 'l-eng', subject_id: 'eng', subject_name: 'Anglais', line_type: 'subject', subject_average: '14.33', subject_coefficient: '2', subject_rank: 9 },
  { id: 'l-cond', subject_id: null, subject_name: null, line_type: 'conduct', subject_average: '17', subject_coefficient: '1', subject_rank: null },
];

const build = (overrides: Partial<Record<string, unknown>> = {}) => {
  const repository = {
    findCardDetail: vi.fn().mockResolvedValue(card),
    listCardLines: vi.fn().mockResolvedValue(lines),
    findPdfIdentity: vi.fn().mockResolvedValue({
      matricule: 'DEMO-0016', birth_date: '2011-05-14', birth_place: 'Bouaké', sex: 'F', nationality: 'CI', is_repeating: false,
    }),
    listPdfTeachers: vi.fn().mockResolvedValue([
      { subject_id: 'math', name: 'Emmanuel Kouadio', sex: 'M' },
      { subject_id: 'math', name: 'Fatou Traoré', sex: 'F' },
      { subject_id: 'math', name: 'Troisième Prof', sex: 'M' },
    ]),
    listLineComments: vi.fn().mockResolvedValue([]),
    findSchoolPhone: vi.fn().mockResolvedValue('+225 07 00 00 09 99'),
    ...overrides,
  };
  return { repository, service: new ReportCardsService(repository as unknown as ReportCardsRepository) };
};

describe('ReportCardsService.getPdfPayload - nouvelles données d’affichage', () => {
  it('ajoute identité, professeurs et téléphone sans toucher aux valeurs calculées', async () => {
    const { service, repository } = build();
    const payload = await service.getPdfPayload('card-1');

    expect(payload).toMatchObject({
      generalAverage: 14.65, generalRank: 1, classAverage: 13.1, classMinAverage: 10.76, classMaxAverage: 14.65, classHeadcount: 24,
      student: { matricule: 'DEMO-0016', birthDate: '2011-05-14', birthPlace: 'Bouaké', sex: 'F', nationality: 'CI', isRepeating: false },
      schoolPhone: '+225 07 00 00 09 99',
    });
    expect(payload.lines.map((l) => [l.label, l.average, l.coefficient, l.rank])).toEqual([
      ['Mathématiques', 12.33, 4, 14], ['Anglais', 14.33, 2, 9], ['Conduite', 17, 1, null],
    ]);
    expect(repository.listPdfTeachers).toHaveBeenCalledWith('class-1');
  });

  it('formate les professeurs selon le sexe ; aucun professeur → liste vide ; conduite sans professeur', async () => {
    const payload = await build().service.getPdfPayload('card-1');
    expect(payload.lines[0]!.teachers).toEqual(['M. Kouadio E.', 'Mme Traoré F.', 'M. Prof T.']);
    expect(payload.lines[1]!.teachers).toEqual([]);
    expect(payload.lines[2]).toMatchObject({ isConduct: true, teachers: [] });
  });

  it('laisse les colonnes Moy. classe et Appréciation vides (donnée non figée / jamais saisie)', async () => {
    const payload = await build().service.getPdfPayload('card-1');
    expect(payload.lines.every((l) => l.classAverage === null && l.appreciation === null)).toBe(true);
  });

  it('reprend une appréciation déjà présente dans le snapshot', async () => {
    const { service } = build({ listLineComments: vi.fn().mockResolvedValue([{ id: 'l-eng', teacher_comment: 'Bon travail.' }]) });
    expect((await service.getPdfPayload('card-1')).lines[1]!.appreciation).toBe('Bon travail.');
  });

  it('survit à une identité absente', async () => {
    const { service } = build({ findPdfIdentity: vi.fn().mockResolvedValue(null), findSchoolPhone: vi.fn().mockResolvedValue(null) });
    const payload = await service.getPdfPayload('card-1');
    expect(payload.student).toBeUndefined();
    expect(payload.schoolPhone).toBeNull();
  });
});
