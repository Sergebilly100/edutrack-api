import type { PaymentStatus } from './finance.calculations.js';

export type StatementMovement = {
  id: string;
  amount: number;
  status: PaymentStatus;
  paymentDate: string;
};

export const calculateRunningBalances = <T extends StatementMovement>(
  totalDue: number,
  movements: readonly T[]
): Array<T & { runningPaid: number; balanceAfter: number }> => {
  let runningPaid = 0;
  return movements.map((movement) => {
    if (movement.status === 'confirmed') runningPaid += movement.amount;
    return {
      ...movement,
      runningPaid: Math.round(runningPaid * 100) / 100,
      balanceAfter: Math.max(0, Math.round((totalDue - runningPaid) * 100) / 100),
    };
  });
};
