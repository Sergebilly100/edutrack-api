import { OnboardingRepository, type OnboardingState } from './onboarding.repository.js';

const REQUIRED = ['schoolInfoComplete', 'activeYear', 'levels', 'subjects', 'rooms', 'fees'] as const;

export function evaluateOnboarding(state: OnboardingState) {
  const missing = REQUIRED.filter((key) => !state[key]);
  return { ...state, missing, canComplete: missing.length === 0 };
}

export class OnboardingPrerequisitesError extends Error {
  readonly code = 'ONBOARDING_PREREQUISITES_MISSING';
  readonly statusCode = 409;
  constructor(readonly missing: string[]) {
    super(missing.includes('activeYear')
      ? 'Le super administrateur doit d’abord ouvrir l’année scolaire active.'
      : 'Complétez les prérequis de configuration avant de terminer.');
  }
}

export class OnboardingService {
  constructor(private readonly repository: OnboardingRepository) {}

  async status(schemaName: string) {
    return evaluateOnboarding(await this.repository.readState(schemaName));
  }

  async complete(schemaName: string): Promise<void> {
    await this.repository.transaction(async (repository) => {
      const state = evaluateOnboarding(await repository.readState(schemaName));
      if (!state.canComplete) throw new OnboardingPrerequisitesError(state.missing);
      await repository.markCompleted(state.schoolId);
    });
  }
}
