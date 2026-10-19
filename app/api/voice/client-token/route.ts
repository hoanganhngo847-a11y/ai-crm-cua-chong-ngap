import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabase/server';
import { getActorContext, requireActiveMember } from '../../../../lib/auth/context';
import { resolveCompanyVoiceIntegration } from '../../../../features/voice/services/integration-resolver';
import {
  createStringeeClientToken,
  toStringeeSaleUserId,
} from '../../../../features/voice/providers/stringee-provider';

export const dynamic = 'force-dynamic';

/**
 * Issues a short-lived Stringee Web SDK token for the currently authenticated CRM sale.
 * Provider API secrets remain server-side. The Stringee identity is derived from actor.userId,
 * never accepted from browser input.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const client = await createClient();
    const actor = await getActorContext(undefined, client);
    if (!actor || actor.profileStatus !== 'ACTIVE' || !actor.companyId || actor.membershipStatus !== 'ACTIVE') {
      return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
    }

    const member = await requireActiveMember(actor.companyId, client);
    if (member.role === 'TECHNICIAN') {
      return NextResponse.json({ error: 'ROLE_FORBIDDEN' }, { status: 403 });
    }

    const integration = await resolveCompanyVoiceIntegration(actor.companyId, 'STRINGEE');
    if (!integration?.apiKey || !integration.apiSecret || !integration.fromNumber || !integration.answerUrl) {
      return NextResponse.json({ error: 'CALL_PROVIDER_NOT_CONFIGURED' }, { status: 503 });
    }

    const userId = toStringeeSaleUserId(actor.userId);
    const accessToken = createStringeeClientToken(integration.apiKey, integration.apiSecret, userId);

    return NextResponse.json(
      { ok: true, accessToken, userId, expiresIn: 3600 },
      {
        headers: {
          'Cache-Control': 'no-store, private',
          Pragma: 'no-cache',
        },
      }
    );
  } catch {
    return NextResponse.json({ error: 'VOICE_CLIENT_TOKEN_FAILED' }, { status: 500 });
  }
}
