import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { BrainProvider } from './contracts';
import { ZaloInboxService } from '../omnichannel/zalo/inbox-service';
import type { BrainContextDataSource } from './context-contracts';
import {
  processDueLiveDeliveries,
  LIVE_DELIVERY_WORKLOAD_ACTOR_ID,
  ZaloDeliveryTransport,
  type LiveDeliveryClaim,
  type LiveDeliveryWorkerResult,
} from './live-delivery';

export type LiveZaloClaim = LiveDeliveryClaim & { channel: 'ZALO' };

export const LIVE_ZALO_WORKLOAD_ACTOR_ID = LIVE_DELIVERY_WORKLOAD_ACTOR_ID;

export type LiveZaloWorkerResult = LiveDeliveryWorkerResult;

export interface LiveZaloWorkerOptions {
  supabase?: SupabaseClient;
  provider?: BrainProvider;
  inboxService?: ZaloInboxService;
  dataSource?: BrainContextDataSource;
}

export async function processDueAiBrainLiveZaloDeliveries(
  limit = 5,
  options: LiveZaloWorkerOptions = {},
): Promise<LiveZaloWorkerResult> {
  const transports = options.inboxService
    ? { ZALO: new ZaloDeliveryTransport({ inboxService: options.inboxService, supabase: options.supabase }) }
    : undefined;

  return processDueLiveDeliveries(limit, {
    supabase: options.supabase,
    provider: options.provider,
    dataSource: options.dataSource,
    transports,
    channel: 'ZALO',
  });
}
