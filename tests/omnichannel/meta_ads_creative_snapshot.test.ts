import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { encryptToken } from '../../features/omnichannel/facebook/token-vault';
import { fetchMetaAdCreativeSnapshot, normalizeMetaAdCreativeSnapshot, syncPendingCreativeSnapshots } from '../../features/omnichannel/facebook/marketing-sync';

const imageUrl = 'https://scontent.xx.fbcdn.net/v/t45.1600-4/example.jpg';

test('Meta creative snapshot normalizes image ad copy, CTA, destination and trusted media URL', () => {
    const snapshot = normalizeMetaAdCreativeSnapshot({
        id: 'ad_image_01',
        name: 'Tuyển sinh du học Áo',
        preview_shareable_link: 'https://www.facebook.com/ads/preview/example',
        campaign: { id: 'campaign_01', name: 'Chiến dịch mùa thu' },
        adset: { id: 'adset_01', name: 'Học sinh lớp 12' },
        creative: {
            id: 'creative_01',
            name: 'Ảnh học bổng',
            effective_object_story_id: '1026991374010112_123456789',
            object_story_spec: {
                page_id: '1026991374010112',
                link_data: {
                    message: 'Tư vấn học bổng du học Áo',
                    name: 'Đăng ký tư vấn miễn phí',
                    description: 'Cơ hội học tập tại Áo',
                    picture: imageUrl,
                    link: 'https://example.edu.vn/austria',
                    call_to_action: { type: 'SIGN_UP', value: { link: 'https://example.edu.vn/austria' } },
                },
            },
        },
    }, { capturedAt: '2026-11-03T10:00:00.000Z' });

    assert.equal(snapshot.status, 'AVAILABLE');
    assert.equal(snapshot.format, 'IMAGE');
    assert.equal(snapshot.adName, 'Tuyển sinh du học Áo');
    assert.equal(snapshot.campaignName, 'Chiến dịch mùa thu');
    assert.equal(snapshot.adsetName, 'Học sinh lớp 12');
    assert.equal(snapshot.adsetId, 'adset_01');
    assert.equal(snapshot.creativeId, 'creative_01');
    assert.equal(snapshot.pageId, '1026991374010112');
    assert.equal(snapshot.pageIdConflict, undefined);
    assert.equal(snapshot.primaryText, 'Tư vấn học bổng du học Áo');
    assert.deepEqual(snapshot.headlines, ['Đăng ký tư vấn miễn phí']);
    assert.deepEqual(snapshot.descriptions, ['Cơ hội học tập tại Áo']);
    assert.equal(snapshot.ctaType, 'SIGN_UP');
    assert.equal(snapshot.destinationUrl, 'https://example.edu.vn/austria');
    assert.equal(snapshot.imageUrl, imageUrl);
    assert.equal(snapshot.previewUrl, 'https://www.facebook.com/ads/preview/example');
    assert.equal(snapshot.capturedAt, '2026-11-03T10:00:00.000Z');
});


test('Meta creative page binding is extracted from effective story IDs and conflicts fail closed', () => {
    const fromStoryId = normalizeMetaAdCreativeSnapshot({
        id: 'ad_story_id_01',
        creative: {
            id: 'creative_story_id_01',
            effective_object_story_id: '1026991374010112_987654321',
            link_url: 'https://example.edu.vn',
        },
    });
    assert.equal(fromStoryId.pageId, '1026991374010112');
    assert.equal(fromStoryId.pageIdConflict, undefined);

    const conflicting = normalizeMetaAdCreativeSnapshot({
        id: 'ad_conflicting_page_01',
        creative: {
            id: 'creative_conflicting_page_01',
            effective_object_story_id: '2222222222222222_987654321',
            object_story_spec: {
                page_id: '1026991374010112',
                link_data: { message: 'Creative with conflicting Page evidence' },
            },
        },
    });
    assert.equal(conflicting.pageId, undefined);
    assert.equal(conflicting.pageIdConflict, true);
});

test('Meta creative snapshot identifies video creative and preserves video ID plus thumbnail', () => {
    const snapshot = normalizeMetaAdCreativeSnapshot({
        id: 'ad_video_01',
        creative: {
            id: 'creative_video_01',
            video_id: '987654321',
            thumbnail_url: imageUrl,
            object_story_spec: {
                video_data: {
                    message: 'Xem video giới thiệu chương trình',
                    title: 'Du học Áo 2027',
                    video_id: '987654321',
                    image_url: imageUrl,
                    call_to_action: { type: 'LEARN_MORE', value: { link: 'https://example.edu.vn/video' } },
                },
            },
        },
    });

    assert.equal(snapshot.status, 'AVAILABLE');
    assert.equal(snapshot.format, 'VIDEO');
    assert.equal(snapshot.videoId, '987654321');
    assert.equal(snapshot.thumbnailUrl, imageUrl);
    assert.equal(snapshot.primaryText, 'Xem video giới thiệu chương trình');
    assert.deepEqual(snapshot.headlines, ['Du học Áo 2027']);
    assert.equal(snapshot.ctaType, 'LEARN_MORE');
    assert.equal(snapshot.destinationUrl, 'https://example.edu.vn/video');
});

test('Meta creative snapshot preserves carousel cards as independent assets', () => {
    const secondImage = 'https://lookaside.fbsbx.com/example/card-2.jpg';
    const snapshot = normalizeMetaAdCreativeSnapshot({
        id: 'ad_carousel_01',
        creative: {
            id: 'creative_carousel_01',
            object_story_spec: {
                link_data: {
                    message: 'Chọn chương trình phù hợp',
                    child_attachments: [
                        { name: 'Chương trình A', description: 'Mô tả A', picture: imageUrl, link: 'https://example.edu.vn/a' },
                        { name: 'Chương trình B', description: 'Mô tả B', picture: secondImage, link: 'https://example.edu.vn/b' },
                    ],
                },
            },
        },
    });

    assert.equal(snapshot.format, 'CAROUSEL');
    assert.equal(snapshot.carouselAssets.length, 2);
    assert.equal(snapshot.carouselAssets[0].title, 'Chương trình A');
    assert.equal(snapshot.carouselAssets[1].imageUrl, secondImage);
});

test('Meta dynamic creative keeps copy and asset variants separate without fabricated pairings', () => {
    const snapshot = normalizeMetaAdCreativeSnapshot({
        id: 'ad_dynamic_01',
        creative: {
            id: 'creative_dynamic_01',
            asset_feed_spec: {
                bodies: [{ text: 'Nội dung A' }, { text: 'Nội dung B' }],
                titles: [{ text: 'Tiêu đề A' }, { text: 'Tiêu đề B' }],
                descriptions: [{ text: 'Mô tả A' }, { text: 'Mô tả B' }],
                images: [{ url: imageUrl }],
                videos: [{ video_id: 'video_dynamic_01', thumbnail_url: imageUrl }],
                link_urls: [{ website_url: 'https://example.edu.vn/dynamic' }],
                call_to_action_types: [{ type: 'SIGN_UP' }],
            },
        },
    });

    assert.equal(snapshot.format, 'DYNAMIC');
    assert.deepEqual(snapshot.headlines, ['Tiêu đề A', 'Tiêu đề B']);
    assert.deepEqual(snapshot.descriptions, ['Mô tả A', 'Mô tả B']);
    assert.equal(snapshot.imageAssets.length, 1);
    assert.equal(snapshot.videoAssets.length, 1);
    assert.equal(snapshot.primaryText, 'Nội dung A');
    assert.deepEqual(snapshot.primaryTexts, ['Nội dung A', 'Nội dung B']);
    assert.equal(snapshot.destinationUrl, 'https://example.edu.vn/dynamic');
});

test('Meta creative snapshot rejects insecure and non-Meta media URLs', () => {
    const snapshot = normalizeMetaAdCreativeSnapshot({
        id: 'ad_unsafe_01',
        preview_shareable_link: 'https://attacker.example/preview',
        creative: {
            id: 'creative_unsafe_01',
            image_url: 'https://attacker.example/image.jpg',
            object_story_spec: {
                link_data: {
                    picture: 'http://scontent.xx.fbcdn.net/insecure.jpg',
                    message: 'Nội dung vẫn được giữ',
                    link: 'javascript:alert(1)',
                },
            },
        },
    });

    assert.equal(snapshot.status, 'AVAILABLE');
    assert.equal(snapshot.imageUrl, undefined);
    assert.equal(snapshot.destinationUrl, undefined);
    assert.equal(snapshot.previewUrl, undefined);
    assert.equal(snapshot.primaryText, 'Nội dung vẫn được giữ');
});


test('creative permission failures remain distinguishable and retryable; deleted ads are terminal', async () => {
    const originalFetch = globalThis.fetch;
    const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const previousEncryptionKey = process.env.META_TOKEN_ENCRYPTION_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-key';
    process.env.META_TOKEN_ENCRYPTION_KEY = 'c'.repeat(64);
    const encrypted = encryptToken('EAA_meta_creative_test_token');

    const run = async (status: number, code: number) => {
        globalThis.fetch = (async (input) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.hostname === '127.0.0.1' && url.pathname.endsWith('/meta_ads')) {
                return Response.json({ ad_account_id: 'act_test' });
            }
            if (url.hostname === '127.0.0.1' && url.pathname.endsWith('/rpc/get_meta_ad_account_token')) {
                return Response.json([{ encrypted_access_token: encrypted, token_expires_at: null }]);
            }
            if (url.hostname === 'graph.facebook.com') {
                return Response.json({ error: { code } }, { status });
            }
            throw new Error('UNEXPECTED_TEST_REQUEST');
        }) as typeof fetch;
        return fetchMetaAdCreativeSnapshot('company-test', 'ad-test');
    };

    try {
        const permission = await run(403, 200);
        assert.equal(permission.status, 'PENDING_SYNC');
        assert.equal(permission.reason, 'META_PERMISSION_DENIED');

        const deleted = await run(404, 803);
        assert.equal(deleted.status, 'UNAVAILABLE');
        assert.equal(deleted.reason, 'AD_NOT_FOUND_OR_DELETED');
    } finally {
        globalThis.fetch = originalFetch;
        if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
        if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
        if (previousEncryptionKey === undefined) delete process.env.META_TOKEN_ENCRYPTION_KEY;
        else process.env.META_TOKEN_ENCRYPTION_KEY = previousEncryptionKey;
    }
});

test('creative backfill uses compare-and-set so stale results cannot overwrite a newer snapshot', async () => {
    const originalFetch = globalThis.fetch;
    const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const previousEncryptionKey = process.env.META_TOKEN_ENCRYPTION_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-key';
    process.env.META_TOKEN_ENCRYPTION_KEY = 'd'.repeat(64);
    const encrypted = encryptToken('EAA_meta_backfill_test_token');
    type BackfillPatch = {
        ads_context_data?: {
            raw_meta?: { campaign_id?: string };
            creative_snapshot?: { captureTiming?: string };
        };
    };
    const patchRequests: Array<{ url: URL; body: BackfillPatch }> = [];

    globalThis.fetch = (async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === '127.0.0.1') {
            if (url.pathname.endsWith('/lead_attribution_touchpoints') && (init?.method || 'GET') === 'GET') {
                return Response.json([{
                    id: 'touchpoint-1',
                    meta_ad_id: 'ad-backfill',
                    ads_context_data: {
                        raw_meta: { campaign_id: 'campaign-raw' },
                        creative_snapshot: {
                            schemaVersion: 2, status: 'AVAILABLE', source: 'META_MARKETING_API',
                            capturedAt: '2026-11-03T10:00:00.000Z', captureTiming: 'AT_LEAD_INTAKE',
                            adId: 'ad-backfill', format: 'IMAGE',
                            primaryTexts: [], headlines: [], descriptions: [],
                            carouselAssets: [], imageAssets: [], videoAssets: [],
                        },
                    },
                }]);
            }
            if (url.pathname.endsWith('/meta_ads')) return Response.json({ ad_account_id: 'act_backfill' });
            if (url.pathname.endsWith('/rpc/get_meta_ad_account_token')) {
                return Response.json([{ encrypted_access_token: encrypted, token_expires_at: null }]);
            }
            if (url.pathname.endsWith('/lead_attribution_touchpoints') && init?.method === 'PATCH') {
                patchRequests.push({ url, body: JSON.parse(String(init.body || '{}')) as BackfillPatch });
                // Simulate another worker having written a final snapshot after our scan.
                return Response.json([]);
            }
        }
        if (url.hostname === 'graph.facebook.com') {
            return Response.json({
                id: 'ad-backfill',
                creative: { id: 'creative-backfill', object_story_spec: { link_data: { message: 'Late creative' } } },
            });
        }
        throw new Error('UNEXPECTED_TEST_REQUEST');
    }) as typeof fetch;

    try {
        const summary = await syncPendingCreativeSnapshots('company-test');
        assert.equal(summary.scanned, 1);
        assert.equal(summary.updated, 0, 'zero returned rows means a newer snapshot won the compare-and-set');
        assert.equal(summary.failed, 0);
        const patch = patchRequests[0];
        assert.ok(patch, 'backfill attempted a conditional update');
        const guard = patch.url.searchParams.get('or') || '';
        assert.match(guard, /PENDING_SYNC/);
        assert.match(guard, /creative_snapshot\.is\.null/);
        assert.match(guard, /pageId\.is\.null/, 'missing Page identity remains eligible for compare-and-set backfill');
        assert.equal(patch.body.ads_context_data?.raw_meta?.campaign_id, 'campaign-raw', 'raw Meta evidence survives backfill');
        assert.equal(patch.body.ads_context_data?.creative_snapshot?.captureTiming, 'BACKFILL');
    } finally {
        globalThis.fetch = originalFetch;
        if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
        if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
        if (previousEncryptionKey === undefined) delete process.env.META_TOKEN_ENCRYPTION_KEY;
        else process.env.META_TOKEN_ENCRYPTION_KEY = previousEncryptionKey;
    }
});

test('Customer 360 exposes page/form provenance, unverified Meta assertions and full creative evidence', () => {
    const source = readFileSync('app/(dashboard)/customers/[id]/page.tsx', 'utf8');
    for (const field of ['page_id', 'meta_form_id', 'meta_leadgen_id', 'raw_meta', 'capturedAt', 'primaryTexts', 'META_PERMISSION_DENIED', 'carouselAssets.map', 'videoAssets.map']) {
        assert.ok(source.includes(field), `Customer 360 is missing ${field}`);
    }
    assert.match(source, /Asia\/Ho_Chi_Minh/);
    assert.match(source, /không chứng minh tuyệt đối đúng tổ hợp quảng cáo đã phân phối/);
});
