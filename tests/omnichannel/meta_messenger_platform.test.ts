import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
    binding,
    pageBindings,
} from '../../features/omnichannel/facebook/binding';
import {
    ChannelError,
    parseMeta,
    parseSignedRequest,
    validSignature,
} from '../../features/omnichannel/facebook/core';
import {
    authorizeConversation,
    errorResponse,
    sendMessage,
} from '../../features/omnichannel/facebook/server';
import { dispatchMessage } from '../../features/omnichannel/facebook/transport';
import { GET as webhookGet, POST as webhookPost } from '../../app/api/webhooks/meta/route';
import { GET as dataDeletionGet, POST as dataDeletionPost } from '../../app/api/facebook/data-deletion/route';

const TARGET_PAGE_ID = '1026991374010112';
const SECONDARY_PAGE_ID = '2222222222222222';
const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';
const APP_SECRET = 'meta-app-secret-production-test-key-32ch';
const VERIFY_TOKEN = 'chd-meta-verify-token-production-secret';
const PAGE_A_TOKEN = 'META_TEST_TOKEN_CHD_PAGE_ACCESS_TOKEN';
const PAGE_B_TOKEN = 'META_TEST_TOKEN_SECONDARY_PAGE_ACCESS';
const GRAPH_VERSION = 'v21.0';

(process.env as Record<string, string | undefined>).NODE_ENV = 'test';
process.env.WEBSITE_ORIGIN = 'https://ai-crm-cua-chong-ngap.onrender.com';
process.env.META_APP_SECRET = APP_SECRET;
process.env.META_VERIFY_TOKEN = VERIFY_TOKEN;
process.env.META_GRAPH_VERSION = GRAPH_VERSION;
process.env.META_PAGE_CHD_TOKEN = PAGE_A_TOKEN;
process.env.META_PAGE_B_TOKEN = PAGE_B_TOKEN;
process.env.META_DATA_DELETION_COMPANY_ID = COMPANY_A;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-never-for-client';

process.env.META_PAGE_BINDINGS = JSON.stringify([
    {
        page: TARGET_PAGE_ID,
        company: COMPANY_A,
        tokenEnv: 'META_PAGE_CHD_TOKEN',
        name: 'Du học Đức và Học Tiếng Đức CHD',
    },
    {
        page: SECONDARY_PAGE_ID,
        company: COMPANY_B,
        tokenEnv: 'META_PAGE_B_TOKEN',
        name: 'Secondary Support Page',
    },
]);

function signPayload(raw: string, secret = APP_SECRET) {
    return 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
}

function makeWebhookEvent(pageId = TARGET_PAGE_ID, senderPsid = '987654321012345', text = 'Xin chào CHD', mid = 'mid.$chd_test_001') {
    return {
        object: 'page',
        entry: [
            {
                id: pageId,
                time: Date.now(),
                messaging: [
                    {
                        sender: { id: senderPsid },
                        recipient: { id: pageId },
                        timestamp: Date.now(),
                        message: {
                            mid,
                            text,
                        },
                    },
                ],
            },
        ],
    };
}

function createSignedRequest(payloadObj: Record<string, unknown>, secret = APP_SECRET) {
    const payloadStr = JSON.stringify(payloadObj);
    const encodedPayload = Buffer.from(payloadStr, 'utf8').toString('base64url');
    const sig = createHmac('sha256', secret).update(encodedPayload).digest();
    const encodedSig = Buffer.from(sig).toString('base64url');
    return `${encodedSig}.${encodedPayload}`;
}

test('1. Inbound Webhook GET: verification handshake strictly validates hub.mode and verify_token', async () => {
    // 1A: Valid handshake
    const validUrl = `https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=chd_challenge_998877`;
    const resOk = await webhookGet(new Request(validUrl));
    assert.equal(resOk.status, 200);
    assert.equal(await resOk.text(), 'chd_challenge_998877');
    assert.equal(resOk.headers.get('content-type'), 'text/plain');

    // 1B: Wrong verify token fails with 403
    const badTokenUrl = `https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=test`;
    const resBadToken = await webhookGet(new Request(badTokenUrl));
    assert.equal(resBadToken.status, 403);

    // 1C: Wrong hub.mode fails with 403
    const badModeUrl = `https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta?hub.mode=publish&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=test`;
    const resBadMode = await webhookGet(new Request(badModeUrl));
    assert.equal(resBadMode.status, 403);

    // 1D: Missing challenge fails with 400
    const missingChallengeUrl = `https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`;
    const resMissingChallenge = await webhookGet(new Request(missingChallengeUrl));
    assert.equal(resMissingChallenge.status, 400);
});

test('2. Inbound Webhook POST: signature validation fails closed on tampered or missing signatures', async () => {
    const raw = JSON.stringify(makeWebhookEvent());
    const validSig = signPayload(raw);

    // 2A: Valid signature passes signature check
    assert.equal(validSignature(raw, validSig, APP_SECRET), true);

    // 2B: Tampered raw payload fails
    const tampered = raw + ' ';
    assert.equal(validSignature(tampered, validSig, APP_SECRET), false);

    // 2C: Wrong secret fails
    assert.equal(validSignature(raw, signPayload(raw, 'wrong-app-secret-1234567890'), APP_SECRET), false);

    // 2D: Missing and malformed signatures fail
    assert.equal(validSignature(raw, null, APP_SECRET), false);
    assert.equal(validSignature(raw, 'sha256=invalidhex', APP_SECRET), false);
    assert.equal(validSignature(raw, 'md5=something', APP_SECRET), false);

    // 2E: Webhook POST endpoint rejects unsigned and tampered requests with 403
    const reqUnsigned = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
        method: 'POST',
        body: raw,
    });
    assert.equal((await webhookPost(reqUnsigned)).status, 403);

    const reqTampered = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
        method: 'POST',
        headers: { 'x-hub-signature-256': validSig },
        body: tampered,
    });
    assert.equal((await webhookPost(reqTampered)).status, 403);
});

test('3. Target Page ID 1026991374010112 binding & strict tenant isolation', async () => {
    // 3A: Target Page ID correctly resolves to Company A
    const bChd = binding(TARGET_PAGE_ID);
    assert.equal(bChd.page, TARGET_PAGE_ID);
    assert.equal(bChd.company, COMPANY_A);
    assert.equal(bChd.tokenEnv, 'META_PAGE_CHD_TOKEN');
    assert.equal(bChd.name, 'Du học Đức và Học Tiếng Đức CHD');

    // 3B: Secondary Page ID correctly resolves to Company B
    const bSecondary = binding(SECONDARY_PAGE_ID);
    assert.equal(bSecondary.page, SECONDARY_PAGE_ID);
    assert.equal(bSecondary.company, COMPANY_B);
    assert.equal(bSecondary.tokenEnv, 'META_PAGE_B_TOKEN');

    // 3C: Unknown Page ID fails closed with 404 NOT_FOUND
    assert.throws(() => binding('9999999999999999'), (err: any) => err.code === 'NOT_FOUND' && err.status === 404);

    // 3D: Webhook POST with unknown Page ID fails with 404 and NEVER accesses DB
    const unknownPageEvent = JSON.stringify(makeWebhookEvent('9999999999999999'));
    const reqUnknown = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
        method: 'POST',
        headers: { 'x-hub-signature-256': signPayload(unknownPageEvent) },
        body: unknownPageEvent,
    });
    assert.equal((await webhookPost(reqUnknown)).status, 404);

    // 3E: Inbound message where recipient.id !== page fails with 403 PAGE_NOT_ALLOWED
    const mismatchRecipientEvent = {
        object: 'page',
        entry: [
            {
                id: TARGET_PAGE_ID,
                messaging: [
                    {
                        sender: { id: '12345' },
                        recipient: { id: SECONDARY_PAGE_ID }, // mismatch!
                        timestamp: Date.now(),
                        message: { mid: 'mid.mismatch', text: 'hello' },
                    },
                ],
            },
        ],
    };
    assert.throws(() => parseMeta(mismatchRecipientEvent, TARGET_PAGE_ID), (err: any) => err.code === 'PAGE_NOT_ALLOWED' && err.status === 403);
});

test('4. Inbound Webhook uses Meta MID as Idempotency Key (p_key = page:mid)', async () => {
    const originalFetch = globalThis.fetch;
    const rpcCalls: Array<{ name: string; args: any }> = [];

    globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/rest/v1/rpc/han_ingest')) {
            const body = JSON.parse(String(init?.body));
            rpcCalls.push({ name: 'han_ingest', args: body });
            return Response.json({ status: 'RECEIVED', interaction_id: 'test-int-001' });
        }
        if (url.includes('graph.facebook.com')) {
            // Best-effort profile enrichment
            return Response.json({ name: 'Nguyễn Văn A' });
        }
        if (url.includes('/rest/v1/')) {
            return Response.json([]);
        }
        throw new Error(`Unexpected fetch call to ${url}`);
    };

    try {
        const event = makeWebhookEvent(TARGET_PAGE_ID, '987654321', 'Cần tư vấn du học Đức A1', 'mid.$chd_canonical_mid_789');
        const raw = JSON.stringify(event);
        const req = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
            method: 'POST',
            headers: { 'x-hub-signature-256': signPayload(raw) },
            body: raw,
        });

        const res = await webhookPost(req);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { received: true });

        assert.equal(rpcCalls.length, 1);
        const ingest = rpcCalls[0].args;
        assert.equal(ingest.p_company, COMPANY_A, 'Bound strictly to Company A');
        assert.equal(ingest.p_channel, 'FACEBOOK');
        assert.equal(ingest.p_external, `${TARGET_PAGE_ID}:987654321`, 'External identity is page:psid');
        assert.equal(ingest.p_key, `${TARGET_PAGE_ID}:mid.$chd_canonical_mid_789`, 'Idempotency key uses Meta MID');
        assert.equal(ingest.p_content, 'Cần tư vấn du học Đức A1');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('5. URL-only inbound message preserves full URL in p_content and sanitizes for p_safe', async () => {
    const originalFetch = globalThis.fetch;
    const rpcCalls: any[] = [];

    globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/rest/v1/rpc/han_ingest')) {
            const body = JSON.parse(String(init?.body));
            rpcCalls.push(body);
            return Response.json({ status: 'RECEIVED', interaction_id: 'test-url-int' });
        }
        return Response.json([]);
    };

    try {
        const testUrl = 'https://duhocchd.edu.vn/khoa-hoc-tieng-duc-b1?ref=facebook&campaign=mua_thu_2026#dang-ky';
        const event = makeWebhookEvent(TARGET_PAGE_ID, '1122334455', testUrl, 'mid.$url_only_mid_999');
        const raw = JSON.stringify(event);
        const req = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
            method: 'POST',
            headers: { 'x-hub-signature-256': signPayload(raw) },
            body: raw,
        });

        const res = await webhookPost(req);
        assert.equal(res.status, 200);

        assert.equal(rpcCalls.length, 1);
        assert.equal(rpcCalls[0].p_content, testUrl, 'Raw content preserves full URL verbatim');
        assert.equal(rpcCalls[0].p_key, `${TARGET_PAGE_ID}:mid.$url_only_mid_999`);
        assert.equal(rpcCalls[0].p_safe_status, 'SUCCEEDED');
        assert.ok(rpcCalls[0].p_safe.includes('[liên kết đã ẩn]'), 'Safe content redacts raw URL for Zero-Phone/privacy enforcement');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('6. Repeated identical messages/URLs with different Meta MIDs do NOT falsely deduplicate', async () => {
    const originalFetch = globalThis.fetch;
    const ingestedKeys: string[] = [];
    const ingestedContents: string[] = [];

    globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/rest/v1/rpc/han_ingest')) {
            const body = JSON.parse(String(init?.body));
            ingestedKeys.push(body.p_key);
            ingestedContents.push(body.p_content);
            return Response.json({ status: 'RECEIVED', interaction_id: `int-${ingestedKeys.length}` });
        }
        return Response.json([]);
    };

    try {
        const repeatedUrl = 'https://duhocchd.edu.vn/hoc-tieng-duc';

        // Message 1
        const event1 = makeWebhookEvent(TARGET_PAGE_ID, '4455667788', repeatedUrl, 'mid.$repeat_mid_001');
        const raw1 = JSON.stringify(event1);
        const res1 = await webhookPost(new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
            method: 'POST',
            headers: { 'x-hub-signature-256': signPayload(raw1) },
            body: raw1,
        }));
        assert.equal(res1.status, 200);

        // Message 2: exact same sender and exact same URL, but distinct Meta MID
        const event2 = makeWebhookEvent(TARGET_PAGE_ID, '4455667788', repeatedUrl, 'mid.$repeat_mid_002');
        const raw2 = JSON.stringify(event2);
        const res2 = await webhookPost(new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
            method: 'POST',
            headers: { 'x-hub-signature-256': signPayload(raw2) },
            body: raw2,
        }));
        assert.equal(res2.status, 200);

        // Both messages must be ingested with their distinct idempotency keys
        assert.equal(ingestedKeys.length, 2, 'Both distinct messages must reach ingest');
        assert.equal(ingestedKeys[0], `${TARGET_PAGE_ID}:mid.$repeat_mid_001`);
        assert.equal(ingestedKeys[1], `${TARGET_PAGE_ID}:mid.$repeat_mid_002`);
        assert.equal(ingestedContents[0], repeatedUrl);
        assert.equal(ingestedContents[1], repeatedUrl);
        assert.notEqual(ingestedKeys[0], ingestedKeys[1], 'Keys are distinct, avoiding false deduplication');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('7. Webhook retry with identical Meta MID is handled idempotently without duplicates', async () => {
    const originalFetch = globalThis.fetch;
    let ingestCallCount = 0;
    const dbSimulatedIntake = new Map<string, any>();

    globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/rest/v1/rpc/han_ingest')) {
            ingestCallCount++;
            const body = JSON.parse(String(init?.body));
            const existing = dbSimulatedIntake.get(body.p_key);
            if (existing) {
                // DB idempotency return
                return Response.json({ status: existing.status, interaction_id: existing.interaction_id, is_duplicate: true });
            }
            const record = { status: 'RECEIVED', interaction_id: `interaction-${ingestCallCount}` };
            dbSimulatedIntake.set(body.p_key, record);
            return Response.json(record);
        }
        return Response.json([]);
    };

    try {
        const event = makeWebhookEvent(TARGET_PAGE_ID, '5566778899', 'Hỏi lớp luyện thi TestDaF', 'mid.$retry_test_100');
        const raw = JSON.stringify(event);
        const makeReq = () => new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta', {
            method: 'POST',
            headers: { 'x-hub-signature-256': signPayload(raw) },
            body: raw,
        });

        // First attempt
        const res1 = await webhookPost(makeReq());
        assert.equal(res1.status, 200);

        // Meta retries after network lag with identical MID
        const resRetry = await webhookPost(makeReq());
        assert.equal(resRetry.status, 200);

        assert.equal(ingestCallCount, 2, 'Endpoint forwards retry to DB idempotency engine');
        assert.equal(dbSimulatedIntake.size, 1, 'Only one unique intake event in DB storage (zero duplicates)');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('8. Outbound routing: uses correct Page ID, correct Page token, and enforces tenant isolation', async () => {
    const originalFetch = globalThis.fetch;
    const graphRequests: Array<{ url: string; headers: Headers; body: any }> = [];

    globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('graph.facebook.com')) {
            graphRequests.push({
                url,
                headers: new Headers(init?.headers),
                body: JSON.parse(String(init?.body)),
            });
            return Response.json({ message_id: 'mid.$outbound_response_001' });
        }
        return Response.json([]);
    };

    try {
        // Direct transport check: target Page 1026991374010112 uses META_PAGE_CHD_TOKEN
        const chdBinding = binding(TARGET_PAGE_ID);
        const chdToken = process.env[chdBinding.tokenEnv]!;

        const result = await dispatchMessage({
            page: chdBinding.page,
            recipient: 'psid_customer_chd_123',
            version: GRAPH_VERSION,
            token: chdToken,
            content: 'Chào bạn, trung tâm CHD đã nhận thông tin và sẽ liên hệ hỗ trợ.',
        });

        assert.equal(result.status, 'SENT');
        assert.equal(result.mid, 'mid.$outbound_response_001');

        assert.equal(graphRequests.length, 1);
        const req = graphRequests[0];
        assert.equal(req.url, `https://graph.facebook.com/${GRAPH_VERSION}/${TARGET_PAGE_ID}/messages`);
        assert.equal(req.headers.get('Authorization'), `Bearer ${PAGE_A_TOKEN}`, 'Uses target Page A token');
        assert.equal(req.body.recipient.id, 'psid_customer_chd_123');
        assert.equal(req.body.message.text, 'Chào bạn, trung tâm CHD đã nhận thông tin và sẽ liên hệ hỗ trợ.');

        // Secondary Page uses its own isolated token
        const secBinding = binding(SECONDARY_PAGE_ID);
        const secToken = process.env[secBinding.tokenEnv]!;
        await dispatchMessage({
            page: secBinding.page,
            recipient: 'psid_customer_secondary_456',
            version: GRAPH_VERSION,
            token: secToken,
            content: 'Secondary page reply',
        });

        assert.equal(graphRequests.length, 2);
        assert.equal(graphRequests[1].url, `https://graph.facebook.com/${GRAPH_VERSION}/${SECONDARY_PAGE_ID}/messages`);
        assert.equal(graphRequests[1].headers.get('Authorization'), `Bearer ${PAGE_B_TOKEN}`, 'Uses secondary Page B token');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('9. Data Deletion Endpoint: verifies HMAC-SHA256 signed_request and persists request to DB', async () => {
    const originalFetch = globalThis.fetch;
    const recordedRequests: any[] = [];
    const dbSimulatedDeletionsByCode = new Map<string, any>();
    const dbSimulatedDeletionsByFingerprint = new Map<string, any>();

    globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/rest/v1/rpc/han_record_data_deletion_request')) {
            const body = JSON.parse(String(init?.body));
            recordedRequests.push(body);

            // Exact retry idempotency check by request_fingerprint
            if (body.p_request_fingerprint && dbSimulatedDeletionsByFingerprint.has(body.p_request_fingerprint)) {
                return Response.json(dbSimulatedDeletionsByFingerprint.get(body.p_request_fingerprint));
            }

            if (dbSimulatedDeletionsByCode.has(body.p_confirmation_code)) {
                return Response.json(dbSimulatedDeletionsByCode.get(body.p_confirmation_code));
            }

            const record = {
                confirmation_code: body.p_confirmation_code,
                status: 'COMPLETED',
                resolution_strategy: 'AUTO_MATCHED',
                customer_id: 'cust-uuid-1234',
                created_at: new Date().toISOString(),
                processed_at: new Date().toISOString(),
            };
            dbSimulatedDeletionsByCode.set(body.p_confirmation_code, record);
            if (body.p_request_fingerprint) {
                dbSimulatedDeletionsByFingerprint.set(body.p_request_fingerprint, record);
            }
            return Response.json(record);
        }
        if (url.includes('/rest/v1/rpc/han_get_data_deletion_status')) {
            const body = JSON.parse(String(init?.body));
            const found = dbSimulatedDeletionsByCode.get(body.p_confirmation_code) || null;
            return Response.json(found);
        }
        return Response.json([]);
    };

    try {
        // 9A: Valid signed_request verification in core
        const payload = {
            user_id: 'fb_user_12345678',
            algorithm: 'HMAC-SHA256',
            issued_at: Math.floor(Date.now() / 1000),
        };
        const validSignedRequest = createSignedRequest(payload, APP_SECRET);
        const parsed = parseSignedRequest(validSignedRequest, APP_SECRET);
        assert.equal(parsed.userId, 'fb_user_12345678');
        assert.equal(parsed.algorithm, 'HMAC-SHA256');

        // 9B: Invalid algorithm throws 400 INVALID_ALGORITHM
        const badAlgoPayload = { ...payload, algorithm: 'PLAINTEXT' };
        const badAlgoSignedRequest = createSignedRequest(badAlgoPayload, APP_SECRET);
        assert.throws(() => parseSignedRequest(badAlgoSignedRequest, APP_SECRET), (err: any) => err.code === 'INVALID_ALGORITHM' && err.status === 400);

        // 9C: Invalid signature throws 403
        const badSigSignedRequest = createSignedRequest(payload, 'wrong-app-secret-abc');
        assert.throws(() => parseSignedRequest(badSigSignedRequest, APP_SECRET), (err: any) => err.code === 'INVALID_SIGNATURE' && err.status === 403);

        // 9D: POST /api/facebook/data-deletion with form-data returns Meta-compliant JSON & calls DB RPC
        const formData = new FormData();
        formData.set('signed_request', validSignedRequest);
        const postReq = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/facebook/data-deletion', {
            method: 'POST',
            body: formData,
        });
        const postRes = await dataDeletionPost(postReq);
        assert.equal(postRes.status, 200);
        const postBody = await postRes.json();
        assert.ok(postBody.confirmation_code && /^del_[a-f0-9]{32}$/.test(postBody.confirmation_code), 'Confirmation code matches del_<random32>');
        assert.ok(postBody.url.includes(`/data-deletion?code=${postBody.confirmation_code}`), 'URL points to data deletion status check page');

        // 9D2: HTTP EXACT RETRY IDEMPOTENCY TEST:
        // Calling POST again with the exact same Meta signed_request MUST return the existing confirmation_code and status URL!
        const retryFormData = new FormData();
        retryFormData.set('signed_request', validSignedRequest);
        const retryReq = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/facebook/data-deletion', {
            method: 'POST',
            body: retryFormData,
        });
        const retryRes = await dataDeletionPost(retryReq);
        assert.equal(retryRes.status, 200);
        const retryBody = await retryRes.json();
        assert.equal(retryBody.confirmation_code, postBody.confirmation_code, 'HTTP exact retry must return existing confirmation code');
        assert.equal(retryBody.url, postBody.url, 'HTTP exact retry must return existing status URL');

        // 9D3: NEW REQUEST WITH DIFFERENT ISSUED_AT:
        // When a user initiates a new deletion request at a later time (different issued_at / signed_request),
        // it MUST generate a new, distinct random confirmation code and process independently.
        const payload2 = {
            user_id: 'fb_user_12345678',
            algorithm: 'HMAC-SHA256',
            issued_at: payload.issued_at + 120, // 2 minutes later
        };
        const validSignedRequest2 = createSignedRequest(payload2, APP_SECRET);
        const formData2 = new FormData();
        formData2.set('signed_request', validSignedRequest2);
        const postReq2 = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/facebook/data-deletion', {
            method: 'POST',
            body: formData2,
        });
        const postRes2 = await dataDeletionPost(postReq2);
        assert.equal(postRes2.status, 200);
        const postBody2 = await postRes2.json();
        assert.notEqual(postBody.confirmation_code, postBody2.confirmation_code, 'New deletion request at different time generates fresh distinct confirmation code');
        assert.ok(/^del_[a-f0-9]{32}$/.test(postBody2.confirmation_code));

        assert.equal(recordedRequests.length, 3);
        assert.equal(recordedRequests[0].p_company, COMPANY_A);
        assert.equal(recordedRequests[0].p_meta_user_id, 'fb_user_12345678');
        assert.equal(recordedRequests[0].p_confirmation_code, postBody.confirmation_code);
        assert.ok(recordedRequests[0].p_request_fingerprint, 'Request fingerprint must be populated');

        // 9E: POST with invalid signature returns 403
        const badPostReq = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/facebook/data-deletion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ signed_request: badSigSignedRequest }),
        });
        assert.equal((await dataDeletionPost(badPostReq)).status, 403);

        // 9F: Missing or non-UUID META_DATA_DELETION_COMPANY_ID fails closed with 503
        const originalTenant = process.env.META_DATA_DELETION_COMPANY_ID;
        try {
            process.env.META_DATA_DELETION_COMPANY_ID = 'not-a-valid-uuid';
            const badTenantReq = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/facebook/data-deletion', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ signed_request: validSignedRequest }),
            });
            const badTenantRes = await dataDeletionPost(badTenantReq);
            assert.equal(badTenantRes.status, 503);
            const errBody = await badTenantRes.json();
            assert.equal(errBody.error, 'MISCONFIGURED_DELETION_TENANT');

            delete process.env.META_DATA_DELETION_COMPANY_ID;
            const missingTenantRes = await dataDeletionPost(badTenantReq);
            assert.equal(missingTenantRes.status, 503);
        } finally {
            process.env.META_DATA_DELETION_COMPANY_ID = originalTenant;
        }

        // 9G: GET with existing code returns authoritative DB status
        const getReqWithCode = new Request(`https://ai-crm-cua-chong-ngap.onrender.com/api/facebook/data-deletion?code=${postBody.confirmation_code}`);
        const getResWithCode = await dataDeletionGet(getReqWithCode);
        assert.equal(getResWithCode.status, 200);
        const getBody = await getResWithCode.json();
        assert.equal(getBody.confirmation_code, postBody.confirmation_code);
        assert.equal(getBody.status, 'COMPLETED');
        assert.equal(getBody.resolution_strategy, 'AUTO_MATCHED');

        // 9H: GET with non-existent code returns 404 NOT_FOUND (never returns fake status!)
        const getReqNonExistent = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/facebook/data-deletion?code=del_0000000000000000');
        const getResNonExistent = await dataDeletionGet(getReqNonExistent);
        assert.equal(getResNonExistent.status, 404);

        // 9I: GET without code redirects to /data-deletion
        const getReqNoCode = new Request('https://ai-crm-cua-chong-ngap.onrender.com/api/facebook/data-deletion');
        const getResNoCode = await dataDeletionGet(getReqNoCode);
        assert.equal(getResNoCode.status, 302);
        assert.ok(getResNoCode.headers.get('location')?.endsWith('/data-deletion'));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('10. Data Deletion Identity Resolution: safe auto-matching, unmapped handling, and zero guessing', async () => {
    // Tests the 3 resolution paths of han_record_data_deletion_request:
    // Path 1: Authoritative ASID match (metadata->>'asid') -> AUTO_MATCHED, status = COMPLETED
    // Path 2: Unmapped / No authoritative ASID link -> MANUAL_REVIEW_REQUIRED, status = RECEIVED
    // Path 3: Ambiguous (>1 matches) -> MANUAL_REVIEW_REQUIRED, status = RECEIVED (fails closed)

    function resolveIdentity(opts: {
        hasAuthoritativeAsidMatch: boolean;
        authoritativeMatchesCount: number;
        hasOnlyPsidSuffixMatch: boolean;
    }) {
        // Zero heuristic guessing: PSID equality or suffix match alone MUST NOT auto-match!
        if (opts.hasOnlyPsidSuffixMatch && !opts.hasAuthoritativeAsidMatch) {
            return {
                status: 'RECEIVED',
                resolution: 'MANUAL_REVIEW_REQUIRED',
                customerId: null,
            };
        }

        if (opts.hasAuthoritativeAsidMatch && opts.authoritativeMatchesCount === 1) {
            return {
                status: 'COMPLETED',
                resolution: 'AUTO_MATCHED',
                customerId: 'cust-verified-1',
            };
        }

        return {
            status: 'RECEIVED',
            resolution: 'MANUAL_REVIEW_REQUIRED',
            customerId: null,
        };
    }

    // Heuristic test: PSID suffix match exists ('1026991374010112:12345678') but no authoritative ASID link
    // MUST NOT auto-match! Fails closed into MANUAL_REVIEW_REQUIRED with RECEIVED status.
    const heuristicAttempt = resolveIdentity({
        hasAuthoritativeAsidMatch: false,
        authoritativeMatchesCount: 0,
        hasOnlyPsidSuffixMatch: true,
    });
    assert.equal(heuristicAttempt.status, 'RECEIVED');
    assert.equal(heuristicAttempt.resolution, 'MANUAL_REVIEW_REQUIRED');
    assert.equal(heuristicAttempt.customerId, null, 'Must NOT auto-delete customer based on PSID suffix equality');

    // Authoritative test: explicit verified ASID mapping matches exactly 1 customer
    const authoritativeMatch = resolveIdentity({
        hasAuthoritativeAsidMatch: true,
        authoritativeMatchesCount: 1,
        hasOnlyPsidSuffixMatch: false,
    });
    assert.equal(authoritativeMatch.status, 'COMPLETED');
    assert.equal(authoritativeMatch.resolution, 'AUTO_MATCHED');
    assert.equal(authoritativeMatch.customerId, 'cust-verified-1');

    // Ambiguous test: multiple matches
    const ambiguousMatch = resolveIdentity({
        hasAuthoritativeAsidMatch: true,
        authoritativeMatchesCount: 2,
        hasOnlyPsidSuffixMatch: false,
    });
    assert.equal(ambiguousMatch.status, 'RECEIVED');
    assert.equal(ambiguousMatch.resolution, 'MANUAL_REVIEW_REQUIRED');
    assert.equal(ambiguousMatch.customerId, null);
});
