import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { NotificationJobData } from '../notifications/notifications.queue.js';
import { generateInitialPassword } from '../../shared/utils/password-generator.js';
import {
  ParentAccountsRepository,
  type ParentAccessRecord,
  type TemporaryCredentials,
} from './parent-accounts.repository.js';

type SmsQueue = {
  add: (name: string, data: NotificationJobData, options?: Record<string, unknown>) => Promise<{ remove?: () => Promise<void> } | unknown>;
};

export type ParentAccessChannel = 'sms' | 'email';
export type ParentAccessResult = {
  parent_id: string;
  login: string;
  new_temp_password: string;
  rotation_id: string;
  channels: Array<{ channel: ParentAccessChannel; status: 'queued' | 'failed' }>;
};

export const isUsableParentPhone = (value: string | null | undefined): boolean => /^225\d{10}$/.test(value ?? '');
export const isUsableParentEmail = (value: string | null | undefined): boolean =>
  z.email().safeParse(value).success;

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

export const buildParentLoginUrl = (appBaseUrl: string, subdomain: string | null): string => {
  const base = new URL(appBaseUrl);
  if (subdomain && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(subdomain) &&
      (base.hostname === 'ivoiredu.ci' || base.hostname.endsWith('.ivoiredu.ci'))) {
    base.hostname = `${subdomain}.ivoiredu.ci`;
  }
  return `${base.origin}/parent/login`;
};

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

export const buildParentAccessEmail = (input: { loginUrl: string; phone: string; temporaryPassword: string }): string =>
  [
    'Bonjour,',
    'Voici votre accès parent IvoirEdu.',
    `Connexion : ${input.loginUrl}`,
    `Identifiant : ${input.phone}`,
    `Mot de passe temporaire : ${input.temporaryPassword}`,
    'Vous devrez modifier ce mot de passe lors de votre première connexion.',
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

  async resetAccess(input: {
    schemaName: string;
    parentId: string;
    actorUserId: string | null;
    channels: ParentAccessChannel[];
    manualOnly?: boolean;
  }): Promise<ParentAccessResult> {
    const requested = Array.from(new Set(input.channels));
    if (requested.length === 0 && !input.manualOnly) {
      throw new ParentAccountsModuleError('Select a delivery channel', 400, 'PARENT_ACCESS_CHANNEL_REQUIRED');
    }
    const parent = (await this.repository.listByIds([input.parentId]))[0];
    if (!parent) throw new ParentAccountsModuleError('Parent not found', 404, 'PARENT_NOT_FOUND');
    if (requested.includes('sms') && !isUsableParentPhone(parent.phone)) {
      throw new ParentAccountsModuleError('Parent phone is unavailable', 422, 'PARENT_PHONE_UNAVAILABLE');
    }
    if (requested.includes('email') && !isUsableParentEmail(parent.email)) {
      throw new ParentAccountsModuleError('Parent email is unavailable', 422, 'PARENT_EMAIL_UNAVAILABLE');
    }
    if (requested.length > 0 && !this.deps.smsQueue) {
      throw new ParentAccountsModuleError('Notification queue is unavailable', 503, 'PARENT_ACCESS_QUEUE_UNAVAILABLE');
    }

    const credentials = await createTemporaryParentCredentials(this.deps);
    const rotationId = randomUUID();
    const enqueued: Array<{ remove?: () => Promise<void> }> = [];
    let queueFailure = false;
    const loginUrl = buildParentLoginUrl(this.deps.appBaseUrl, await this.repository.getTenantSubdomain(input.schemaName));
    try {
      await this.repository.transaction(async (repository) => {
        await repository.updateTemporaryPassword(parent.id, credentials.passwordHash);
        const current = (await repository.listByIds([parent.id]))[0];
        if (!current || current.phone !== parent.phone || current.email !== parent.email) {
          throw new ParentAccountsModuleError('Parent contact changed; reopen the dialog', 409, 'PARENT_CONTACT_CHANGED');
        }
        await repository.recordRotation({ parentId: parent.id, phone: parent.phone, actorUserId: input.actorUserId, rotationId });
        for (const channel of requested) {
          const queueRef = randomUUID();
          await repository.insertAccessNotification({
            parentId: parent.id, phone: parent.phone, email: channel === 'email' ? parent.email : null,
            channel, actorUserId: input.actorUserId, rotationId, queueRef,
          });
          const common = {
            notificationType: 'parent_access_credentials' as const,
            schemaName: input.schemaName,
            relatedId: parent.id,
            recipientPhone: parent.phone,
            queueRef,
            parentAccessSentUpdate: { parentId: parent.id },
            parentAccessRotationId: rotationId,
          };
          const data: NotificationJobData = channel === 'sms'
            ? { ...common, type: 'send-sms', to: parent.phone, message: buildParentAccessSms({ loginUrl, phone: parent.phone, temporaryPassword: credentials.plainPassword }) }
            : { ...common, type: 'send-email', to: parent.email!, recipientEmail: parent.email!, subject: 'Votre accès parent IvoirEdu', text: buildParentAccessEmail({ loginUrl, phone: parent.phone, temporaryPassword: credentials.plainPassword }) };
          // Le délai laisse la transaction tenant se terminer avant le traitement du job.
          const job = await this.deps.smsQueue!.add(channel === 'sms' ? 'send-sms' : 'send-email', data, {
            jobId: queueRef, delay: 5_000, attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: true,
          }).catch((error: unknown) => { queueFailure = true; throw error; });
          enqueued.push(job as { remove?: () => Promise<void> });
        }
      });
    } catch (error) {
      await Promise.allSettled(enqueued.map((job) => job.remove?.()));
      if (error instanceof ParentAccountsModuleError) throw error;
      throw queueFailure
        ? new ParentAccountsModuleError('Unable to queue parent access', 503, 'PARENT_ACCESS_QUEUE_UNAVAILABLE')
        : new ParentAccountsModuleError('Unable to reset parent access', 500, 'PARENT_ACCESS_RESET_FAILED');
    }
    return {
      parent_id: parent.id, login: parent.phone, new_temp_password: credentials.plainPassword,
      rotation_id: rotationId, channels: requested.map((channel) => ({ channel, status: 'queued' })),
    };
  }

  getRotationStatuses(parentId: string, rotationId: string) {
    return this.repository.getRotationStatuses(parentId, rotationId);
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
    const rotationId = randomUUID();
    const message = buildParentAccessSms({
      loginUrl: buildParentLoginUrl(this.deps.appBaseUrl, await this.repository.getTenantSubdomain(input.schemaName)),
      phone: input.phone,
      temporaryPassword: input.temporaryPassword,
    });

    let job: { remove?: () => Promise<void> } | undefined;
    let queueFailure = false;
    try {
      await this.repository.transaction(async (repository) => {
        const currentHash = await repository.getPasswordHashForUpdate(input.parentId);
        if (!currentHash || !(await argon2.verify(currentHash, input.temporaryPassword))) {
          throw new ParentAccountsModuleError('Prepared access was superseded', 409, 'PARENT_ACCESS_SUPERSEDED');
        }
        await repository.recordRotation({ parentId: input.parentId, phone: input.phone, actorUserId: null, rotationId, action: 'prepared' });
        await repository.insertAccessNotification({ parentId: input.parentId, phone: input.phone, rotationId, queueRef });
        job = await this.deps.smsQueue!.add('send-sms', {
          type: 'send-sms', to: input.phone, message,
          notificationType: 'parent_access_credentials', schemaName: input.schemaName,
          relatedId: input.parentId, recipientPhone: input.phone, queueRef,
          parentAccessSentUpdate: { parentId: input.parentId }, parentAccessRotationId: rotationId,
        }, {
          jobId: queueRef, delay: 5_000, attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: true,
        }).catch((error: unknown) => { queueFailure = true; throw error; }) as { remove?: () => Promise<void> };
      });
    } catch (error) {
      await job?.remove?.().catch(() => undefined);
      if (error instanceof ParentAccountsModuleError) throw error;
      throw queueFailure
        ? new ParentAccountsModuleError('Unable to queue parent access', 503, 'PARENT_ACCESS_QUEUE_UNAVAILABLE')
        : new ParentAccountsModuleError('Unable to prepare parent access', 500, 'PARENT_ACCESS_PREPARATION_FAILED');
    }
  }

  async sendPendingAccess(input: {
    schemaName: string;
    parentIds: string[];
    actorUserId?: string | null;
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
        await this.resetAccess({ schemaName: input.schemaName, parentId: parent.id, actorUserId: input.actorUserId ?? null, channels: ['sms'] });
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
