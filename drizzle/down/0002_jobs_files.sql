-- Reverses drizzle/0002_jobs_files.sql. Never run automatically. This DELETES every job and every
-- record of a stored file. Empty the "files" bucket first (Supabase dashboard, Storage): the
-- bucket cannot be removed while it holds objects, and this script does not delete them.
-- Run it by hand, as postgres, only after showing it to the founder and getting a yes.

BEGIN;

DROP POLICY files_bucket_select ON storage.objects;
DROP POLICY files_bucket_insert ON storage.objects;
REVOKE EXECUTE ON FUNCTION app.storage_role(text) FROM authenticated;
REVOKE USAGE ON SCHEMA app FROM authenticated;
DROP FUNCTION app.storage_role(text);
DELETE FROM storage.buckets WHERE id = 'files';

DROP TABLE public.files, public.jobs;
DROP TYPE public.file_status, public.job_status;

-- The row drizzle-kit wrote for 0002_jobs_files (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794418038025;

COMMIT;
