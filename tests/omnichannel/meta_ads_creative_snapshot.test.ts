import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeMetaAdCreativeSnapshot } from '../../features/omnichannel/facebook/marketing-sync';

const imageUrl = 'https://scontent.xx.fbcdn.net/v/t45.1600-4/example.jpg';

test('Meta creative snapshot normalizes image ad copy, CTA, destination and trusted media URL', () => {
    const snapshot = normalizeMetaAdCreativeSnapshot({
        id: 'ad_image_01',
        name: 'Tuyển sinh du học Áo',
        campaign: { id: 'campaign_01', name: 'Chiến dịch mùa thu' },
        adset: { id: 'adset_01', name: 'Học sinh lớp 12' },
        creative: {
            id: 'creative_01',
            name: 'Ảnh học bổng',
            object_story_spec: {
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
    assert.equal(snapshot.creativeId, 'creative_01');
    assert.equal(snapshot.primaryText, 'Tư vấn học bổng du học Áo');
    assert.deepEqual(snapshot.headlines, ['Đăng ký tư vấn miễn phí']);
    assert.deepEqual(snapshot.descriptions, ['Cơ hội học tập tại Áo']);
    assert.equal(snapshot.ctaType, 'SIGN_UP');
    assert.equal(snapshot.destinationUrl, 'https://example.edu.vn/austria');
    assert.equal(snapshot.imageUrl, imageUrl);
    assert.equal(snapshot.capturedAt, '2026-11-03T10:00:00.000Z');
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
    assert.equal(snapshot.destinationUrl, 'https://example.edu.vn/dynamic');
});

test('Meta creative snapshot rejects insecure and non-Meta media URLs', () => {
    const snapshot = normalizeMetaAdCreativeSnapshot({
        id: 'ad_unsafe_01',
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
    assert.equal(snapshot.primaryText, 'Nội dung vẫn được giữ');
});
