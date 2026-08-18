import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';

import type { NotificationJobData } from '../notifications/notifications.queue.js';
import { generateInitialPassword } from '../../shared/utils/password-generator.js';
import {
  ParentAccountsRepository,
  type ParentAccessRecord,
  type TemporaryCredentials,
} from './parent-accounts.repository.js';

type SmsQueue = {
  add: (name: string, data: NotificationJobData, options?: Record<string, unknown>) => Promise<unknown>;
};

type ParentAccountsDependencies = {
  smsQueue?: SmsQueue;
  passwordGenerator: (length?: number) => string;
  passwordHasher: (plainPassword: string) => Promise<string>;
  appBaseUrl: string;
};

export class ParentAccountsModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'ParentAccountsModuleError';
  }
}

const normalizeAppBaseUrl = (value: string): string => value.replace(/\/+$/, '');

export const createTemporaryParentCredentials = async (
  dependencies: Pick<ParentAccountsDependencies, 'passwordGenerator' | 'passwordHasher'> = {
    passwordGenerator: generateInitialPassword,
    passwordHasher: argon2.hash,
  }
): Promise<TemporaryCredentials> => {
  const plainPassword = dependencies.passwordGenerator(10);
  const passwordHash = await dependencies.passwordHasher(plainPassword);
  return { plainPassword, passwordHash };
};

export const buildParentAccessSms = (input: {
  loginUrl: string;
  phone: string;
  temporaryPassword: string;
}): string =>
  [
    'IvoirEdu - Vos acces parent',
    `Connexion: ${input.loginUrl}`,
    `Telephone: ${input.phone}`,
    `Mot de passe temporaire: ${input.temporaryPassword}`,
    'Vous devrez le modifier lors de votre premiere connexion.',
  ].join('\n');

export type ParentAccessDispatchItem = {
  parentId: string;
  status: 'queued' | 'already_sent' | 'not_found' | 'failed';
};

export class ParentAccountsService {
  private readonly deps: ParentAccountsDependencies;

  constructor(
    private readonly repository: ParentAccountsRepository,
    dependencies: Partial<ParentAccountsDependencies> = {}
  ) {
    this.deps = {
      smsQueue: dependencies.smsQueue,
      passwordGenerator: dependencies.passwordGenerator ?? generateInitialPassword,
      passwordHasher: dependencies.passwordHasher ?? argon2.hash,
      appBaseUrl: normalizeAppBaseUrl(
        dependencies.appBaseUrl ?? process.env.APP_BASE_URL ?? 'http://localhost:5173'
      ),
    };
  }

  async queuePreparedAccess(input: {
    schemaName: string;
    parentId: string;
    phone: string;
    temporaryPassword: string;
  }): Promise<void> {
    if (!this.deps.smsQueue) {
      throw new ParentAccountsModuleError(
        'SMS queue is unavailable',
        503,
        'PARENT_ACCESS_QUEUE_UNAVAILABLE'
      );
    }

    const queueRef = randomUUID();
    const message = buildParentAccessSms({
      loginUrl: `${this.deps.appBaseUrl}/parent/login`,
      phone: input.phone,
      temporaryPassword: input.temporaryPassword,
    });

    await this.repository.insertAccessNotification({
      parentId: input.parentId,
      phone: input.phone,
      message,
      queueRef,
    });

    try {
      await this.deps.smsQueue.add(
        'send-sms',
        {
          type: 'send-sms',
          to: input.phone,
          message,
          notificationType: 'parent_access_credentials',
          schemaName: input.schemaName,
          relatedId: input.parentId,
          recipientPhone: input.phone,
          queueRef,
          parentAccessSentUpdate: { parentId: input.parentId },
        },
        {
          jobId: queueRef,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: { count: 1000 },
        }
      );
    } catch (error) {
      await this.repository.markAccessNotificationFailed(queueRef).catch(() => undefined);
      throw error;
    }
  }

  async sendPendingAccess(input: {
    schemaName: string;
    parentIds: string[];
  }): Promise<{ items: ParentAccessDispatchItem[]; queued: number }> {
    if (!this.deps.smsQueue) {
      throw new ParentAccountsModuleError(
        'SMS queue is unavailable',
        503,
        'PARENT_ACCESS_QUEUE_UNAVAILABLE'
      );
    }

    const distinctIds = Array.from(new Set(input.parentIds));
    const parents = await this.repository.listByIds(distinctIds);
    const byId = new Map<string, ParentAccessRecord>(parents.map((parent) => [parent.id, parent]));
    const items: ParentAccessDispatchItem[] = [];

    for (const parentId of distinctIds) {
      const parent = byId.get(parentId);
      if (!parent) {
        items.push({ parentId, status: 'not_found' });
        continue;
      }
      if (parent.accessSentAt) {
        items.push({ parentId, status: 'already_sent' });
        continue;
      }

      try {
        const credentials = await createTemporaryParentCredentials(this.deps);
        await this.repository.updateTemporaryPassword(parent.id, credentials.passwordHash);
        await this.queuePreparedAccess({
          schemaName: input.schemaName,
          parentId: parent.id,
          phone: parent.phone,
          temporaryPassword: credentials.plainPassword,
        });
        items.push({ parentId, status: 'queued' });
      } catch {
        // Un échec SMS ne bloque pas les autres parents du lot. access_sent_at
        // reste NULL et l'envoi peut être redéclenché sans ambiguïté.
        items.push({ parentId, status: 'failed' });
      }
    }

    return {
      items,
      queued: items.filter((item) => item.status === 'queued').length,
    };
  }
}
