import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { ZaloInboxService } from '@/features/omnichannel/zalo/inbox-service';
import type {
  LiveDeliverySendParams,
  LiveDeliverySendOutcome,
  LiveDeliveryTransport,
} from '../contracts';

export interface ZaloDeliveryTransportOptions {
  supabase?: SupabaseClient;
  inboxService?: ZaloInboxService;
}

export class ZaloDeliveryTransport implements LiveDeliveryTransport {
  public readonly channel = 'ZALO' as const;
  private readonly inboxService: ZaloInboxService;

  constructor(options: ZaloDeliveryTransportOptions = {}) {
    this.inboxService = options.inboxService ?? new ZaloInboxService({ supabase: options.supabase });
  }

  async sendReply(params: LiveDeliverySendParams): Promise<LiveDeliverySendOutcome> {
    const sendResult = await this.inboxService.sendSystemZaloReply(
      {
        conversationId: params.claim.conversation_id,
        content: params.draft,
        commandId: params.commandId,
      },
      {
        kind: 'SYSTEM_WORKER',
        companyId: params.claim.company_id,
        actorType: 'AI',
        workerName: 'ai_brain_live_worker',
      }
    );

    if (sendResult.success && (sendResult.status === 'SENT' || sendResult.status === 'ALREADY_SENT')) {
      return {
        outcome: 'SENT',
        externalMessageId: sendResult.externalMessageId ?? null,
      };
    }

    return {
      outcome: 'FAILED',
      errorCode: sendResult.error || 'SEND_FAILED',
    };
  }
}
