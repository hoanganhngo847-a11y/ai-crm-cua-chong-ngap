import {
    campaignStats,
    errorResponse,
} from "@/features/omnichannel/facebook/server";

export async function GET(
    _request: Request,
    context: { params: Promise<{ id: string }> },
) {
    try {
        const { id } = await context.params;

        return Response.json(await campaignStats(id), {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        return errorResponse(error);
    }
}