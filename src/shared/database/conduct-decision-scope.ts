import { sql } from 'drizzle-orm';

/** The sole authorization predicate for a conduct decision class.
 * Callers must bind `classes c` and `school_years sy` in the same query.
 */
export const authorizedConductClass = (userId: string, canFinalize: boolean) => sql`
  c.is_active = true AND EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = ${userId}::uuid AND u.is_active = true AND (
      (sy.conduct_decision_mode = 'homeroom' AND EXISTS (
        SELECT 1 FROM teachers t
        WHERE t.id = c.homeroom_teacher_id AND t.user_id = u.id
      )) OR
      (sy.conduct_decision_mode = 'direction' AND u.role = 'director') OR
      (sy.conduct_decision_mode = 'delegated' AND ${canFinalize} AND u.role = 'staff'
        AND EXISTS (
          SELECT 1 FROM position_assignments pa
          INNER JOIN admin_positions ap ON ap.id = pa.position_id
          WHERE pa.user_id = u.id AND ap.permissions @> '["conduct.finalize"]'::jsonb
        )
        AND EXISTS (
          SELECT 1 FROM educator_assignments ea
          WHERE ea.user_id = u.id AND (ea.class_id = c.id OR ea.level_id = c.level_id)
        ))
    )
  )
`;
