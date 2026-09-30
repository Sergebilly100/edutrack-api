/** Read-only, per-year inventory used by the C24 CLI and integration tests. */
export const POPULATION_DIAGNOSTIC_QUERY = String.raw`
          WITH eligible AS (
            SELECT DISTINCT e.student_id, e.class_id, e.school_year_id
            FROM enrollments e
            JOIN students s ON s.id = e.student_id AND s.is_active = true
            JOIN classes c ON c.id = e.class_id AND c.is_active = true
              AND c.school_year_id = e.school_year_id
            WHERE e.status = 'confirmed'
          )
          SELECT y.id::text AS school_year_id, y.label AS school_year,
            (SELECT COUNT(*)::int FROM students s JOIN classes c ON c.id = s.class_id
              WHERE s.is_active = true AND c.school_year_id = y.id) AS active_profiles_with_legacy_class,
            (SELECT COUNT(DISTINCT s.id)::int FROM students s JOIN classes c ON c.id = s.class_id
              WHERE s.is_active = true AND c.school_year_id = y.id
                AND NOT EXISTS (SELECT 1 FROM eligible en WHERE en.student_id = s.id AND en.school_year_id = y.id)) AS legacy_without_confirmation,
            (SELECT COUNT(*)::int FROM enrollments e WHERE e.school_year_id = y.id AND e.status = 'pending_cashier') AS pending_cashier,
            (SELECT COUNT(*)::int FROM enrollments e WHERE e.school_year_id = y.id AND e.status = 'pending_dossier') AS pending_dossier,
            (SELECT COUNT(*)::int FROM enrollments e WHERE e.school_year_id = y.id AND e.status = 'blocked_unpaid') AS blocked_unpaid,
            (SELECT COUNT(*)::int FROM enrollments e WHERE e.school_year_id = y.id AND e.status = 'confirmed') AS confirmed_enrollments,
            (SELECT COUNT(DISTINCT student_id)::int FROM eligible en WHERE en.school_year_id = y.id) AS expected_population,
            (SELECT COUNT(*)::int FROM student_period_averages spa JOIN grading_periods gp ON gp.id = spa.grading_period_id
              WHERE gp.school_year_id = y.id AND NOT EXISTS
                (SELECT 1 FROM eligible en WHERE en.student_id = spa.student_id AND en.school_year_id = y.id)) AS out_of_scope_averages,
            (SELECT COUNT(*)::int FROM report_cards rc JOIN grading_periods gp ON gp.id = rc.grading_period_id
              WHERE gp.school_year_id = y.id AND NOT EXISTS
                (SELECT 1 FROM eligible en WHERE en.student_id = rc.student_id AND en.class_id = rc.class_id AND en.school_year_id = y.id)) AS out_of_scope_report_cards,
            (SELECT COUNT(*)::int FROM class_decisions cd WHERE cd.school_year_id = y.id AND NOT EXISTS
                (SELECT 1 FROM eligible en WHERE en.student_id = cd.student_id AND en.school_year_id = y.id)) AS out_of_scope_decisions,
            (SELECT COUNT(*)::int FROM evaluation_grades eg JOIN evaluations ev ON ev.id = eg.evaluation_id
              JOIN classes c ON c.id = ev.class_id WHERE c.school_year_id = y.id AND NOT EXISTS
                (SELECT 1 FROM eligible en WHERE en.student_id = eg.student_id AND en.class_id = c.id AND en.school_year_id = y.id)) AS out_of_scope_grade_sources,
            (SELECT COUNT(*)::int FROM attendances_student ast JOIN schedules sch ON sch.id = ast.schedule_id
              JOIN classes c ON c.id = sch.class_id WHERE c.school_year_id = y.id AND NOT EXISTS
                (SELECT 1 FROM eligible en WHERE en.student_id = ast.student_id AND en.class_id = c.id AND en.school_year_id = y.id)) AS out_of_scope_attendances,
            (SELECT COUNT(*)::int FROM teacher_conduct_inputs tci JOIN grading_periods gp ON gp.id = tci.grading_period_id
              WHERE gp.school_year_id = y.id AND NOT EXISTS
                (SELECT 1 FROM eligible en WHERE en.student_id = tci.student_id AND en.class_id = tci.class_id AND en.school_year_id = y.id)) AS out_of_scope_conduct,
            (SELECT COUNT(*)::int FROM student_financial_status sfs WHERE sfs.school_year_id = y.id AND NOT EXISTS
                (SELECT 1 FROM eligible en WHERE en.student_id = sfs.student_id AND en.school_year_id = y.id)) AS out_of_scope_financial_cache,
            CASE WHEN y.status = 'active' THEN (SELECT COUNT(*)::int FROM student_risk_status srs WHERE NOT EXISTS
                (SELECT 1 FROM eligible en WHERE en.student_id = srs.student_id AND en.school_year_id = y.id)) ELSE 0 END AS out_of_scope_risk_snapshots,
            CASE WHEN y.status = 'active' THEN (SELECT COUNT(*)::int FROM parent_student_links psl WHERE NOT EXISTS
                (SELECT 1 FROM eligible en WHERE en.student_id = psl.student_id AND en.school_year_id = y.id)) ELSE 0 END AS out_of_scope_parent_links
          FROM school_years y ORDER BY y.start_date
`;
