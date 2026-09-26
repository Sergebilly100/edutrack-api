import { describe, expect, it, vi } from 'vitest';
import { OnboardingRepository, type OnboardingState } from '../../src/modules/school/onboarding.repository.js';
import { evaluateOnboarding, OnboardingPrerequisitesError, OnboardingService } from '../../src/modules/school/onboarding.service.js';

const ready: OnboardingState = { schoolId: 'school-a', schoolInfoComplete: true, activeYear: true,
  levels: true, subjects: true, rooms: true, fees: true, teachers: false };
describe('onboarding prerequisites', () => {
  it.each(['schoolInfoComplete', 'activeYear', 'levels', 'subjects', 'rooms', 'fees'] as const)(
    'requires %s', (key) => {
      expect(evaluateOnboarding({ ...ready, [key]: false })).toMatchObject({ canComplete: false, missing: [key] });
    });
  it('teachers remain optional', () => expect(evaluateOnboarding(ready).canComplete).toBe(true));
  it('explains who must open the year', () => {
    expect(new OnboardingPrerequisitesError(['activeYear']).message).toContain('super administrateur');
  });
  it('never writes completion when prerequisites have disappeared', async () => {
    const repository = Object.create(OnboardingRepository.prototype) as OnboardingRepository;
    vi.spyOn(repository, 'readState').mockResolvedValue({ ...ready, activeYear: false });
    const mark = vi.spyOn(repository, 'markCompleted').mockResolvedValue();
    vi.spyOn(repository, 'transaction').mockImplementation(async (work) => work(repository));
    await expect(new OnboardingService(repository).complete('school_a')).rejects.toBeInstanceOf(OnboardingPrerequisitesError);
    expect(mark).not.toHaveBeenCalled();
  });
});
