import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

type QueryExecutor = NodePgDatabase<Record<string, unknown>>;

export type SubscriberType = 'user' | 'parent';

export type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export class PushRepository {
  constructor(private readonly db: QueryExecutor) {}

  /**
   * Enregistre (ou met à jour) un abonnement push. La clé d'unicité est
   * l'endpoint : si le même navigateur se réabonne, on rattache l'abonnement au
   * bon utilisateur et on rafraîchit les clés.
   */
  async upsert(input: {
    subscriberType: SubscriberType;
    subscriberId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string | null;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO push_subscriptions (
        subscriber_type, subscriber_id, endpoint, p256dh, auth, user_agent, last_used_at
      )
      VALUES (
        ${input.subscriberType},
        ${input.subscriberId}::uuid,
        ${input.endpoint},
        ${input.p256dh},
        ${input.auth},
        ${input.userAgent ?? null},
        NOW()
      )
      ON CONFLICT (endpoint) DO UPDATE SET
        subscriber_type = EXCLUDED.subscriber_type,
        subscriber_id = EXCLUDED.subscriber_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        user_agent = EXCLUDED.user_agent,
        last_used_at = NOW()
    `);
  }

  async deleteByEndpoint(endpoint: string): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}
    `);
  }

  async listForSubscriber(
    subscriberType: SubscriberType,
    subscriberId: string
  ): Promise<PushSubscriptionRow[]> {
    const result = await this.db.execute<PushSubscriptionRow>(sql`
      SELECT id::text, endpoint, p256dh, auth
      FROM push_subscriptions
      WHERE subscriber_type = ${subscriberType}
        AND subscriber_id = ${subscriberId}::uuid
    `);
    return result.rows;
  }

  /**
   * Parents liés à un élève (via parent_student_links). Sert à router une notif
   * d'absence vers les parents abonnés au push.
   */
  async listParentIdsForStudent(studentId: string): Promise<string[]> {
    const result = await this.db.execute<{ parent_id: string }>(sql`
      SELECT DISTINCT parent_id::text AS parent_id
      FROM parent_student_links
      WHERE student_id = ${studentId}::uuid
    `);
    return result.rows.map((row) => row.parent_id);
  }
}
