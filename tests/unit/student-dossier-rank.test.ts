import { describe, expect, it, vi } from 'vitest';

import { StudentDossierRepository } from '../../src/modules/students/student-dossier.repository.js';
import type { TenantDb } from '../../src/shared/database/db.js';

describe('StudentDossierRepository.listEvents', () => {
  it('compose le détail du bulletin à la lecture sans exposer de nouveaux champs API', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [
      { type: 'report_card', date: '2026-07-18', label: 'Bulletin publié · T1',
        detail: 'Moyenne 16/20', schoolYearId: 'year-1', rank: 1, classHeadcount: 30 },
      { type: 'report_card', date: '2026-07-17', label: 'Bulletin publié · T2',
        detail: 'Moyenne 14/20', schoolYearId: 'year-1', rank: 2, classHeadcount: 30 },
      { type: 'document', date: '2026-07-16', label: 'Certificat',
        detail: 'fourni', schoolYearId: null, rank: null, classHeadcount: null },
    ] });
    const repository = new StudentDossierRepository({ execute } as unknown as TenantDb);

    expect(await repository.listEvents('student-1', null)).toEqual([
      { type: 'report_card', date: '2026-07-18', label: 'Bulletin publié · T1',
        detail: 'Moyenne 16/20, rang 1er / 30', schoolYearId: 'year-1' },
      { type: 'report_card', date: '2026-07-17', label: 'Bulletin publié · T2',
        detail: 'Moyenne 14/20, rang 2ème / 30', schoolYearId: 'year-1' },
      { type: 'document', date: '2026-07-16', label: 'Certificat',
        detail: 'fourni', schoolYearId: null },
    ]);
    expect(execute).toHaveBeenCalledOnce();
  });
});
