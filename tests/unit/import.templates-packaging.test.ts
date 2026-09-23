import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const importTypes = ['students', 'teachers', 'schedule'] as const;

describe('import templates packaging', () => {
  it('keeps all import templates available in the Docker runtime image', () => {
    for (const type of importTypes) {
      expect(existsSync(path.join(process.cwd(), 'templates', `${type}.xlsx`))).toBe(true);
    }

    const dockerignore = readFileSync(path.join(process.cwd(), '.dockerignore'), 'utf8');
    expect(dockerignore.split(/\r?\n/).map((line) => line.trim())).not.toContain('templates/');

    const dockerfile = readFileSync(path.join(process.cwd(), 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY --from=build /app/templates ./templates');
  });
});
