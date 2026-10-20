-- Run only after status.sql confirms cron_available=true. Never execute commands.
SELECT jobid, jobname, schedule, command, username, database, active
FROM cron.job WHERE jobname = 'supalive-keep-alive' ORDER BY jobid;
