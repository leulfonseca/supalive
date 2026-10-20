#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const JOB_NAME = 'supalive-keep-alive';
const SCHEDULE = '0 */6 * * *';
const canonicalCommand = (value) => typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value;
const sql = (name) => readFileSync(new URL(`../sql/${name}.sql`, import.meta.url), 'utf8');
const usage = `Supabase heartbeat, Node.js 20+. No dependencies.
Usage: node supalive.mjs [setup|status|disable] [options]

Default: print SQL, no network, no token required.
  --ref <project-ref>          Explicit 20-character project ref
  --dry-run                    Print SQL (default)
  --apply --confirm-ref <ref>   Apply setup/disable; both refs must match
  --read                       Run status with read_only=true
  --help                       Show this help

Remote calls read SUPABASE_ACCESS_TOKEN from the process environment only.
Never pass tokens in arguments. Installing a job does not guarantee uptime.
`;

export function expectedCommands() {
  const setup = sql('setup');
  const extract = (tag) => {
    const parts = setup.split(`$${tag}_command$`);
    if (parts.length !== 3) throw new Error('Invalid packaged SQL resources.');
    return canonicalCommand(parts[1]);
  };
  return { managed: extract('managed'), existing: extract('existing') };
}

function parseArgs(args) {
  const options = { command: 'setup', apply: false, read: false, dryRun: false };
  let index = 0;
  if (args[0] && !args[0].startsWith('--')) options.command = args[index++];
  if (!['setup', 'status', 'disable'].includes(options.command)) throw new Error('Unknown command. Use --help.');
  const seen = new Set();
  for (; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error('Duplicate option. Use --help.');
    seen.add(flag);
    if (flag === '--help') options.help = true;
    else if (flag === '--apply') options.apply = true;
    else if (flag === '--read') options.read = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--ref' || flag === '--confirm-ref') {
      const value = args[++index];
      if (!value || !/^[a-z0-9]{20}$/.test(value)) throw new Error('Project refs must contain exactly 20 lowercase letters/digits.');
      options[flag === '--ref' ? 'ref' : 'confirmRef'] = value;
    } else throw new Error('Unknown option. Tokens are accepted only through SUPABASE_ACCESS_TOKEN.');
  }
  if (options.help) return options;
  if ((options.apply && options.read) || (options.dryRun && (options.apply || options.read))) throw new Error('Choose one mode: dry-run, --apply, or --read.');
  if (options.read && options.command !== 'status') throw new Error('--read is only available for status.');
  if (options.apply && options.command === 'status') throw new Error('Use status --read for read-only verification.');
  if ((options.apply || options.read) && !options.ref) throw new Error('An explicit --ref is required for remote access.');
  if (options.apply && options.ref !== options.confirmRef) throw new Error('--apply requires --confirm-ref equal to the explicit --ref.');
  if (!options.apply && options.confirmRef) throw new Error('--confirm-ref is only used with --apply.');
  return options;
}

export function assessStatus(schema, jobs) {
  const columns = Array.isArray(schema?.columns) ? schema.columns : [];
  const compatible = columns.some((c) => c.name === 'id' && c.type === 'bigint')
    && columns.some((c) => c.name === 'ping_time' && c.type === 'timestamp with time zone');
  const tableValid = schema?.table_exists === true && ['r', 'p'].includes(schema.table_kind)
    && compatible && (!schema.managed_table || (columns.length === 2 && schema.rls_enabled === true && schema.managed_table_safe === true));
  const recognized = expectedCommands();
  const summaries = jobs.map((job) => ({
    job_id: Number.isSafeInteger(job.jobid) ? job.jobid : null,
    command_matches: canonicalCommand(job.command) === (schema.managed_table ? recognized.managed : recognized.existing),
    recognized_command: [recognized.managed, recognized.existing].includes(canonicalCommand(job.command)),
    owner_matches: job.username === schema.execution_user,
    database_matches: job.database === schema.execution_database,
    schedule_matches: job.schedule === SCHEDULE,
    active: job.active === true,
  }));
  const ownJob = summaries.length === 1 && summaries[0].recognized_command
    && summaries[0].owner_matches && summaries[0].database_matches;
  const configurationValid = tableValid && schema.cron_available === true && ownJob
    && summaries[0].command_matches && summaries[0].schedule_matches;
  return {
    table_exists: schema.table_exists === true, table_shape_matches: tableValid,
    table_managed_by_supalive: schema.managed_table === true,
    managed_table_safe: schema.managed_table_safe === true,
    cron_available: schema.cron_available === true, job_name: JOB_NAME,
    expected_schedule: SCHEDULE, jobs: summaries, configuration_valid: configurationValid,
    enabled: configurationValid && summaries[0].active,
    disabled: ownJob && !summaries[0].active,
    verification: 'configuration-only', availability_guaranteed: false,
  };
}

async function query(projectRef, token, querySql, readOnly, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: querySql, read_only: readOnly }),
    });
  } catch {
    // Never include exception text: network implementations can echo headers.
    throw new Error('Management API network failure. Write outcome may be unknown; inspect status --read before repeating.');
  }
  if (!response.ok) {
    // A remote SQL error may contain credentials from unrelated database objects.
    const body = await response.text().catch(() => '');
    const guard = ['SUPALIVE_TABLE_CONFLICT', 'SUPALIVE_JOB_CONFLICT', 'SUPALIVE_NOT_INSTALLED']
      .find((code) => body.includes(code));
    throw new Error(`Management API HTTP ${response.status}${guard ? ` (${guard})` : ''}. Check project access, permissions and project state. No automatic retry.`);
  }
  try { return await response.json(); }
  catch { throw new Error('Management API returned an invalid response. Inspect status --read before repeating a write.'); }
}

async function readStatus(options, token, fetchImpl) {
  const rows = await query(options.ref, token, sql('status'), true, fetchImpl);
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.execution_user !== 'string'
    || typeof rows[0]?.execution_database !== 'string' || typeof rows[0]?.cron_available !== 'boolean') {
    throw new Error('Management API returned an unexpected catalog result. Configuration was not verified.');
  }
  const jobs = rows[0].cron_available
    ? await query(options.ref, token, sql('status-jobs'), true, fetchImpl) : [];
  if (!Array.isArray(jobs)) throw new Error('Management API returned an unexpected cron result. Configuration was not verified.');
  return assessStatus(rows[0], jobs);
}

export async function run(args, {
  env = process.env, fetchImpl = globalThis.fetch,
  writeOut = (value) => process.stdout.write(value), writeErr = (value) => process.stderr.write(value),
} = {}) {
  try {
    const options = parseArgs(args);
    if (options.help) { writeOut(usage); return 0; }
    if (!options.apply && !options.read) {
      writeOut(options.command === 'status'
        ? `${sql('status')}\n-- If cron_available=true, also run:\n${sql('status-jobs')}` : sql(options.command));
      return 0;
    }
    const token = env.SUPABASE_ACCESS_TOKEN;
    if (typeof token !== 'string' || !token.trim() || /\s/.test(token)) throw new Error('Set SUPABASE_ACCESS_TOKEN in this process; never put it in arguments or files.');
    if (options.apply) await query(options.ref, token, sql(options.command), false, fetchImpl);
    const result = await readStatus(options, token, fetchImpl);
    writeOut(`${JSON.stringify({ project_ref: options.ref, ...result }, null, 2)}\n`);
    return (options.command === 'disable' ? result.disabled : result.enabled) ? 0 : 1;
  } catch (error) {
    writeErr(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await run(process.argv.slice(2));
}
