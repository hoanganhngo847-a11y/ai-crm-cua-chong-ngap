-- Additive hardening after 005. Foundation 001-004 and existing records stay untouched.
-- Requires Foundation review: direct survey writes are removed; SELECT policies are preserved.
BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.surveys FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS surveys_insert_boss_admin ON public.surveys;
DROP POLICY IF EXISTS surveys_insert_assigned_technician ON public.surveys;
DROP POLICY IF EXISTS surveys_update_boss_admin ON public.surveys;
DROP POLICY IF EXISTS surveys_update_assigned_technician ON public.surveys;

-- Durable guard for operations spanning DB and Storage with bounded lease / stale lock reclamation.
CREATE TABLE IF NOT EXISTS public.survey_photo_operations (
  appointment_id uuid PRIMARY KEY REFERENCES public.appointments(id),
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES public.user_profiles(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);
ALTER TABLE public.survey_photo_operations ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes');
ALTER TABLE public.survey_photo_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.survey_photo_operations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.survey_photo_operations TO service_role;

DROP FUNCTION IF EXISTS public.begin_survey_photo_operation(uuid, uuid);
DROP FUNCTION IF EXISTS public.begin_survey_photo_operation(uuid, uuid, integer);
CREATE OR REPLACE FUNCTION public.begin_survey_photo_operation(
  p_appointment_id uuid,
  p_actor_id uuid
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  a public.appointments;
  v_op public.survey_photo_operations;
  v_token uuid;
BEGIN
  SELECT * INTO a FROM public.appointments WHERE id = p_appointment_id FOR UPDATE;
  IF NOT FOUND OR a.type <> 'SURVEY' OR a.status NOT IN ('ASSIGNED','ACCEPTED','IN_PROGRESS') THEN
    RAISE EXCEPTION 'INVALID_SURVEY_PHOTO_RESOURCE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_profiles p JOIN public.company_members m ON m.user_id = p.id
    WHERE p.id = p_actor_id AND p.status = 'ACTIVE' AND m.status = 'ACTIVE'
      AND m.company_id = a.company_id
      AND (m.role = 'BOSS_ADMIN' OR (m.role = 'TECHNICIAN' AND a.assignee_id = p_actor_id))
  ) THEN RAISE EXCEPTION 'SURVEY_PHOTO_FORBIDDEN'; END IF;

  SELECT * INTO v_op FROM public.survey_photo_operations
  WHERE appointment_id = a.id FOR UPDATE;

  IF FOUND THEN
    IF v_op.expires_at > pg_catalog.now() THEN
      RAISE EXCEPTION 'SURVEY_PHOTO_OPERATION_IN_PROGRESS';
    END IF;
    -- Expired lock: atomically reclaim it with new token and fixed 15-minute lease
    v_token := pg_catalog.gen_random_uuid();
    UPDATE public.survey_photo_operations
    SET token = v_token,
        actor_id = p_actor_id,
        started_at = pg_catalog.now(),
        expires_at = pg_catalog.now() + interval '15 minutes'
    WHERE appointment_id = a.id;
    RETURN v_token;
  END IF;

  v_token := pg_catalog.gen_random_uuid();
  INSERT INTO public.survey_photo_operations(appointment_id, token, actor_id, started_at, expires_at)
  VALUES (a.id, v_token, p_actor_id, pg_catalog.now(), pg_catalog.now() + interval '15 minutes');
  RETURN v_token;
END $$;

CREATE OR REPLACE FUNCTION public.end_survey_photo_operation(p_appointment_id uuid, p_token uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_deleted_id uuid;
BEGIN
  PERFORM 1 FROM public.appointments WHERE id = p_appointment_id FOR UPDATE;
  DELETE FROM public.survey_photo_operations
  WHERE appointment_id = p_appointment_id AND token = p_token
  RETURNING appointment_id INTO v_deleted_id;

  IF v_deleted_id IS NULL THEN
    RAISE EXCEPTION 'SURVEY_PHOTO_GUARD_MISMATCH';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.begin_survey_photo_operation(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.end_survey_photo_operation(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_survey_photo_operation(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.end_survey_photo_operation(uuid, uuid) TO service_role;

-- Prevent generic/direct appointment writes from completing a Survey or modifying terminal history.
CREATE OR REPLACE FUNCTION public.guard_survey_appointment_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.type = 'SURVEY' THEN
    IF OLD.status IN ('COMPLETED','CANCELLED','REJECTED') THEN
      IF NEW.status IS DISTINCT FROM OLD.status OR
         NEW.address IS DISTINCT FROM OLD.address OR
         NEW.assignee_id IS DISTINCT FROM OLD.assignee_id OR
         NEW.type IS DISTINCT FROM OLD.type THEN
        RAISE EXCEPTION 'SURVEY_APPOINTMENT_TERMINAL';
      END IF;
    END IF;
    -- A live (unexpired) photo operation blocks modifications
    IF EXISTS (
      SELECT 1 FROM public.survey_photo_operations
      WHERE appointment_id = OLD.id AND expires_at > pg_catalog.now()
    ) THEN
      RAISE EXCEPTION 'SURVEY_PHOTO_OPERATION_IN_PROGRESS';
    END IF;
    IF OLD.status <> 'COMPLETED' AND NEW.status = 'COMPLETED' THEN
      IF pg_catalog.current_setting('app.survey_completion', true) IS DISTINCT FROM NEW.id::text
         OR NOT EXISTS (SELECT 1 FROM public.surveys s WHERE s.appointment_id = NEW.id
           AND s.company_id = NEW.company_id AND s.customer_id = NEW.customer_id
           AND s.completed_by = NEW.assignee_id) THEN
        RAISE EXCEPTION 'SURVEY_COMPLETION_REQUIRES_ATOMIC_RPC';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_survey_appointment_write ON public.appointments;
CREATE TRIGGER guard_survey_appointment_write BEFORE INSERT OR UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.guard_survey_appointment_write();
REVOKE ALL ON FUNCTION public.guard_survey_appointment_write() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.complete_survey_atomic(
  p_appointment_id uuid, p_completed_by uuid, p_survey_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  a public.appointments;
  s public.surveys;
  v_now timestamptz := pg_catalog.now();
  m jsonb;
  c jsonb;
  v_photos jsonb := '[]'::jsonb;
  v_slot text;
  v_path text;
  v_key text;
  v_min numeric;
  v_max numeric;
BEGIN
  SELECT * INTO a FROM public.appointments WHERE id = p_appointment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPOINTMENT_NOT_FOUND'; END IF;
  IF a.type <> 'SURVEY' THEN RAISE EXCEPTION 'APPOINTMENT_TYPE_NOT_SURVEY'; END IF;
  IF p_completed_by IS NULL OR a.assignee_id IS DISTINCT FROM p_completed_by THEN
    RAISE EXCEPTION 'INVALID_COMPLETED_BY';
  END IF;
  -- Lock actor records too: deactivation must serialize with this completion transaction.
  PERFORM 1 FROM public.user_profiles p JOIN public.company_members cm ON cm.user_id = p.id
    WHERE p.id = p_completed_by AND p.status = 'ACTIVE'
      AND cm.company_id = a.company_id AND cm.status = 'ACTIVE' AND cm.role = 'TECHNICIAN'
    FOR SHARE OF p, cm;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_COMPLETED_BY'; END IF;

  SELECT * INTO s FROM public.surveys WHERE appointment_id = a.id;
  IF a.status = 'COMPLETED' THEN
    IF s.id IS NULL OR s.company_id <> a.company_id OR s.customer_id <> a.customer_id
       OR s.completed_by IS DISTINCT FROM p_completed_by THEN
      RAISE EXCEPTION 'SURVEY_COMPLETION_INCONSISTENT';
    END IF;
    RETURN pg_catalog.jsonb_build_object('id', s.id, 'isExisting', true);
  END IF;
  IF a.status NOT IN ('ACCEPTED','IN_PROGRESS') THEN RAISE EXCEPTION 'INVALID_PREDECESSOR_STATE'; END IF;
  IF s.id IS NOT NULL THEN RAISE EXCEPTION 'SURVEY_ALREADY_EXISTS'; END IF;
  -- A live (unexpired) photo operation blocks completion
  IF EXISTS (
    SELECT 1 FROM public.survey_photo_operations
    WHERE appointment_id = a.id AND expires_at > pg_catalog.now()
  ) THEN
    RAISE EXCEPTION 'SURVEY_PHOTO_OPERATION_IN_PROGRESS';
  END IF;

  m := p_survey_payload->'measurements';
  c := (p_survey_payload->>'site_condition')::jsonb;
  IF pg_catalog.jsonb_typeof(m) IS DISTINCT FROM 'object' OR pg_catalog.jsonb_typeof(c) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INVALID_SURVEY_TECHNICAL_INPUT';
  END IF;
  FOR v_key, v_min, v_max IN VALUES ('clear_width_mm',500,15000),
      ('barrier_height_mm',100,3000),('anticipated_flood_height_mm',100,3000) LOOP
    IF pg_catalog.jsonb_typeof(m->v_key) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'INVALID_SURVEY_MEASUREMENT'; END IF;
    IF (m->>v_key)::numeric NOT BETWEEN v_min AND v_max
       OR pg_catalog.trunc((m->>v_key)::numeric) <> (m->>v_key)::numeric THEN
      RAISE EXCEPTION 'INVALID_SURVEY_MEASUREMENT';
    END IF;
  END LOOP;
  IF m ? 'step_height_mm' AND (pg_catalog.jsonb_typeof(m->'step_height_mm') <> 'number'
      OR (m->>'step_height_mm')::numeric NOT BETWEEN 0 AND 1000) THEN
    RAISE EXCEPTION 'INVALID_SURVEY_MEASUREMENT';
  END IF;
  IF NOT coalesce(m->>'gate_type' IN ('REMOVABLE_PANEL','AUTOMATIC_HYDRAULIC','ROLL_UP_CANVAS','SWING_GATE'),false)
    OR NOT coalesce(m->>'mounting_method' IN ('INSIDE_JAMB','OUTSIDE_FACE','INSIDE_FACE'),false)
    OR NOT coalesce(c->>'wall_material' IN ('SOLID_BRICK','HOLLOW_BRICK','CONCRETE','STEEL_FRAME','ALUMINUM_GLASS','STONE_TILES'),false)
    OR NOT coalesce(c->>'floor_material' IN ('CONCRETE_SMOOTH','TILES','NATURAL_STONE','ROUGH_CEMENT','PAVING_BRICK'),false)
    OR NOT coalesce(c->>'floor_evenness' IN ('FLAT','SLIGHTLY_UNEVEN','HIGHLY_UNEVEN'),false)
    OR NOT coalesce(c->>'slope_grade' IN ('SLOPING_OUT','LEVEL','SLOPING_IN'),false) THEN
    RAISE EXCEPTION 'INVALID_SURVEY_TECHNICAL_INPUT';
  END IF;
  IF pg_catalog.length(coalesce(p_survey_payload->>'notes','')) > 1000
    OR pg_catalog.length(coalesce(c->>'notes','')) > 1000 OR pg_catalog.length(coalesce(c->>'specialRequirements','')) > 1000 THEN
    RAISE EXCEPTION 'INVALID_SURVEY_NOTES';
  END IF;

  -- Server-owned paths only. Ignore payload.photos, Company, Customer, completed_by and completed_at.
  FOREACH v_slot IN ARRAY ARRAY['OVERVIEW','BOTTOM_LEFT','BOTTOM_RIGHT','OBSTACLE','SLOPE_DETAIL','ADDITIONAL'] LOOP
    v_path := a.company_id::text || '/' || a.customer_id::text || '/' || a.id::text || '/' || v_slot || '.jpg';
    IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'survey-photos' AND name = v_path) THEN
      v_photos := v_photos || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('slot',v_slot,'objectPath',v_path,
        'uploadedAt',v_now,'slotLabel',v_slot,'isMandatory',v_slot IN ('OVERVIEW','BOTTOM_LEFT','BOTTOM_RIGHT')));
    ELSIF v_slot IN ('OVERVIEW','BOTTOM_LEFT','BOTTOM_RIGHT') THEN
      RAISE EXCEPTION 'MISSING_MANDATORY_SURVEY_PHOTO';
    END IF;
  END LOOP;

  INSERT INTO public.surveys(company_id,customer_id,appointment_id,completed_by,measurements,photos,
    site_condition,notes,completed_at,created_at,updated_at)
  VALUES (a.company_id,a.customer_id,a.id,p_completed_by,m,v_photos,c::text,p_survey_payload->>'notes',v_now,v_now,v_now)
  RETURNING * INTO s;
  PERFORM pg_catalog.set_config('app.survey_completion', a.id::text, true);
  UPDATE public.appointments SET status = 'COMPLETED', updated_at = v_now
    WHERE id = a.id AND status IN ('ACCEPTED','IN_PROGRESS');
  IF NOT FOUND THEN RAISE EXCEPTION 'SURVEY_APPOINTMENT_UPDATE_FAILED'; END IF;
  PERFORM pg_catalog.set_config('app.survey_completion', '', true);
  RETURN pg_catalog.jsonb_build_object('id',s.id,'isExisting',false);
END $$;
REVOKE ALL ON FUNCTION public.complete_survey_atomic(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_survey_atomic(uuid, uuid, jsonb) TO service_role;
COMMIT;
