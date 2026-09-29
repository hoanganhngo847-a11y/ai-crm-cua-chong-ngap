import { createAdminClient } from '../../../lib/supabase/admin';
import { ZaloCareSchedulerService } from './scheduler-service';
import { ZaloInboxService } from '../../omnichannel/zalo/inbox-service';

export interface ZaloCareCronSummary {
  ok: boolean;
  companies: number;
  companyErrors: number;
  care: {
    processed: number;
    advanced: number;
    failed: number;
    uncertain: number;
    skipped: number;
  };
  outbound: {
    reconciled: number;
    failed: number;
    uncertain: number;
  };
}

export async function runZaloCareCron(): Promise<ZaloCareCronSummary> {
  const supabase = createAdminClient();
  const { data: configs, error } = await supabase.from('zalo_oa_configs').select('company_id').eq('status', 'ACTIVE');
  if (error) {
    throw new Error(`Không đọc được danh sách OA: ${error.message}`);
  }

  const companyIds = Array.from(new Set(((configs || []) as { company_id: string }[]).map((c) => c.company_id)));
  const scheduler = new ZaloCareSchedulerService({ supabase });
  const inbox = new ZaloInboxService({ supabase });

  const care = { processed: 0, advanced: 0, failed: 0, uncertain: 0, skipped: 0 };
  const outbound = { reconciled: 0, failed: 0, uncertain: 0 };
  let companyErrors = 0;

  for (const companyId of companyIds) {
    try {
      const schedRes = await scheduler.processDueSchedules({ companyId });
      care.processed += schedRes.processed;
      care.advanced += schedRes.advanced;
      care.failed += schedRes.failed;
      care.uncertain += schedRes.uncertain;
      care.skipped += schedRes.skipped;

      const outRes = await inbox.reconcilePendingDeliveries({ companyId });
      outbound.reconciled += outRes.reconciled;
      outbound.failed += outRes.failed;
      outbound.uncertain += outRes.uncertain;
    } catch (err) {
      companyErrors++;
      console.error(`[cron/zalo-care] company=${companyId}:`, (err as Error).message);
    }
  }

  return { ok: true, companies: companyIds.length, companyErrors, care, outbound };
}
