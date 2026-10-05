-- ==============================================================================
-- Migration: Staging Storage Bucket Provisioning
--
-- Idempotently provisions required runtime storage buckets:
-- 1. survey-photos: private, 10MiB limit, image/jpeg, image/png, image/webp
-- 2. installation-docs: private, 10MiB limit, image/jpeg, image/png, image/webp, application/pdf
-- 3. contract-documents & contracts: private, 10MiB limit, application/pdf
--
-- Hardened security model:
-- Direct client access (anon and authenticated) is strictly prohibited via restrictive RLS.
-- Server/service-role authority uploads and generates signed URLs for client access.
-- ==============================================================================

-- 1. survey-photos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'survey-photos',
    'survey-photos',
    false,
    10485760,
    ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET 
    public = false, 
    file_size_limit = 10485760,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

DROP POLICY IF EXISTS survey_photos_no_client_insert ON storage.objects;
CREATE POLICY survey_photos_no_client_insert ON storage.objects 
    AS RESTRICTIVE FOR INSERT TO anon, authenticated 
    WITH CHECK (bucket_id <> 'survey-photos');

DROP POLICY IF EXISTS survey_photos_no_client_update ON storage.objects;
CREATE POLICY survey_photos_no_client_update ON storage.objects 
    AS RESTRICTIVE FOR UPDATE TO anon, authenticated 
    USING (bucket_id <> 'survey-photos') 
    WITH CHECK (bucket_id <> 'survey-photos');

DROP POLICY IF EXISTS survey_photos_no_client_delete ON storage.objects;
CREATE POLICY survey_photos_no_client_delete ON storage.objects 
    AS RESTRICTIVE FOR DELETE TO anon, authenticated 
    USING (bucket_id <> 'survey-photos');

DROP POLICY IF EXISTS survey_photos_no_client_select ON storage.objects;
CREATE POLICY survey_photos_no_client_select ON storage.objects 
    AS RESTRICTIVE FOR SELECT TO anon, authenticated 
    USING (bucket_id <> 'survey-photos');

-- 2. installation-docs
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'installation-docs',
    'installation-docs',
    false,
    10485760,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE SET 
    public = false, 
    file_size_limit = 10485760,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

DROP POLICY IF EXISTS operations_evidence_no_client_insert ON storage.objects;
CREATE POLICY operations_evidence_no_client_insert ON storage.objects 
    AS RESTRICTIVE FOR INSERT TO anon, authenticated 
    WITH CHECK (bucket_id <> 'installation-docs');

DROP POLICY IF EXISTS operations_evidence_no_client_update ON storage.objects;
CREATE POLICY operations_evidence_no_client_update ON storage.objects 
    AS RESTRICTIVE FOR UPDATE TO anon, authenticated 
    USING (bucket_id <> 'installation-docs') 
    WITH CHECK (bucket_id <> 'installation-docs');

DROP POLICY IF EXISTS operations_evidence_no_client_delete ON storage.objects;
CREATE POLICY operations_evidence_no_client_delete ON storage.objects 
    AS RESTRICTIVE FOR DELETE TO anon, authenticated 
    USING (bucket_id <> 'installation-docs');

DROP POLICY IF EXISTS operations_evidence_no_client_select ON storage.objects;
CREATE POLICY operations_evidence_no_client_select ON storage.objects 
    AS RESTRICTIVE FOR SELECT TO anon, authenticated 
    USING (bucket_id <> 'installation-docs');

-- 3. contract-documents
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'contract-documents',
    'contract-documents',
    false,
    10485760,
    ARRAY['application/pdf']
)
ON CONFLICT (id) DO UPDATE SET 
    public = false, 
    file_size_limit = 10485760,
    allowed_mime_types = ARRAY['application/pdf'];

DROP POLICY IF EXISTS contract_documents_no_client_insert ON storage.objects;
CREATE POLICY contract_documents_no_client_insert ON storage.objects 
    AS RESTRICTIVE FOR INSERT TO anon, authenticated 
    WITH CHECK (bucket_id <> 'contract-documents');

DROP POLICY IF EXISTS contract_documents_no_client_update ON storage.objects;
CREATE POLICY contract_documents_no_client_update ON storage.objects 
    AS RESTRICTIVE FOR UPDATE TO anon, authenticated 
    USING (bucket_id <> 'contract-documents') 
    WITH CHECK (bucket_id <> 'contract-documents');

DROP POLICY IF EXISTS contract_documents_no_client_delete ON storage.objects;
CREATE POLICY contract_documents_no_client_delete ON storage.objects 
    AS RESTRICTIVE FOR DELETE TO anon, authenticated 
    USING (bucket_id <> 'contract-documents');

DROP POLICY IF EXISTS contract_documents_no_client_select ON storage.objects;
CREATE POLICY contract_documents_no_client_select ON storage.objects 
    AS RESTRICTIVE FOR SELECT TO anon, authenticated 
    USING (bucket_id <> 'contract-documents');
