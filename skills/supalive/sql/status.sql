-- Read-only catalog inspection. Works before pg_cron or keep_alive exist.
SELECT
  current_user AS execution_user,
  current_database() AS execution_database,
  to_regclass('cron.job') IS NOT NULL AS cron_available,
  to_regclass('public.keep_alive') IS NOT NULL AS table_exists,
  (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('public.keep_alive')) AS table_kind,
  (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.keep_alive')) AS rls_enabled,
  coalesce(obj_description(to_regclass('public.keep_alive'), 'pg_class') = 'supalive:v1:managed-table', false) AS managed_table,
  coalesce((SELECT c.relkind = 'r' AND NOT c.relispartition AND c.relrowsecurity AND NOT c.relforcerowsecurity
    AND (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=2
    AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='id'
      AND a.atttypid='int8'::regtype AND a.attidentity='a' AND a.attnotnull AND a.attgenerated='')
    AND EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attname='ping_time' AND a.atttypid='timestamptz'::regtype
        AND a.attnotnull AND a.attidentity='' AND a.attgenerated=''
        AND pg_get_expr(d.adbin,d.adrelid) IN ('now()', 'pg_catalog.now()'))
    AND (SELECT count(*) FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='p'
      AND k.conkey=ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='id')])=1
    AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE (k.confrelid=c.oid AND k.contype='f')
      OR (k.conrelid=c.oid AND k.contype NOT IN ('p','n')))
    AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
    AND NOT EXISTS(SELECT 1 FROM pg_rewrite r WHERE r.ev_class=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid
      AND (NOT i.indisprimary OR i.indexprs IS NOT NULL OR i.indpred IS NOT NULL))
    AND NOT has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_sequence_privilege('anon',pg_get_serial_sequence('public.keep_alive','id'),'USAGE,SELECT,UPDATE')
    AND NOT has_sequence_privilege('authenticated',pg_get_serial_sequence('public.keep_alive','id'),'USAGE,SELECT,UPDATE') FROM pg_class c WHERE c.oid=to_regclass('public.keep_alive')), false) AS managed_table_safe,
  coalesce((SELECT jsonb_agg(jsonb_build_object('name', attname, 'type', format_type(atttypid, atttypmod), 'identity', attidentity) ORDER BY attnum)
    FROM pg_attribute WHERE attrelid = to_regclass('public.keep_alive')
      AND attnum > 0 AND NOT attisdropped), '[]'::jsonb) AS columns;
