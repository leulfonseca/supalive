import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expectedCommands, assessStatus } from '../skills/supalive/scripts/supalive.mjs';

// Optional local PostgreSQL validation. No Supabase credentials or remote calls.
const { PGlite } = await import(process.env.SUPALIVE_PGLITE_MODULE || '@electric-sql/pglite');
const readSql = (name) => readFileSync(new URL(`../skills/supalive/sql/${name}.sql`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// PGlite has no pg_cron scheduler. Only extension creation is omitted; SQL guards,
// transactions, tables, RLS, catalog checks and heartbeat bodies run in Postgres.
const setup = readSql('setup').replace(/^CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;\r?\n/m, '');
const fixture = `
  CREATE ROLE anon; CREATE ROLE authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
  CREATE SCHEMA cron;
  CREATE TABLE cron.job (
    jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    jobname text NOT NULL, schedule text NOT NULL, command text NOT NULL,
    username text NOT NULL DEFAULT current_user,
    database text NOT NULL DEFAULT current_database(), active boolean NOT NULL DEFAULT true,
    UNIQUE(jobname, username)
  );
  CREATE FUNCTION cron.schedule(job_name text, sched text, cmd text) RETURNS bigint LANGUAGE plpgsql AS $$
  DECLARE new_id bigint;
  BEGIN
    INSERT INTO cron.job(jobname, schedule, command) VALUES(job_name, sched, cmd) RETURNING jobid INTO new_id;
    RETURN new_id;
  END $$;
  CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
    database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL)
  RETURNS void LANGUAGE sql AS $$
    UPDATE cron.job j SET schedule=coalesce($2,j.schedule), command=coalesce($3,j.command),
      database=coalesce($4,j.database), username=coalesce($5,j.username), active=coalesce($6,j.active)
      WHERE j.jobid=$1;
  $$;
`;
async function database() {
  const db = new PGlite();
  await db.exec(fixture);
  return db;
}
async function rows(db, statement) { return (await db.query(statement)).rows; }
async function rejectedTransaction(db, statement, pattern) {
  await assert.rejects(db.exec(statement), pattern);
  await db.exec('ROLLBACK;');
}

test('SQL installs once, preserves unrelated jobs, secures new table and limits only its own history', async () => {
  const db = await database();
  try {
    await db.exec("SELECT cron.schedule('unrelated', '* * * * *', 'SELECT 123;');");
    await db.exec(setup);
    const first = await rows(db, 'SELECT * FROM cron.job ORDER BY jobid');
    assert.equal(first.length, 2);
    await db.exec("INSERT INTO public.keep_alive(ping_time) VALUES(now()-interval '10 days'),(now());");
    await db.exec("UPDATE cron.job SET schedule='* * * * *',active=false WHERE jobname='supalive-keep-alive';");
    await db.exec(setup);
    const after = await rows(db, 'SELECT * FROM cron.job ORDER BY jobid');
    assert.equal(after.length, 2);
    assert.deepEqual(after[0], first[0]);
    assert.equal(after[1].jobid, first[1].jobid);
    assert.equal((await rows(db, 'SELECT * FROM public.keep_alive')).length, 2);
    const [catalog] = await rows(db, readSql('status'));
    assert.equal(catalog.rls_enabled, true);
    assert.equal(assessStatus(catalog, await rows(db, readSql('status-jobs'))).enabled, true);
    const [access] = await rows(db, `SELECT has_table_privilege('anon','public.keep_alive','INSERT') AS anon_insert,
      has_table_privilege('authenticated','public.keep_alive','SELECT') AS user_select,
      (SELECT count(*)::int FROM pg_policies WHERE schemaname='public' AND tablename='keep_alive') AS policies`);
    assert.deepEqual(access, { anon_insert: false, user_select: false, policies: 0 });
    const [sequenceAccess] = await rows(db, `SELECT has_sequence_privilege('anon',pg_get_serial_sequence('public.keep_alive','id'),'USAGE') AS anon_usage`);
    assert.equal(sequenceAccess.anon_usage, false);
    await db.exec(after[1].command);
    const [history] = await rows(db, "SELECT count(*)::int AS total,count(*) FILTER(WHERE ping_time < now()-interval '7 days')::int AS old FROM public.keep_alive");
    assert.deepEqual(history, { total: 2, old: 0 });
  } finally { await db.close(); }
});

test('existing table with additional required column keeps schema, policies and every row', async () => {
  const db = await database();
  try {
    await db.exec(`CREATE TABLE public.keep_alive(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, ping_time timestamptz, application_field text NOT NULL);
      ALTER TABLE public.keep_alive ENABLE ROW LEVEL SECURITY;
      CREATE POLICY app_select ON public.keep_alive FOR SELECT TO anon USING(true);
      COMMENT ON TABLE public.keep_alive IS 'application-owned';
      INSERT INTO public.keep_alive(ping_time,application_field) VALUES(now()-interval '30 days','preserve me');`);
    const before = await rows(db, 'SELECT * FROM public.keep_alive');
    await db.exec(setup);
    await db.exec(setup);
    const [job] = await rows(db, readSql('status-jobs'));
    assert.equal(job.command, expectedCommands().existing);
    await db.exec(job.command);
    assert.deepEqual(await rows(db, 'SELECT * FROM public.keep_alive'), before);
    assert.equal((await rows(db, "SELECT * FROM pg_policies WHERE policyname='app_select'")).length, 1);
    const [catalog] = await rows(db, readSql('status'));
    assert.equal(catalog.columns.length, 3);
    assert.equal(catalog.managed_table, false);
    assert.equal(assessStatus(catalog, [job]).enabled, true);
  } finally { await db.close(); }
});

test('incompatible existing table fails without altering data or installing job', async () => {
  const db = await database();
  try {
    await db.exec("CREATE TABLE public.keep_alive(id text); INSERT INTO public.keep_alive VALUES('keep');");
    await rejectedTransaction(db, setup, /SUPALIVE_TABLE_CONFLICT/);
    assert.deepEqual(await rows(db, 'SELECT * FROM public.keep_alive'), [{ id: 'keep' }]);
    assert.equal((await rows(db, 'SELECT * FROM cron.job')).length, 0);
  } finally { await db.close(); }
});

test('unknown same-name cron command causes transaction rollback, preserving existing job', async () => {
  const db = await database();
  try {
    await db.exec("SELECT cron.schedule('supalive-keep-alive','1 1 * * *','SELECT 99;');");
    const before = await rows(db, 'SELECT * FROM cron.job');
    await rejectedTransaction(db, setup, /SUPALIVE_JOB_CONFLICT/);
    assert.deepEqual(await rows(db, 'SELECT * FROM cron.job'), before);
    assert.equal((await rows(db, "SELECT to_regclass('public.keep_alive') AS relation"))[0].relation, null);
  } finally { await db.close(); }
});

test('same-name job owned by another role or database is never adopted', async () => {
  for (const field of ['username', 'database']) {
    const db = await database();
    try {
      await db.exec(setup);
      await db.exec(`UPDATE cron.job SET ${field}='other';`);
      const before = await rows(db, 'SELECT * FROM cron.job');
      await rejectedTransaction(db, setup, /SUPALIVE_JOB_CONFLICT/);
      await rejectedTransaction(db, readSql('disable'), /SUPALIVE_JOB_CONFLICT/);
      assert.deepEqual(await rows(db, 'SELECT * FROM cron.job'), before);
    } finally { await db.close(); }
  }
});

test('disable changes only own active flag, keeps table and rejects command tampering', async () => {
  const db = await database();
  try {
    await db.exec(setup);
    await db.exec("SELECT cron.schedule('unrelated','* * * * *','SELECT 123;'); INSERT INTO public.keep_alive DEFAULT VALUES;");
    await db.exec(readSql('disable'));
    await db.exec(readSql('disable'));
    const jobs = await rows(db, 'SELECT * FROM cron.job ORDER BY jobid');
    assert.equal(jobs[0].active, false);
    assert.equal(jobs[1].active, true);
    assert.equal((await rows(db, 'SELECT * FROM public.keep_alive')).length, 1);
    await db.exec("UPDATE cron.job SET active=true,command='SELECT 99;' WHERE jobname='supalive-keep-alive';");
    await rejectedTransaction(db, readSql('disable'), /SUPALIVE_JOB_CONFLICT/);
    assert.equal((await rows(db, readSql('status-jobs')))[0].active, true);
  } finally { await db.close(); }
});

test('heartbeat refuses cleanup after ownership marker changes', async () => {
  const db = await database();
  try {
    await db.exec(setup);
    await db.exec("INSERT INTO public.keep_alive(ping_time) VALUES(now()-interval '30 days'); COMMENT ON TABLE public.keep_alive IS 'application-owned';");
    const [job] = await rows(db, readSql('status-jobs'));
    await assert.rejects(db.exec(job.command), /SUPALIVE_TABLE_OWNERSHIP_CHANGED/);
    assert.equal((await rows(db, 'SELECT * FROM public.keep_alive')).length, 1);
  } finally { await db.close(); }
});


test('only the real identity sequence is secured; a preexisting same-name sequence is preserved', async () => {
  const db = await database();
  try {
    await db.exec('CREATE SEQUENCE public.keep_alive_id_seq;');
    const before = await rows(db, "SELECT has_sequence_privilege('anon','public.keep_alive_id_seq','USAGE') AS allowed");
    assert.equal(before[0].allowed, true);
    await db.exec(setup);
    const [sequence] = await rows(db, "SELECT pg_get_serial_sequence('public.keep_alive','id') AS actual");
    assert.notEqual(sequence.actual, 'public.keep_alive_id_seq');
    assert.deepEqual(await rows(db, "SELECT has_sequence_privilege('anon','public.keep_alive_id_seq','USAGE') AS allowed"), before);
    assert.equal((await rows(db, `SELECT has_sequence_privilege('anon','${sequence.actual}','USAGE') AS allowed`))[0].allowed, false);
  } finally { await db.close(); }
});

test('managed heartbeat refuses table changes that could affect other application data', async () => {
  const alterations = [
    "CREATE TABLE public.child(id bigint REFERENCES public.keep_alive(id) ON DELETE CASCADE); INSERT INTO public.child SELECT id FROM public.keep_alive;",
    "CREATE RULE preserve_application AS ON DELETE TO public.keep_alive DO ALSO SELECT 1;",
    `CREATE FUNCTION public.app_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
      CREATE TRIGGER application_trigger BEFORE INSERT ON public.keep_alive FOR EACH ROW EXECUTE FUNCTION public.app_trigger();`,
    "ALTER TABLE public.keep_alive ADD CONSTRAINT app_check CHECK(ping_time < now()+interval '1 year');",
    "ALTER TABLE public.keep_alive ALTER COLUMN ping_time SET DEFAULT clock_timestamp();",
    "ALTER TABLE public.keep_alive ADD COLUMN application_data text;",
    "ALTER TABLE public.keep_alive DISABLE ROW LEVEL SECURITY;",
    "ALTER TABLE public.keep_alive FORCE ROW LEVEL SECURITY;",
    "CREATE POLICY app_policy ON public.keep_alive FOR SELECT USING(true);",
    "CREATE INDEX app_index ON public.keep_alive(ping_time);",
  ];
  for (const alteration of alterations) {
    const db = await database();
    try {
      await db.exec(setup);
      await db.exec("INSERT INTO public.keep_alive(ping_time) VALUES(now()-interval '30 days');");
      const [job] = await rows(db, readSql('status-jobs'));
      await db.exec(alteration);
      await assert.rejects(db.exec(job.command), /SUPALIVE_TABLE_CONFLICT/);
      const [count] = await rows(db, 'SELECT count(*)::int AS total FROM public.keep_alive');
      assert.equal(count.total, 1);
      if (alteration.includes('CREATE TABLE public.child')) assert.equal((await rows(db, 'SELECT count(*)::int AS total FROM public.child'))[0].total, 1);
      await rejectedTransaction(db, setup, /SUPALIVE_TABLE_CONFLICT/);
    } finally { await db.close(); }
  }
});

test('CRLF and LF installs, status and disable interoperate without adopting changed commands', async () => {
  const db = await database();
  try {
    await db.exec(setup.replace(/\n/g, '\r\n'));
    // Also cover a legacy job persisted before command normalization.
    await db.exec("UPDATE cron.job SET command=replace(command,chr(10),chr(13)||chr(10));");
    const [schema] = await rows(db, readSql('status'));
    assert.equal(assessStatus(schema, await rows(db, readSql('status-jobs'))).enabled, true);
    await db.exec(setup);
    await db.exec(readSql('disable').replace(/\n/g, '\r\n'));
    assert.equal((await rows(db, readSql('status-jobs')))[0].active, false);
    await db.exec(setup.replace(/\n/g, '\r\n'));
    await db.exec(readSql('disable'));
    await db.exec("UPDATE cron.job SET command=command || ' ';");
    await rejectedTransaction(db, setup, /SUPALIVE_JOB_CONFLICT/);
    await rejectedTransaction(db, readSql('disable'), /SUPALIVE_JOB_CONFLICT/);
  } finally { await db.close(); }
});

test('existing cron row is locked before validating and changing it', async () => {
  const db = await database();
  try {
    await db.exec(setup);
    // Inspect the actual PostgreSQL lock held when alter_job is entered.
    await db.exec(`CREATE OR REPLACE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL,
      command text DEFAULT NULL, database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL)
    RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE relation='cron.job'::regclass
        AND mode='RowShareLock' AND granted AND pid=pg_backend_pid()) THEN
        RAISE EXCEPTION 'Cron row was not locked before alter_job';
      END IF;
      UPDATE cron.job j SET schedule=coalesce($2,j.schedule),command=coalesce($3,j.command),
        active=coalesce($6,j.active) WHERE j.jobid=$1;
    END $$;`);
    await db.exec(setup);
    await db.exec(readSql('disable'));
    assert.equal((await rows(db, readSql('status-jobs')))[0].active, false);
  } finally { await db.close(); }
});
