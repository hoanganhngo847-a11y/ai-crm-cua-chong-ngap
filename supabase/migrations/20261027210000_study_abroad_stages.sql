-- Migration: 20261027210000_study_abroad_stages.sql
-- Update public.customers.stage CHECK constraint for Study Abroad Consulting (Tư vấn du học)

ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_stage_check;

ALTER TABLE public.customers ADD CONSTRAINT customers_stage_check CHECK (stage IN (
  -- 12 Canonical Stages for Study Abroad Consulting
  'LEAD_NEW',
  'CONTACT_CYCLE_1',
  'CONTACT_CYCLE_2',
  'CONTACT_CYCLE_3',
  'UNREACHABLE',
  'ZALO_FRIENDED',
  'IN_CARE',
  'POTENTIAL_CLOSING',
  'NOT_POTENTIAL',
  'NO_DEMAND',
  'CONTRACT_SIGNED',
  'CARE_NURTURING',

  -- Backward compatibility with legacy flood barrier stages
  'SURVEY_REQUESTED',
  'SURVEY_SCHEDULED',
  'SURVEY_COMPLETED',
  'PRICE_CALCULATED',
  'NEED_INFO',
  'PRICE_OFFERED',
  'NEGOTIATING',
  'ORDER_CREATED',
  'DEPOSIT_CONFIRMED',
  'IN_PRODUCTION',
  'READY_FOR_INSTALL',
  'INSTALLING',
  'HANDOVER_COMPLETED',
  'WARRANTY_ACTIVE',
  'LOST'
));
