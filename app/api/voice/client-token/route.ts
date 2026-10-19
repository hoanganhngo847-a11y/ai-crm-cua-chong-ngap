import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '../../../../lib/supabase/server';
import { AuthError, getActorContext, requireActiveMember, requireBossAdmin } from '../../../../lib/auth/context';
import { resolveCompanyVoiceIntegration } from '../../../../features/voice/services/integration-resolver';
import {
  createStringeeClientToken,
  toStringeeSaleUserId,
  toStringeeTestUserIds,
} from '../../../../features/voice/providers/stringee-provider';
import { STRINGEE_SERVER_ADDRS } from '../../../../features/voice/client/stringee-sdk';

export const dynamic = 'force-dynamic';

/**
 * Issues a short-lived Stringee Web SDK token for the currently authenticated CRM sale.
 * Provider API secrets remain server-side. The Stringee identity is derived from actor.userId,
 * never accepted from browser input.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
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
    if (!integration?.apiKey || !integration.apiSecret) {
      return NextResponse.json({ error: 'CALL_PROVIDER_NOT_CONFIGURED' }, { status: 503 });
    }

    const testClient = request.nextUrl.searchParams.get('testClient');
    const testEnabled = Boolean(process.env.STRINGEE_APP_TO_APP_TEST_PROJECT_ID) &&
      integration.providerAccountId === process.env.STRINGEE_APP_TO_APP_TEST_PROJECT_ID;
    if (testClient !== null && (!testEnabled || !['A', 'B'].includes(testClient))) {
      return NextResponse.json({ error: 'VOICE_TEST_DISABLED' }, { status: 403 });
    }
    if (testClient !== null) await requireBossAdmin(actor.companyId, {}, client);
    const testUsers = testClient !== null ? toStringeeTestUserIds(actor.userId, actor.companyId) : null;
    const userId = testUsers
      ? testUsers[testClient as 'A' | 'B']
      : toStringeeSaleUserId(actor.userId, actor.companyId);
    const accessToken = createStringeeClientToken(integration.apiKey, integration.apiSecret, userId);

    return NextResponse.json(
      {
        ok: true, accessToken, userId, expiresIn: 3600,
        serverAddresses: STRINGEE_SERVER_ADDRS,
        pstnAvailable: Boolean(integration.fromNumber && integration.answerUrl),
        recordingEnabled: process.env.VOICE_RECORDING_ENABLED === 'true',
        ...(testUsers ? { peerUserId: testUsers[testClient === 'A' ? 'B' : 'A'] } : {}),
      },
      {
        headers: {
          'Cache-Control': 'no-store, private',
          Pragma: 'no-cache',
        },
      }
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: 'VOICE_CLIENT_TOKEN_FAILED' }, { status: 500 });
  }
}
