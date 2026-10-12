import { describe, expect, it, vi } from 'vitest';
import argon2 from 'argon2';
import {
  ParentAccountsModuleError,
  ParentAccountsService,
  buildParentAccessEmail,
  buildParentLoginUrl,
  isUsableParentEmail,
  isUsableParentPhone,
} from '../../src/modules/parents/parent-accounts.service.js';
import type { ParentAccountsRepository } from '../../src/modules/parents/parent-accounts.repository.js';

const parentId = '11111111-1111-4111-8111-111111111111';
const parent = { id: parentId, fullName: 'Parent', phone: '2250700000001', email: 'parent@example.ci', accessSentAt: null };

const setup = (record = parent) => {
  const repository = {
    listByIds: vi.fn().mockResolvedValue([record]),
    getTenantSubdomain: vi.fn().mockResolvedValue('sainte-marie'),
    getPasswordHashForUpdate: vi.fn(),
    updateTemporaryPassword: vi.fn(),
    recordRotation: vi.fn(),
    insertAccessNotification: vi.fn(),
    getRotationStatuses: vi.fn(),
    transaction: vi.fn(async (callback: (value: unknown) => Promise<unknown>) => callback(repository)),
  };
  const jobs: Array<{ remove: ReturnType<typeof vi.fn> }> = [];
  const queue = {
    add: vi.fn().mockImplementation(async () => {
      const job = { remove: vi.fn().mockResolvedValue(undefined) };
      jobs.push(job);
      return job;
    }),
  };
  const service = new ParentAccountsService(repository as unknown as ParentAccountsRepository, {
    smsQueue: queue,
    appBaseUrl: 'https://ecole.ivoiredu.ci/',
    passwordGenerator: () => 'SAFE234567',
    passwordHasher: async () => 'argon-hash',
  });
  return { repository, queue, jobs, service };
};

describe('rotation des accès parent', () => {
  it('valide chaque coordonnée et exige un choix explicite pour la remise manuelle', async () => {
    expect(isUsableParentPhone('2250700000001')).toBe(true);
    expect(isUsableParentPhone('0700000001')).toBe(false);
    expect(isUsableParentEmail('parent@example.ci')).toBe(true);
    expect(isUsableParentEmail('parent@')).toBe(false);
    expect(buildParentLoginUrl('https://app.ivoiredu.ci', 'sainte-marie'))
      .toBe('https://sainte-marie.ivoiredu.ci/parent/login');
    const { service } = setup();
    await expect(service.resetAccess({ schemaName: 'school_test', parentId, actorUserId: null, channels: [] }))
      .rejects.toMatchObject({ code: 'PARENT_ACCESS_CHANNEL_REQUIRED' });
    const missingEmail = setup({ ...parent, email: null });
    await expect(missingEmail.service.resetAccess({ schemaName: 'school_test', parentId, actorUserId: null, channels: ['email'] }))
      .rejects.toMatchObject({ code: 'PARENT_EMAIL_UNAVAILABLE' });
  });

  it('crée une seule rotation, un hash et deux jobs avec le même secret', async () => {
    const { service, repository, queue } = setup();
    const result = await service.resetAccess({
      schemaName: 'school_test', parentId, actorUserId: '22222222-2222-4222-8222-222222222222', channels: ['sms', 'email'],
    });
    expect(result.new_temp_password).toBe('SAFE234567');
    expect(result.channels).toEqual([{ channel: 'sms', status: 'queued' }, { channel: 'email', status: 'queued' }]);
    expect(repository.updateTemporaryPassword).toHaveBeenCalledOnce();
    expect(repository.updateTemporaryPassword).toHaveBeenCalledWith(parentId, 'argon-hash');
    expect(repository.recordRotation).toHaveBeenCalledOnce();
    expect(repository.insertAccessNotification).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(repository.insertAccessNotification.mock.calls)).not.toContain('SAFE234567');
    expect(queue.add).toHaveBeenCalledTimes(2);
    for (const call of queue.add.mock.calls) {
      expect(JSON.stringify(call[1])).toContain('SAFE234567');
      expect(call[2]).toMatchObject({ removeOnComplete: true, removeOnFail: true });
    }
    expect(buildParentAccessEmail({ loginUrl: 'https://ecole.ivoiredu.ci/parent/login', phone: parent.phone, temporaryPassword: 'SAFE234567' }))
      .toContain('SAFE234567');
  });

  it('retire le premier job si le second canal ne peut pas être mis en file', async () => {
    const { service, queue, jobs } = setup();
    queue.add.mockImplementationOnce(async () => {
      const job = { remove: vi.fn().mockResolvedValue(undefined) };
      jobs.push(job);
      return job;
    }).mockRejectedValueOnce(new Error('provider details must not leak'));
    await expect(service.resetAccess({ schemaName: 'school_test', parentId, actorUserId: null, channels: ['sms', 'email'] }))
      .rejects.toMatchObject({ code: 'PARENT_ACCESS_QUEUE_UNAVAILABLE' } satisfies Partial<ParentAccountsModuleError>);
    expect(jobs[0]?.remove).toHaveBeenCalledOnce();
  });

  it('permet la copie de secours quand aucune coordonnée n’est disponible', async () => {
    const { service, queue } = setup({ ...parent, phone: '', email: null });
    const result = await service.resetAccess({ schemaName: 'school_test', parentId, actorUserId: null, channels: [], manualOnly: true });
    expect(result.channels).toEqual([]);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('n’envoie un accès préparé que si son secret correspond encore au hash actuel', async () => {
    const { service, repository, queue } = setup();
    repository.getPasswordHashForUpdate.mockResolvedValue(await argon2.hash('SAFE234567'));
    await service.queuePreparedAccess({ schemaName: 'school_test', parentId, phone: parent.phone, temporaryPassword: 'SAFE234567' });
    expect(repository.transaction).toHaveBeenCalledOnce();
    expect(repository.recordRotation).toHaveBeenCalledWith(expect.objectContaining({ action: 'prepared' }));
    expect(JSON.stringify(repository.insertAccessNotification.mock.calls)).not.toContain('SAFE234567');
    expect(queue.add).toHaveBeenCalledOnce();

    repository.getPasswordHashForUpdate.mockResolvedValue(await argon2.hash('DIFFERENT9'));
    await expect(service.queuePreparedAccess({ schemaName: 'school_test', parentId, phone: parent.phone, temporaryPassword: 'SAFE234567' }))
      .rejects.toMatchObject({ code: 'PARENT_ACCESS_SUPERSEDED' });
    expect(queue.add).toHaveBeenCalledOnce();
  });
});
