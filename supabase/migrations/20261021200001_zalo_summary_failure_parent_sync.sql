-- Keep parent call status consistent with summary retry/terminal outcomes.
-- Additive replacement: attempts, fencing, retry timing and ACLs are preserved.

CREATE OR REPLACE FUNCTION public.zalo_fail_call_summary(
  p_company uuid,
  p_summary_id uuid,
  p_lock_token uuid,
  p_error_code text,
  p_error_message text,
  p_terminal boolean,
  p_next_run_at timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sum public.zalo_call_ai_summaries;
  v_new_attempts integer;
  v_is_terminal boolean;
BEGIN
  SELECT * INTO v_sum
  FROM public.zalo_call_ai_summaries
  WHERE id = p_summary_id
    AND company_id = p_company
    AND lock_token = p_lock_token
    AND status = 'PROCESSING'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUMMARY_LOCK_LOST';
  END IF;

  v_new_attempts := LEAST(v_sum.attempts + 1, 10);
  v_is_terminal := COALESCE(p_terminal, false) OR (v_new_attempts >= v_sum.max_attempts);

  UPDATE public.zalo_call_ai_summaries
  SET status = CASE WHEN v_is_terminal THEN 'FAILED' ELSE 'PENDING' END,
      attempts = v_new_attempts,
      next_run_at = CASE WHEN v_is_terminal THEN now() ELSE COALESCE(p_next_run_at, now() + interval '30 seconds') END,
      error_code = p_error_code,
      error_message = p_error_message,
      lock_token = NULL,
      locked_by = NULL,
      locked_at = NULL,
      lease_expires_at = NULL,
      updated_at = now()
  WHERE id = v_sum.id;

  -- Mirror the persisted child state for both terminal and retryable failures.
  UPDATE public.zalo_personal_calls
  SET summary_status = CASE WHEN v_is_terminal THEN 'FAILED' ELSE 'PENDING' END
  WHERE id = v_sum.call_id AND company_id = p_company;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_fail_call_summary(uuid, uuid, uuid, text, text, boolean, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_fail_call_summary(uuid, uuid, uuid, text, text, boolean, timestamptz) TO service_role;
