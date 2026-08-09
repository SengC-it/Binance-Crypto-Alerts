-- Supabase Cron -> Vercel scan endpoint.
-- Run this only after the Vercel deployment URL and CRON_SECRET are stored in Vault.
-- This file intentionally uses only cs_* job names and does not alter existing jobs.
--
-- One-time setup (replace values before running):
-- select vault.create_secret('https://<your-vercel-domain>/api/scan', 'cs_scan_url');
-- select vault.create_secret('<same value as Vercel CRON_SECRET>', 'cs_cron_secret');
--
-- The four batches cover the default top 100 universe with a batch size of 25.
-- If either value changes, unschedule only the cs_* jobs and recreate them.

select cron.schedule(
  'cs-scan-batch-0',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'cs_scan_url') || '?batch=0',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cs_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'cs-scan-batch-1',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'cs_scan_url') || '?batch=1',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cs_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'cs-scan-batch-2',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'cs_scan_url') || '?batch=2',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cs_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'cs-scan-batch-3',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'cs_scan_url') || '?batch=3',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cs_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
