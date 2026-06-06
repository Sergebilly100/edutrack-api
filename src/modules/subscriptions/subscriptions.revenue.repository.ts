import type { TenantDb } from '../../shared/database/db.js';
import { and, eq, gte, lte, isNull, sql } from 'drizzle-orm';
import {
  parentSubscriptions,
  subscriptionPayments,
  subscriptionReversals,
} from '../../shared/database/schema/tenant.schema.js';

export function buildSubscriptionsRevenueRepository(db: TenantDb) {
  /**
   * Récupère les stats revenus abonnements pour un mois donné
   */
  async function getRevenueStatsForMonth(month: string, tenantId: string) {
    const monthStart = `${month}-01`;
    const [yearRaw, monthRaw] = month.split('-');
    const monthEnd = new Date(Date.UTC(Number(yearRaw), Number(monthRaw), 0)).toISOString().slice(0, 10);

    // Abonnements actifs ce mois
    const activeSubs = await db
      .select({
        id: parentSubscriptions.id,
        totalAmountFcfa: parentSubscriptions.totalAmountFcfa,
      })
      .from(parentSubscriptions)
      .where(
        and(
          eq(parentSubscriptions.status, 'active'),
          lte(parentSubscriptions.startsAt, monthEnd),
          gte(parentSubscriptions.endsAt, monthStart)
        )
      );

    const activeSubscribers = activeSubs.length;
    const expectedAmount = activeSubs.reduce((sum: number, sub) => sum + (sub.totalAmountFcfa ?? 0), 0);

    // Paiements encaissés ce mois
    const payments = await db
      .select({
        amountFcfa: subscriptionPayments.amountFcfa,
      })
      .from(subscriptionPayments)
      .where(
        and(
          gte(subscriptionPayments.paidAt, sql`${monthStart}::timestamp`),
          lte(subscriptionPayments.paidAt, sql`(${monthEnd} || ' 23:59:59')::timestamp`)
        )
      );

    const collectedAmount = payments.reduce((sum: number, p) => sum + (p.amountFcfa ?? 0), 0);
    const collectionRate = expectedAmount > 0 ? (collectedAmount / expectedAmount) * 100 : 0;

    // Récupérer ou créer le reversement du mois
    let reversal = await db
      .select()
      .from(subscriptionReversals)
      .where(
        and(
          eq(subscriptionReversals.tenantId, tenantId),
          eq(subscriptionReversals.month, month)
        )
      )
      .limit(1);

    // Créer le reversement s'il n'existe pas
    if (reversal.length === 0 && collectedAmount > 0) {
      const commissionRate = 10; // Défaut, à récupérer depuis tenant_settings si besoin
      const schoolGain = collectedAmount * (1 - commissionRate / 100);

      await db.insert(subscriptionReversals).values({
        tenantId,
        month,
        amountCollected: collectedAmount.toString(),
        commissionRate: commissionRate.toString(),
        schoolGain: schoolGain.toString(),
      });

      reversal = await db
        .select()
        .from(subscriptionReversals)
        .where(
          and(
            eq(subscriptionReversals.tenantId, tenantId),
            eq(subscriptionReversals.month, month)
          )
        )
        .limit(1);
    }

    const reversalRecord = reversal[0];
    const commissionRate = reversalRecord ? parseFloat(reversalRecord.commissionRate ?? '10') : 10;
    const edutrackCommission = collectedAmount * (commissionRate / 100);
    const schoolGain = collectedAmount - edutrackCommission;

    return {
      collectedAmount,
      activeSubscribers,
      collectionRate,
      expectedAmount,
      schoolGain,
      edutrackCommission,
      commissionRate,
      remainingToReverse: reversalRecord?.reversedAt ? 0 : schoolGain,
      nextReverseDate: null, // À implémenter selon la logique métier
      isReverseOverdue: false,
      overdueMonths: [],
    };
  }

  /**
   * Vérifie les mois en retard de reversement
   */
  async function getOverdueReversals(tenantId: string) {
    const now = new Date();
    const currentMonth = now.toISOString().slice(0, 7);

    const overdueReversals = await db
      .select()
      .from(subscriptionReversals)
      .where(
        and(
          eq(subscriptionReversals.tenantId, tenantId),
          isNull(subscriptionReversals.reversedAt),
          sql`${subscriptionReversals.month} < ${currentMonth}`
        )
      );

    return overdueReversals.map((rev) => {
      const dueDate = new Date(rev.month + '-15'); // Exemple : le 15 du mois
      const daysPastDue = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));

      return {
        month: getMonthLabel(rev.month),
        amount: parseFloat(rev.schoolGain ?? '0'),
        dueDate: dueDate.toISOString(),
        daysPastDue,
      };
    });
  }

  /**
   * Marque une notification de reversement en retard comme envoyée
   */
  async function markReversalNotificationSent(tenantId: string, month: string) {
    await db
      .update(subscriptionReversals)
      .set({
        notificationSentAt: new Date(),
      })
      .where(
        and(
          eq(subscriptionReversals.tenantId, tenantId),
          eq(subscriptionReversals.month, month)
        )
      );
  }

  return {
    getRevenueStatsForMonth,
    getOverdueReversals,
    markReversalNotificationSent,
  };
}

function getMonthLabel(month: string): string {
  const monthNames = [
    'Janvier',
    'Février',
    'Mars',
    'Avril',
    'Mai',
    'Juin',
    'Juillet',
    'Août',
    'Septembre',
    'Octobre',
    'Novembre',
    'Décembre',
  ];
  const [year, monthNum] = month.split('-');
  const index = parseInt(monthNum ?? '1', 10) - 1;
  return `${monthNames[index]} ${year}`;
}

export type SubscriptionsRevenueRepository = ReturnType<typeof buildSubscriptionsRevenueRepository>;
