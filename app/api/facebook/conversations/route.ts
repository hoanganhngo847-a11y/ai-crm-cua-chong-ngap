import {
    errorResponse,
    listConversations,
} from '@/features/omnichannel/facebook/server';

export async function GET(request: Request) {
    try {
        const before = new URL(request.url).searchParams.get('before');

        return Response.json(
            await listConversations(before, new URL(request.url).searchParams.get('page')),
            { headers: { 'Cache-Control': 'no-store' } },
        );
    } catch (error) {
        return errorResponse(error);
    }
}
