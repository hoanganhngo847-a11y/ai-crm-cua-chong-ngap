-- Migration: Setup secure-documents bucket
INSERT INTO storage.buckets (id, name, public) 
VALUES ('secure-documents', 'secure-documents', false) 
ON CONFLICT (id) DO NOTHING;

-- Bật RLS
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Policies for secure-documents
CREATE POLICY "Service Role full access to secure-documents" ON storage.objects
FOR ALL TO service_role
USING (bucket_id = 'secure-documents');

CREATE POLICY "Authenticated users can upload to secure-documents" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'secure-documents');

CREATE POLICY "Users can download their own documents" ON storage.objects
FOR SELECT TO authenticated
USING (bucket_id = 'secure-documents');
