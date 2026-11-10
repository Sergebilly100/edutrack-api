import { sql, type SQL } from 'drizzle-orm';

const ACCENTS = 'àáâäãåçèéêëìíîïñòóôöõùúûüýÿÀÁÂÄÃÅÇÈÉÊËÌÍÎÏÑÒÓÔÖÕÙÚÛÜÝŸ';
const PLAIN = 'aaaaaaceeeeiiiinooooouuuuyyAAAAAACEEEEIIIINOOOOOUUUUYY';

/** Terme sans accents ni casse, entouré de % (jokers LIKE échappés) ; null si vide. */
export const foldSearchTerm = (value?: string): string | null => {
  const folded = value?.trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return folded ? `%${folded.replace(/[\\%_]/g, '\\$&')}%` : null;
};

/** Expression SQL insensible à la casse et aux accents, à comparer avec un terme issu de foldSearchTerm. */
export const foldedSql = (expression: SQL): SQL => sql`lower(translate(${expression}::text, ${ACCENTS}, ${PLAIN}))`;
