import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import sharp from 'sharp';
import { extractText } from 'unpdf';
import { describe, expect, it, vi } from 'vitest';

import type { DocumentBranding, LoadedLogo } from '../../src/shared/pdf/builder.js';
import { loadLogo } from '../../src/shared/pdf/branding.js';
import {
  birthDateLabel,
  formatBulletinRank,
  formatCivilDate,
  formatCoefficient,
  formatDecimal,
  formatNationality,
  formatRepeater,
  formatSex,
  formatTeacherLabel,
  formatTeachersCell,
} from '../../src/shared/pdf/report-card-format.js';
import type { BulletinSeals } from '../../src/shared/pdf/school-seal.js';
import {
  REPORT_CARD_PALETTE,
  SIGNATORY_LABEL,
  buildReportCardView,
  layoutReportCardColumns,
  renderReportCard,
  type ReportCardLinePayload,
  type ReportCardPdfPayload,
} from '../../src/shared/pdf/templates/report-card.js';

const ISSUED_AT = new Date('2026-10-02T10:00:00Z');

const branding: DocumentBranding = {
  schoolName: 'Collège des Flamboyants',
  schoolMeta: 'Yamoussoukro',
  signatoryTitle: 'Directeur',
  logo: null,
};

const subjectLine = (i: number, extra: Partial<ReportCardLinePayload> = {}): ReportCardLinePayload => ({
  label: `Matière ${i + 1}`,
  average: 10 + (i % 8) + 0.5,
  coefficient: 1 + (i % 3),
  rank: i + 1,
  teachers: ['M. Koffi A.'],
  ...extra,
});

const conduct: ReportCardLinePayload = { label: 'Conduite', average: 17, coefficient: 1, rank: null, isConduct: true };

const payload = (subjects: number, overrides: Partial<ReportCardPdfPayload> = {}): ReportCardPdfPayload => ({
  studentName: 'Mariam Yao',
  className: '3ème A',
  periodLabel: 'Trimestre 1',
  schoolYearLabel: '2026-2027',
  generalAverage: 14.65,
  generalRank: 1,
  classHeadcount: 24,
  classAverage: 13.1,
  classMinAverage: 10.76,
  classMaxAverage: 14.65,
  yearEndDecisionLabel: null,
  lines: [...Array.from({ length: subjects }, (_, i) => subjectLine(i)), conduct],
  student: { matricule: 'DEMO-0016', birthDate: '2011-05-14', birthPlace: 'Bouaké', sex: 'F', nationality: 'CI', isRepeating: false },
  schoolPhone: '+225 07 00 00 09 99',
  issuedAt: ISSUED_AT,
  ...overrides,
});

const pdfPages = async (bytes: Uint8Array): Promise<string[]> => {
  const { text } = await extractText(new Uint8Array(bytes), { mergePages: false });
  return text;
};
const pdfText = async (bytes: Uint8Array): Promise<string> => (await pdfPages(bytes)).join('\n');

// Opaque : RGB sans canal alpha (donc sans masque dans le PDF) ; sinon RGBA translucide.
const png = (width: number, height: number, alpha = 1): Promise<Buffer> =>
  alpha === 1
    ? sharp({ create: { width, height, channels: 3, background: { r: 20, g: 20, b: 20 } } }).png().toBuffer()
    : sharp({ create: { width, height, channels: 4, background: { r: 20, g: 20, b: 20, alpha } } }).png().toBuffer();
const loaded = async (width = 120, height = 60, alpha = 1): Promise<LoadedLogo> => ({
  bytes: new Uint8Array(await png(width, height, alpha)),
  format: 'png',
});

/** Compte les images embarquées et celles qui portent un masque alpha (transparence conservée). */
const imageStats = async (bytes: Uint8Array): Promise<{ images: number; withAlpha: number }> => {
  const doc = await PDFDocument.load(bytes);
  let images = 0;
  let withAlpha = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const dict: PDFDict = object.dict;
    if (dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    if (dict.has(PDFName.of('SMask'))) withAlpha += 1;
    images += 1;
  }
  return { images: images - withAlpha, withAlpha };
};

const noSeals: BulletinSeals = { unified: null, legacy: { stamp: null, signature: null } };

describe('report-card-format', () => {
  it('formate les nombres à la française', () => {
    expect(formatDecimal(14.65)).toBe('14,65');
    expect(formatDecimal(13.1)).toBe('13,10');
    expect(formatDecimal(null)).toBe('—');
    expect(formatDecimal(Number.NaN)).toBe('—');
    expect(formatCoefficient(2)).toBe('2');
    expect(formatCoefficient(2.5)).toBe('2,5');
  });

  it('écrit les rangs 1er, 2e, 3e… et « — » sans rang', () => {
    expect([1, 2, 3, 12].map(formatBulletinRank)).toEqual(['1er', '2e', '3e', '12e']);
    expect(formatBulletinRank(null)).toBe('—');
    expect(formatBulletinRank(0)).toBe('—');
  });

  it('formate la date de naissance sans décalage de fuseau', () => {
    expect(formatCivilDate('2011-05-14')).toBe('14 mai 2011');
    expect(formatCivilDate('2011-05-01')).toBe('1 mai 2011');
    expect(formatCivilDate(null)).toBe('—');
    expect(formatCivilDate('pas une date')).toBe('—');
  });

  it('accorde « Né / Née », le sexe et le gentilé', () => {
    expect(birthDateLabel('M')).toBe('Né le');
    expect(birthDateLabel('F')).toBe('Née le');
    expect(birthDateLabel(null)).toBe('Né(e) le');
    expect(formatSex('M')).toBe('Masculin');
    expect(formatSex('F')).toBe('Féminin');
    expect(formatSex(null)).toBe('—');
    expect(formatNationality('CI', 'M')).toBe('Ivoirien');
    expect(formatNationality('CI', 'F')).toBe('Ivoirienne');
    expect(formatNationality('CI', null)).toBe("Côte d'Ivoire");
    expect(formatNationality(null, 'F')).toBe('—');
  });

  it('affiche Oui / Non / — pour redoublant', () => {
    expect([true, false, null, undefined].map(formatRepeater)).toEqual(['Oui', 'Non', '—', '—']);
  });

  it('déduit la civilité du sexe du professeur', () => {
    expect(formatTeacherLabel('Alain Koffi', 'M')).toBe('M. Koffi A.');
    expect(formatTeacherLabel('Fatou Traoré', 'F')).toBe('Mme Traoré F.');
    expect(formatTeacherLabel('Fatou Traoré', null)).toBe('Traoré F.');
    expect(formatTeacherLabel('Prof', 'M')).toBe('M. Prof');
    expect(formatTeachersCell(['M. A', 'Mme B', 'M. C'])).toBe('M. A / Mme B');
    expect(formatTeachersCell([])).toBe('—');
  });
});

describe('buildReportCardView', () => {
  it('reprend identité, synthèse et total sans rien recalculer', () => {
    const view = buildReportCardView(branding, payload(2));
    expect(view.schoolLine).toBe('Yamoussoukro · Tél. +225 07 00 00 09 99');
    expect(view.identityTop.map((c) => c.value)).toEqual(['Mariam Yao', 'DEMO-0016', '3ème A', '24 élèves']);
    expect(view.identityBottom).toEqual([
      { label: 'Née le', value: '14 mai 2011' },
      { label: 'Lieu de naissance', value: 'Bouaké' },
      { label: 'Sexe', value: 'Féminin' },
      { label: 'Nationalité', value: 'Ivoirienne' },
      { label: 'Redoublant', value: 'Non' },
    ]);
    expect(view.summary.map((c) => c.value)).toEqual(['14,65 / 20', '1er / 24', '13,10', '14,65', '10,76']);
    expect(view.total.rank).toBe('1er');
    expect(view.total.coefficient).toBe('4');
  });

  it('affiche « — » pour toute donnée absente, jamais null/undefined', () => {
    const view = buildReportCardView(
      { ...branding, schoolMeta: null },
      payload(1, { student: {}, schoolPhone: null, generalRank: 0, classHeadcount: 0 })
    );
    expect(view.schoolLine).toBeNull();
    expect(view.identityBottom.map((c) => c.value)).toEqual(['—', '—', '—', '—', '—']);
    expect(view.identityBottom[0]!.label).toBe('Né(e) le');
    expect(view.identityTop[1]!.value).toBe('—');
    expect(view.summary[1]!.value).toBe('—');
    expect(JSON.stringify([view.identityTop, view.identityBottom, view.summary, view.rows, view.total])).not.toMatch(/null|undefined|NaN/);
  });

  it('place Professeur juste avant Appréciation et masque les colonnes sans donnée', () => {
    const none = buildReportCardView(branding, payload(2)).columns.map((c) => c.key);
    expect(none).toEqual(['subject', 'coefficient', 'average', 'rank', 'teacher']);

    const both = buildReportCardView(
      branding,
      payload(2, { lines: [subjectLine(0, { classAverage: 12.3, appreciation: 'Bon travail.' }), subjectLine(1), conduct] })
    ).columns.map((c) => c.key);
    expect(both).toEqual(['subject', 'coefficient', 'average', 'classAverage', 'rank', 'teacher', 'appreciation']);
    expect(both.indexOf('teacher') + 1).toBe(both.indexOf('appreciation'));

    const onlyAppreciation = buildReportCardView(
      branding,
      payload(1, { lines: [subjectLine(0, { appreciation: 'Bien.' }), conduct] })
    ).columns.map((c) => c.key);
    expect(onlyAppreciation.slice(-2)).toEqual(['teacher', 'appreciation']);
  });

  it('redistribue la largeur quand une colonne est masquée', () => {
    const full = layoutReportCardColumns(
      buildReportCardView(branding, payload(1, { lines: [subjectLine(0, { classAverage: 1, appreciation: 'x' }), conduct] }))
    );
    const reduced = layoutReportCardColumns(buildReportCardView(branding, payload(1)));
    const sum = (cols: typeof full): number => cols.reduce((total, col) => total + col.width, 0);
    expect(sum(full)).toBeCloseTo(sum(reduced), 5);
    expect(reduced[0]!.width).toBeGreaterThan(full[0]!.width);
    expect(reduced.at(-1)!.x + reduced.at(-1)!.width).toBeCloseTo(full.at(-1)!.x + full.at(-1)!.width, 5);
  });

  it('gère professeurs : deux max, aucun, conduite « Vie scolaire », conduite en italique', () => {
    const view = buildReportCardView(
      branding,
      payload(2, { lines: [subjectLine(0, { teachers: ['M. A.', 'Mme B.', 'M. C.'] }), subjectLine(1, { teachers: [] }), conduct] })
    );
    expect(view.rows.map((r) => r.cells.teacher)).toEqual(['M. A. / Mme B.', '—', 'Vie scolaire']);
    expect(view.rows.map((r) => r.italic)).toEqual([false, false, true]);
    expect(view.rows[2]!.cells.rank).toBe('—');
  });

  it('omet « à {ville} » sans ville', () => {
    expect(buildReportCardView({ ...branding, schoolMeta: null }, payload(1)).city).toBeNull();
  });
});

describe('renderReportCard - contenu du PDF', () => {
  it('contient tous les libellés et valeurs attendus, au format français', async () => {
    const text = await pdfText(await renderReportCard(branding, payload(3), noSeals));
    for (const expected of [
      'Collège des Flamboyants', 'Yamoussoukro · Tél. +225 07 00 00 09 99', 'BULLETIN SCOLAIRE', 'Trimestre 1',
      'Année scolaire 2026-2027', 'ÉLÈVE', 'Mariam Yao', 'MATRICULE', 'DEMO-0016', 'CLASSE', '3ème A', 'EFFECTIF', '24 élèves',
      'NÉE LE', '14 mai 2011', 'LIEU DE NAISSANCE', 'Bouaké', 'SEXE', 'Féminin', 'NATIONALITÉ', 'Ivoirienne', 'REDOUBLANT', 'Non',
      'MOYENNE GÉNÉRALE', '14,65 / 20', '1er / 24', 'MOYENNE DE LA CLASSE', '13,10', 'PLUS FORTE MOYENNE', 'PLUS FAIBLE MOYENNE', '10,76',
      'MATIÈRE', 'COEF.', 'MOYENNE', 'RANG', 'PROFESSEUR', 'Matière 1', 'M. Koffi A.', '2e', 'Conduite', 'Vie scolaire', 'Total',
      'Fait à Yamoussoukro, le 2 octobre 2026', SIGNATORY_LABEL, 'Bulletin édité le 2 octobre 2026 · Document généré par IvoirEdu', 'Page 1 / 1',
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect(text).not.toMatch(/null|undefined|NaN/);
    expect(text).not.toMatch(/\d\.\d{2}/); // jamais de point décimal
  });

  it('n’affiche ni conseil de classe, ni cachet / signature séparés, ni colonnes sans donnée', async () => {
    const text = await pdfText(await renderReportCard(branding, payload(3), noSeals));
    expect(text).not.toContain('conseil de classe');
    expect(text).not.toMatch(/Cachet|Signature/);
    expect(text).not.toContain('APPRÉCIATION');
    expect(text).not.toContain('MOY. CLASSE');
    expect(text.split(SIGNATORY_LABEL)).toHaveLength(2); // une seule case
    expect(text.match(/2 octobre 2026/g)).toHaveLength(2); // « Fait à… » + pied de page, jamais plus
  });

  it('affiche les colonnes Moy. classe et Appréciation quand les données existent', async () => {
    const lines = [subjectLine(0, { classAverage: 12.4, appreciation: 'Bon travail.' }), conduct];
    const text = await pdfText(await renderReportCard(branding, payload(1, { lines }), noSeals));
    // Les sept en-têtes tiennent dans leur colonne (aucune troncature « … »).
    for (const header of ['MATIÈRE', 'COEF.', 'MOYENNE', 'MOY. CLASSE', 'RANG', 'PROFESSEUR', 'APPRÉCIATION']) {
      expect(text, header).toContain(header);
    }
    expect(text).toContain('12,40');
    expect(text).toContain('Bon travail.');
  });

  it('gère noms longs et apostrophes sans planter', async () => {
    const lines = [
      subjectLine(0, { label: 'Histoire-Géographie et Éducation à la Citoyenneté Responsable', teachers: ['Mme N’Guessan-Kouadio Marie-Hélène'], appreciation: 'Très bon niveau, continuez ainsi avec beaucoup de sérieux et de régularité dans le travail.' }),
      conduct,
    ];
    const bytes = await renderReportCard(
      { ...branding, schoolName: 'Groupe Scolaire Privé La Réussite Internationale d’Abidjan-Cocody Riviera Palmeraie' },
      payload(1, { studentName: 'Jean-Baptiste Kouassi N’Guessan Amani Yao-Boni', lines, student: { birthPlace: 'Sassandra-Marahoué-Bas-Sassandra-Côte d’Ivoire', sex: 'M', nationality: 'CI', isRepeating: true } }),
      noSeals
    );
    const text = await pdfText(bytes);
    expect(text).toContain('N’Guessan');
    expect(text).toContain('Oui');
    expect(text).toContain('Ivoirien');
  });
});

describe('renderReportCard - décision de fin d’année', () => {
  it('s’affiche à côté de la case du chef uniquement quand elle est renseignée', async () => {
    const withDecision = await pdfText(await renderReportCard(branding, payload(3, { yearEndDecisionLabel: 'Admis(e)' }), noSeals));
    expect(withDecision).toContain('DÉCISION DE FIN D’ANNÉE');
    expect(withDecision).toContain('Admis(e)');
    const without = await pdfText(await renderReportCard(branding, payload(3), noSeals));
    expect(without).not.toContain('DÉCISION');
  });

  it('tient sur la page avec 12 matières', async () => {
    expect(await pdfPages(await renderReportCard(branding, payload(12, { yearEndDecisionLabel: 'Redouble' }), noSeals))).toHaveLength(1);
  });
});

describe('renderReportCard - pagination', () => {
  it.each([
    [1, 1],
    [7, 1],
    [12, 1],
    [20, 2],
  ])('%i matières → %i page(s), Total et case du chef sur la dernière page', async (subjects, pages) => {
    const result = await pdfPages(await renderReportCard(branding, payload(subjects), noSeals));
    expect(result).toHaveLength(pages);
    result.forEach((pageText, index) => {
      expect(pageText).toContain(`Page ${index + 1} / ${pages}`);
      const isLast = index === pages - 1;
      expect(pageText.includes('Total')).toBe(isLast);
      expect(pageText.includes(SIGNATORY_LABEL)).toBe(isLast);
      if (index > 0) expect(pageText).toContain('MATIÈRE'); // en-tête de colonnes répété
    });
  });

  it('place chaque matière sur une seule page, sans en perdre', async () => {
    const result = await pdfPages(await renderReportCard(branding, payload(20), noSeals));
    for (let i = 1; i <= 20; i += 1) {
      expect(result.join('\n').match(new RegExp(`Matière ${i}(?!\\d)`, 'g'))).toHaveLength(1);
    }
  });
});

describe('renderReportCard - images', () => {
  const warn = vi.fn();

  it('intègre le logo et l’image unique cachet-signature, transparence conservée', async () => {
    const bytes = await renderReportCard(
      { ...branding, logo: await loaded(80, 80) },
      payload(2),
      { unified: await loaded(300, 150, 0.4), legacy: { stamp: null, signature: null } }
    );
    // Logo opaque + image cachet translucide (son masque alpha est préservé).
    expect(await imageStats(bytes)).toEqual({ images: 2, withAlpha: 1 });
  });

  it('sans aucune image : génération réussie, initiales à la place du logo, case vide avec libellé', async () => {
    const bytes = await renderReportCard(branding, payload(2), noSeals);
    expect(await imageStats(bytes)).toEqual({ images: 0, withAlpha: 0 });
    expect(await pdfText(bytes)).toContain(SIGNATORY_LABEL);
    expect(await renderReportCard(branding, payload(2), null)).toBeInstanceOf(Uint8Array);
  });

  it('logo seul / cachet seul', async () => {
    expect(await imageStats(await renderReportCard({ ...branding, logo: await loaded(50, 50) }, payload(1), noSeals))).toMatchObject({ images: 1 });
    expect(await imageStats(await renderReportCard(branding, payload(1), { unified: await loaded(), legacy: { stamp: null, signature: null } }))).toMatchObject({ images: 1 });
  });

  it('compose les anciennes images séparées (cachet + signature) dans la case unique', async () => {
    const bytes = await renderReportCard(branding, payload(2), {
      unified: null,
      legacy: { stamp: await loaded(100, 100), signature: await loaded(200, 80) },
    });
    expect(await imageStats(bytes)).toMatchObject({ images: 2 });
    expect((await pdfText(bytes)).split(SIGNATORY_LABEL)).toHaveLength(2);
  });

  it('ignore une image corrompue sans échouer et journalise sans donnée personnelle', async () => {
    const corrupt: LoadedLogo = { bytes: new Uint8Array([1, 2, 3, 4]), format: 'png' };
    const bytes = await renderReportCard(
      { ...branding, logo: corrupt },
      payload(2),
      { unified: corrupt, legacy: { stamp: corrupt, signature: { bytes: new Uint8Array([9]), format: 'jpg' } } },
      { logger: { warn } }
    );
    expect(await imageStats(bytes)).toEqual({ images: 0, withAlpha: 0 });
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Mariam');
  });

  it('rend un logo SVG existant (rastérisé côté serveur)', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="#222"/></svg>';
    const logo = await loadLogo(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
    expect(logo?.format).toBe('png');
    expect((await imageStats(await renderReportCard({ ...branding, logo }, payload(1), noSeals))).images).toBeGreaterThanOrEqual(1);
  });
});

describe('gabarit - noir, gris et blanc uniquement', () => {
  it('la palette déclarée ne contient que des gris', () => {
    for (const color of Object.values(REPORT_CARD_PALETTE)) {
      expect(color.red).toBe(color.green);
      expect(color.green).toBe(color.blue);
    }
  });

  it('le gabarit ne déclare aucune autre couleur (rgb non gris, hex, hsl, dégradé)', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/shared/pdf/templates/report-card.ts', import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/hsl\(|hexToRgb|brandColor|theme\.js|color\.brand/i);
    expect(source).not.toMatch(/gradient|drawSvgPath|PdfBuilder/i);
    const rgbCalls = source.match(/\brgb\(([^)]*)\)/g) ?? [];
    expect(rgbCalls).toEqual(['rgb(level, level, level)']);
  });
});
