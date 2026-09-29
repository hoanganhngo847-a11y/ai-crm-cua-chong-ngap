-- ==============================================================================
-- Migration: TV7 Contract Storage Setup & Hardening
-- ==============================================================================

-- 1. Ensure canonical 'contracts' bucket exists and is private
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('contracts', 'contracts', false, 10485760)
ON CONFLICT (id) DO UPDATE SET 
    public = false, 
    file_size_limit = 10485760;

-- 2. Restrictive policies: Strictly prohibit direct client access (anon and authenticated)
-- Contract Storage is private, server-controlled, authorized through resource ID, signed URL only.
DROP POLICY IF EXISTS contracts_no_client_insert ON storage.objects;
CREATE POLICY contracts_no_client_insert ON storage.objects 
    AS RESTRICTIVE FOR INSERT TO anon, authenticated 
    WITH CHECK (bucket_id <> 'contracts');

DROP POLICY IF EXISTS contracts_no_client_update ON storage.objects;
CREATE POLICY contracts_no_client_update ON storage.objects 
    AS RESTRICTIVE FOR UPDATE TO anon, authenticated 
    USING (bucket_id <> 'contracts') 
    WITH CHECK (bucket_id <> 'contracts');

DROP POLICY IF EXISTS contracts_no_client_delete ON storage.objects;
CREATE POLICY contracts_no_client_delete ON storage.objects 
    AS RESTRICTIVE FOR DELETE TO anon, authenticated 
    USING (bucket_id <> 'contracts');

DROP POLICY IF EXISTS contracts_no_client_select ON storage.objects;
CREATE POLICY contracts_no_client_select ON storage.objects 
    AS RESTRICTIVE FOR SELECT TO anon, authenticated 
    USING (bucket_id <> 'contracts');
