import test from 'node:test';
import assert from 'node:assert/strict';
import { run, expectedCommands, assessStatus } from '../skills/supalive/scripts/supalive.mjs';

const ref = 'abcdefghijklmnopqrst';
const token = 'sbp_test_value_never_log_this';
const schema = {
  execution_user: 'postgres', execution_database: 'postgres', cron_available: true,
  table_exists: true, table_kind: 'r', managed_table: true, rls_enabled: true, managed_table_safe: true,
  columns: [{ name: 'id', type: 'bigint', identity: 'a' }, { name: 'ping_time', type: 'timestamp with time zone' }],
};
const job = () => ({
  jobid: 42, jobname: 'supalive-keep-alive', schedule: '0 */6 * * *', active: true,
  username: 'postgres', database: 'postgres', command: expectedCommands().managed,
});
function harness(responses = []) {
  const calls = []; const out = []; const err = [];
  return {
    calls, out, err,
    options: {
      env: { SUPABASE_ACCESS_TOKEN: token },
      writeOut: (value) => out.push(value), writeErr: (value) => err.push(value),
      fetchImpl: async (url, options) => {
        calls.push({ url, ...options });
        assert.ok(responses.length, 'Unexpected network call');
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
      },
    },
  };
}

test('default setup renders executable SQL without reading a token or making requests', async () => {
  const h = harness();
  h.options.env = new Proxy({}, { get() { throw new Error('Read secret during dry run'); } });
  assert.equal(await run([], h.options), 0);
  assert.equal(h.calls.length, 0);
  assert.match(h.out.join(''), /BEGIN;/);
  assert.match(h.out.join(''), /COMMIT;/);
});

test('write requires an explicit matching project confirmation before network', async () => {
  for (const args of [
    ['setup', '--apply', '--ref', ref],
    ['setup', '--apply', '--confirm-ref', ref],
    ['disable', '--apply', '--ref', ref, '--confirm-ref', 'zzzzzzzzzzzzzzzzzzzz'],
    ['setup', '--apply', '--ref', '../other', '--confirm-ref', '../other'],
    ['setup', '--apply', '--ref', ref, '--confirm-ref', ref, '--dry-run'],
    ['setup', '--token', token],
  ]) {
    const h = harness();
    assert.equal(await run(args, h.options), 1);
    assert.equal(h.calls.length, 0);
    assert.ok(!h.err.join('').includes(token));
  }
});

test('setup writes only to fixed Management API then verifies actual table and cron', async () => {
  const h = harness([{ body: [] }, { body: [schema] }, { body: [job()] }]);
  assert.equal(await run(['setup', '--apply', '--ref', ref, '--confirm-ref', ref], h.options), 0);
  assert.equal(h.calls.length, 3);
  for (const call of h.calls) {
    assert.equal(call.url, `https://api.supabase.com/v1/projects/${ref}/database/query`);
    assert.equal(call.redirect, 'error');
    assert.equal(call.headers.Authorization, `Bearer ${token}`);
    assert.ok(!call.body.includes(token));
  }
  assert.equal(JSON.parse(h.calls[0].body).read_only, false);
  assert.equal(JSON.parse(h.calls[1].body).read_only, true);
  assert.equal(JSON.parse(h.calls[2].body).read_only, true);
  const result = JSON.parse(h.out[0]);
  assert.equal(result.enabled, true);
  assert.equal(result.availability_guaranteed, false);
  assert.ok(![...h.out, ...h.err].join('').includes(token));
});

test('status checks schedule, command, active flag, owner, database and shape', () => {
  assert.equal(assessStatus(schema, [job()]).enabled, true);
  for (const changed of [
    { active: false }, { schedule: '* * * * *' }, { command: 'SELECT 1' },
    { username: 'someone_else' }, { database: 'another_database' },
  ]) assert.equal(assessStatus(schema, [{ ...job(), ...changed }]).enabled, false);
  assert.equal(assessStatus({ ...schema, columns: [{ name: 'id', type: 'text' }] }, [job()]).enabled, false);
  assert.equal(assessStatus(schema, [job(), job()]).enabled, false);
  assert.equal(assessStatus({ ...schema, managed_table: false }, [job()]).enabled, false);
  assert.equal(assessStatus({ ...schema, managed_table: false }, [{ ...job(), command: expectedCommands().existing }]).enabled, true);
});

test('status without --read is offline; missing pg_cron does not trigger invalid cron.job read', async () => {
  const offline = harness();
  assert.equal(await run(['status'], offline.options), 0);
  assert.equal(offline.calls.length, 0);
  const h = harness([{ body: [{ ...schema, cron_available: false }] }]);
  assert.equal(await run(['status', '--read', '--ref', ref], h.options), 1);
  assert.equal(h.calls.length, 1);
});

test('API error bodies and unrecognized job commands never reach output', async () => {
  const h = harness([{ status: 403, body: { message: token } }]);
  assert.equal(await run(['status', '--read', '--ref', ref], h.options), 1);
  assert.ok(!h.err.join('').includes(token));
  const conflict = harness([{ body: [schema] }, { body: [{ ...job(), command: token }] }]);
  assert.equal(await run(['status', '--read', '--ref', ref], conflict.options), 1);
  assert.ok(!conflict.out.join('').includes(token));
});

test('ambiguous write failure is not retried', async () => {
  const h = harness([new Error(`Network exception containing ${token}`)]);
  assert.equal(await run(['setup', '--apply', '--ref', ref, '--confirm-ref', ref], h.options), 1);
  assert.equal(h.calls.length, 1);
  assert.ok(!h.err.join('').includes(token));
});

test('disable verifies inactive own job and preserves table', async () => {
  const h = harness([{ body: [] }, { body: [schema] }, { body: [{ ...job(), active: false }] }]);
  assert.equal(await run(['disable', '--apply', '--ref', ref, '--confirm-ref', ref], h.options), 0);
  assert.equal(JSON.parse(h.out[0]).disabled, true);
});

test('status accepts only CRLF/LF differences; other command edits remain conflicts', () => {
  const windowsJob = { ...job(), command: job().command.replace(/\n/g, '\r\n') };
  assert.equal(assessStatus(schema, [windowsJob]).enabled, true);
  assert.equal(assessStatus(schema, [{ ...windowsJob, command: `${windowsJob.command} ` }]).enabled, false);
});
