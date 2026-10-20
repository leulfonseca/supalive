-- Disable only a recognized Supalive job. Keep tables and other jobs untouched.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';
SET LOCAL search_path = pg_catalog, public;
SELECT pg_advisory_xact_lock(hashtextextended('supalive:v1', 0));
DO $supalive_disable$
DECLARE
  managed_command constant text := replace($managed_command$/* supalive:v1:managed */
DO $supalive_heartbeat$
DECLARE
  relation_id oid;
  table_safe boolean;
BEGIN
  SET LOCAL search_path = pg_catalog, public;
  LOCK TABLE public.keep_alive IN SHARE ROW EXCLUSIVE MODE;
  relation_id := 'public.keep_alive'::regclass;
  IF obj_description(relation_id, 'pg_class')
     IS DISTINCT FROM 'supalive:v1:managed-table' THEN
    RAISE EXCEPTION 'SUPALIVE_TABLE_OWNERSHIP_CHANGED';
  END IF;
  SELECT c.relkind = 'r' AND NOT c.relispartition AND c.relrowsecurity AND NOT c.relforcerowsecurity
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
    AND NOT has_sequence_privilege('authenticated',pg_get_serial_sequence('public.keep_alive','id'),'USAGE,SELECT,UPDATE') INTO table_safe FROM pg_class c WHERE c.oid=relation_id;
  IF NOT coalesce(table_safe, false) THEN
    RAISE EXCEPTION 'SUPALIVE_TABLE_CONFLICT: managed table has changed or can affect other objects';
  END IF;
  INSERT INTO public.keep_alive (ping_time) VALUES (pg_catalog.clock_timestamp());
  DELETE FROM public.keep_alive WHERE ping_time < pg_catalog.now() - interval '7 days';
END;
$supalive_heartbeat$;$managed_command$, chr(13)||chr(10), chr(10));
  existing_command constant text := replace($existing_command$/* supalive:v1:existing */
SELECT id, ping_time FROM public.keep_alive LIMIT 1;$existing_command$, chr(13)||chr(10), chr(10));
  job_count integer;
  existing_job record;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE EXCEPTION 'SUPALIVE_NOT_INSTALLED';
  END IF;
  SELECT count(*) INTO job_count FROM cron.job WHERE jobname = 'supalive-keep-alive';
  IF job_count <> 1 THEN
    RAISE EXCEPTION 'SUPALIVE_JOB_CONFLICT: expected one recognized job';
  END IF;
  SELECT * INTO existing_job FROM cron.job WHERE jobname = 'supalive-keep-alive' FOR UPDATE;
  IF existing_job.username IS DISTINCT FROM current_user
     OR existing_job.database IS DISTINCT FROM current_database()
     OR replace(existing_job.command, chr(13)||chr(10), chr(10)) NOT IN (managed_command, existing_command) THEN
    RAISE EXCEPTION 'SUPALIVE_JOB_CONFLICT: job ownership or command differs';
  END IF;
  PERFORM cron.alter_job(existing_job.jobid, active := false);
END;
$supalive_disable$;
COMMIT;
