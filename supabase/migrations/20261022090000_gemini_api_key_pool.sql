-- Global Gemini API key pool. API key material is encrypted by the application
-- with AES-256-GCM before it reaches this table. Only ciphertext is persisted.

CREATE TABLE public.gemini_api_key_pool (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  fingerprint text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  cooldown_until timestamptz,
  last_used_at timestamptz,
  last_success_at timestamptz,
  last_error_code text,
  consecutive_rate_limits integer NOT NULL DEFAULT 0 CHECK (consecutive_rate_limits BETWEEN 0 AND 1000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(label) BETWEEN 1 AND 120),
  CHECK (char_length(fingerprint) = 64)
);

CREATE INDEX idx_gemini_api_key_pool_available
  ON public.gemini_api_key_pool (enabled, cooldown_until, last_used_at)
  WHERE enabled = true;

ALTER TABLE public.gemini_api_key_pool ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gemini_api_key_pool FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.gemini_api_key_pool TO service_role;

CREATE OR REPLACE FUNCTION public.gemini_pool_claim_key(
  p_exclude uuid[] DEFAULT '{}'::uuid[]
)
RETURNS TABLE(key_id uuid, ciphertext text, iv text, auth_tag text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT k.id
  INTO v_id
  FROM public.gemini_api_key_pool k
  WHERE k.enabled = true
    AND (k.cooldown_until IS NULL OR k.cooldown_until <= now())
    AND NOT (k.id = ANY(COALESCE(p_exclude, '{}'::uuid[])))
  ORDER BY k.last_used_at ASC NULLS FIRST, k.created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.gemini_api_key_pool
  SET last_used_at = now(), updated_at = now()
  WHERE id = v_id;

  RETURN QUERY
  SELECT k.id, k.ciphertext, k.iv, k.auth_tag
  FROM public.gemini_api_key_pool k
  WHERE k.id = v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.gemini_pool_mark_result(
  p_key_id uuid,
  p_result text,
  p_error_code text DEFAULT NULL,
  p_cooldown_seconds integer DEFAULT 75
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_result NOT IN ('SUCCESS', 'RATE_LIMITED', 'AUTH_ERROR', 'ERROR') THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  UPDATE public.gemini_api_key_pool
  SET
    last_success_at = CASE WHEN p_result = 'SUCCESS' THEN now() ELSE last_success_at END,
    last_error_code = CASE WHEN p_result = 'SUCCESS' THEN NULL ELSE left(COALESCE(p_error_code, p_result), 100) END,
    consecutive_rate_limits = CASE
      WHEN p_result = 'SUCCESS' THEN 0
      WHEN p_result = 'RATE_LIMITED' THEN consecutive_rate_limits + 1
      ELSE consecutive_rate_limits
    END,
    cooldown_until = CASE
      WHEN p_result = 'SUCCESS' THEN NULL
      WHEN p_result = 'RATE_LIMITED' THEN now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_cooldown_seconds, 75), 60), 600))
      WHEN p_result = 'AUTH_ERROR' THEN now() + interval '1 hour'
      ELSE cooldown_until
    END,
    enabled = CASE WHEN p_result = 'AUTH_ERROR' THEN false ELSE enabled END,
    updated_at = now()
  WHERE id = p_key_id;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.gemini_pool_claim_key(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gemini_pool_mark_result(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gemini_pool_claim_key(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.gemini_pool_mark_result(uuid, text, text, integer) TO service_role;
