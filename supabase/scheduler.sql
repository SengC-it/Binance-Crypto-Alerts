-- Supabase Cron -> Vercel scan endpoint.
-- Run this only after the Vercel deployment URL and CRON_SECRET are stored in Vault.
-- This file intentionally uses only bca_* job names and does not alter existing jobs.
--
-- One-time setup (replace values before running):
-- select vault.create_secret('https://<your-vercel-domain>/api/scan', 'bca_scan_url');
-- select vault.create_secret('<same value as Vercel CRON_SECRET>', 'bca_cron_secret');
-- select vault.create_secret('<Vercel automation bypass secret>', 'bca_vercel_protection_bypass');
--
-- The four batches cover the default top 100 universe with a batch size of 25.
-- If either value changes, unschedule only the bca_* jobs and recreate them.

-- Paper settlement runs two minutes before scanning so a closed position is
-- released before the max-concurrency policy evaluates new opportunities.
-- Store its URL separately:
-- select vault.create_secret('https://<your-vercel-domain>/api/paper/settle', 'bca_paper_settle_url');

select cron.schedule(
  'bca-paper-settle',
  '0,15,30,45 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'bca_paper_settle_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-vercel-protection-bypass', (select decrypted_secret from vault.decrypted_secrets where name = 'bca_vercel_protection_bypass'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'bca_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'bca-scan-batch-0',
  '2,17,32,47 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'bca_scan_url') || '?batch=0',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-vercel-protection-bypass', (select decrypted_secret from vault.decrypted_secrets where name = 'bca_vercel_protection_bypass'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'bca_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'bca-scan-batch-1',
  '2,17,32,47 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'bca_scan_url') || '?batch=1',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-vercel-protection-bypass', (select decrypted_secret from vault.decrypted_secrets where name = 'bca_vercel_protection_bypass'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'bca_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'bca-scan-batch-2',
  '2,17,32,47 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'bca_scan_url') || '?batch=2',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-vercel-protection-bypass', (select decrypted_secret from vault.decrypted_secrets where name = 'bca_vercel_protection_bypass'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'bca_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'bca-scan-batch-3',
  '2,17,32,47 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'bca_scan_url') || '?batch=3',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-vercel-protection-bypass', (select decrypted_secret from vault.decrypted_secrets where name = 'bca_vercel_protection_bypass'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'bca_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
