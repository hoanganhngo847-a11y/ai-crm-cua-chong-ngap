-- Safe recurring invocation of /api/cron/ai-brain-live-zalo using pg_cron, pg_net, and Supabase Vault.
--
-- NOTE: In Supabase production environments, pg_cron and pg_net extensions and scheduler
-- registration are provisioned via docs/sql/ai-brain-live-zalo-scheduler-setup.sql.
-- Local PGlite and CI ephemeral test databases do not support pg_cron / pg_net background workers.
-- This migration ensures clean schema_migrations version tracking across environments without
-- interfering with test-runner ephemeral databases.
SELECT 1;
