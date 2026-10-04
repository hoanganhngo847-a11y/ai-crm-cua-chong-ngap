import { execSync } from 'child_process';

/**
 * Returns the active PostgreSQL Supabase docker container name.
 */
function getPostgresContainer(): string {
  try {
    const out = execSync('docker ps --filter "name=supabase_db" --format "{{.Names}}"', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (out) return out.split('\n')[0].trim();
  } catch {}
  return 'supabase_db_ai-crm-cua-chong-ngap';
}

/**
 * Executes raw SQL against the local Supabase PostgreSQL container via psql.
 */
export function executeRawSql(sql: string): string {
  const container = getPostgresContainer();
  return execSync(`docker exec -i ${container} psql -v ON_ERROR_STOP=1 -U postgres -d postgres`, {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export interface CleanupCompanyOptions {
  deleteCompany?: boolean;
  deleteMembers?: boolean;
}

/**
 * Clean up all dependent records for one or more company IDs in exact foreign-key order.
 * Handles append-only and immutability triggers safely.
 */
export function cleanupCompanyFixtures(
  companyIds: string | string[],
  options?: CleanupCompanyOptions
): void {
  const list = Array.isArray(companyIds) ? companyIds : [companyIds];
  const validIds = list.filter((id) => typeof id === 'string' && id.trim().length > 0);
  if (validIds.length === 0) return;

  const idList = validIds.map((id) => `'${id}'`).join(', ');

  const sql = `
DO $$
BEGIN
  -- 0. Disable append-only / immutable snapshot triggers
  ALTER TABLE public.price_calculations DISABLE TRIGGER trg_price_calculations_immutability;
  ALTER TABLE public.audit_logs DISABLE TRIGGER trg_append_only_audit_logs;
  ALTER TABLE private.interaction_raw_contents DISABLE TRIGGER trg_append_only_raw_contents;
  ALTER TABLE public.customer_stage_histories DISABLE TRIGGER trg_append_only_stage_histories;

  BEGIN
    -- 1. Operations, Warranty, Installation & Commercial Order descendants
    DELETE FROM public.survey_photo_operations WHERE appointment_id IN (
      SELECT id FROM public.appointments WHERE company_id IN (${idList})
    );
    DELETE FROM public.operations_outbox WHERE company_id IN (${idList});
    DELETE FROM public.warranty_tickets WHERE company_id IN (${idList});
    DELETE FROM public.installations WHERE company_id IN (${idList});
    DELETE FROM public.contracts WHERE company_id IN (${idList});
    DELETE FROM public.production_orders WHERE company_id IN (${idList});
    DELETE FROM public.finance_summaries WHERE company_id IN (${idList});
    DELETE FROM public.payment_transactions WHERE company_id IN (${idList});
    DELETE FROM public.orders WHERE company_id IN (${idList});

    -- 2. Calculations, Surveys & Appointments
    DELETE FROM public.price_calculations WHERE company_id IN (${idList});
    DELETE FROM public.surveys WHERE company_id IN (${idList});
    DELETE FROM public.appointments WHERE company_id IN (${idList});

    -- 3. Care, Channels, SLA & Messaging descendants
    DELETE FROM private.han_outbox WHERE company_id IN (${idList});
    DELETE FROM private.han_intake_events WHERE company_id IN (${idList});
    DELETE FROM private.han_receipts WHERE company_id IN (${idList});
    DELETE FROM private.han_rate_buckets WHERE company_id IN (${idList});
    DELETE FROM private.zalo_outbound_payloads WHERE company_id IN (${idList});
    DELETE FROM public.zalo_outbound_deliveries WHERE company_id IN (${idList});
    DELETE FROM public.outbound_deliveries WHERE company_id IN (${idList});
    DELETE FROM public.zalo_ingress_events WHERE company_id IN (${idList});
    DELETE FROM public.response_sla_windows WHERE company_id IN (${idList});
    DELETE FROM private.interaction_raw_contents WHERE company_id IN (${idList});
    DELETE FROM public.interactions WHERE company_id IN (${idList});
    DELETE FROM public.conversations WHERE company_id IN (${idList});

    -- 4. Care campaigns & schedules
    DELETE FROM public.care_deliveries WHERE company_id IN (${idList});
    DELETE FROM public.care_schedules WHERE company_id IN (${idList});
    DELETE FROM public.care_campaigns WHERE company_id IN (${idList});

    -- 5. Voice
    DELETE FROM public.voice_dispatch_commands WHERE company_id IN (${idList});
    DELETE FROM public.voice_media_jobs WHERE company_id IN (${idList});
    DELETE FROM public.voice_call_intakes WHERE company_id IN (${idList});
    DELETE FROM private.call_transcripts WHERE company_id IN (${idList});
    DELETE FROM public.call_attempts WHERE company_id IN (${idList});
    DELETE FROM public.calls WHERE company_id IN (${idList});
    DELETE FROM public.openai_realtime_events WHERE company_id IN (${idList});
    DELETE FROM public.voice_webhook_events WHERE company_id IN (${idList});
    DELETE FROM public.voice_provider_integrations WHERE company_id IN (${idList});

    -- 6. Customer descendants
    DELETE FROM public.identities WHERE company_id IN (${idList});
    DELETE FROM private.customer_private_contacts WHERE company_id IN (${idList});
    DELETE FROM public.customer_stage_histories WHERE company_id IN (${idList});
    DELETE FROM public.ai_analyses WHERE company_id IN (${idList});
    DELETE FROM public.sales_style_profiles WHERE company_id IN (${idList});
    DELETE FROM public.audit_logs WHERE company_id IN (${idList});
    DELETE FROM public.customers WHERE company_id IN (${idList});

    -- 7. Company-level config
    DELETE FROM public.pricing_policies WHERE company_id IN (${idList});
    DELETE FROM public.company_bank_accounts WHERE company_id IN (${idList});
    DELETE FROM public.zalo_oa_configs WHERE company_id IN (${idList});
    DELETE FROM private.zalo_oa_secrets WHERE company_id IN (${idList});

    ${options?.deleteMembers ? `DELETE FROM public.company_members WHERE company_id IN (${idList});` : ''}
    ${options?.deleteCompany ? `DELETE FROM public.companies WHERE id IN (${idList});` : ''}

  EXCEPTION WHEN OTHERS THEN
    -- Ensure triggers are re-enabled on error
    ALTER TABLE public.customer_stage_histories ENABLE TRIGGER trg_append_only_stage_histories;
    ALTER TABLE private.interaction_raw_contents ENABLE TRIGGER trg_append_only_raw_contents;
    ALTER TABLE public.audit_logs ENABLE TRIGGER trg_append_only_audit_logs;
    ALTER TABLE public.price_calculations ENABLE TRIGGER trg_price_calculations_immutability;
    RAISE;
  END;

  -- Re-enable triggers on normal completion
  ALTER TABLE public.customer_stage_histories ENABLE TRIGGER trg_append_only_stage_histories;
  ALTER TABLE private.interaction_raw_contents ENABLE TRIGGER trg_append_only_raw_contents;
  ALTER TABLE public.audit_logs ENABLE TRIGGER trg_append_only_audit_logs;
  ALTER TABLE public.price_calculations ENABLE TRIGGER trg_price_calculations_immutability;
END $$;
`;

  executeRawSql(sql);
}
