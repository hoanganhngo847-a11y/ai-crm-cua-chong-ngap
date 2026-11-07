BEGIN;

-- Keep the definer outside the Data API's exposed schema. Only the parsed
-- SQL wrapper below can resolve it for an authenticated caller.
CREATE FUNCTION private.read_customer_detail(p_customer_id uuid)
RETURNS TABLE (
    id uuid,
    customer_code text,
    name text,
    source text,
    stage text,
    created_at timestamptz,
    attribution_status text,
    masked_phone text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
    WITH active_memberships AS (
        SELECT m.company_id, m.role, count(*) OVER () AS active_count
        FROM public.company_members AS m
        WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE'
    )
    SELECT c.id, c.customer_code, c.name, c.source, c.stage, c.created_at,
           c.attribution_status,
           left(contact.normalized_phone, 4) || '******' || right(contact.normalized_phone, 2)
    FROM public.customers AS c
    JOIN active_memberships AS m ON m.company_id = c.company_id
    LEFT JOIN private.customer_private_contacts AS contact
        ON contact.company_id = c.company_id AND contact.customer_id = c.id
    WHERE c.id = p_customer_id
      AND m.active_count = 1
      AND m.role IN ('BOSS_ADMIN', 'SALE')
      AND public.has_company_role(m.company_id, m.role);
$$;

REVOKE ALL ON FUNCTION private.read_customer_detail(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.read_customer_detail(uuid) TO authenticated;

CREATE FUNCTION public.read_customer_detail(p_customer_id uuid)
RETURNS TABLE (
    id uuid,
    customer_code text,
    name text,
    source text,
    stage text,
    created_at timestamptz,
    attribution_status text,
    masked_phone text
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
BEGIN ATOMIC
    SELECT d.id, d.customer_code, d.name, d.source, d.stage, d.created_at,
           d.attribution_status, d.masked_phone
    FROM private.read_customer_detail(p_customer_id) AS d;
END;

REVOKE ALL ON FUNCTION public.read_customer_detail(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_customer_detail(uuid) TO authenticated;

COMMIT;
