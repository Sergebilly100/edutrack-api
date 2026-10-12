-- Read-only audit. Run against a copy or with a read-only database account.
-- Reports counts per tenant, never student identity or dates.
DO $$
DECLARE
  tenant_record record;
  invalid_count bigint;
BEGIN
  FOR tenant_record IN SELECT id, schema_name FROM public.tenants LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I.students WHERE birth_date >= (now() AT TIME ZONE ''Africa/Abidjan'')::date',
      tenant_record.schema_name
    ) INTO invalid_count;
    RAISE NOTICE 'tenant id: %, birth dates today or future: %', tenant_record.id, invalid_count;
  END LOOP;
END $$;
