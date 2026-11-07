import assert from 'node:assert/strict';
import test from 'node:test';

import { binding, bindingsForCompany, pageBindings } from '../../features/omnichannel/facebook/binding';
import { assertApprovedLeadAdsForm, isLeadAdsAdAccountAllowed, leadAdsPageBindings } from '../../features/omnichannel/facebook/lead-ads-binding';

const COMPANY = 'de6a7bf3-b5bc-418d-92d6-f9b241472598';
const OTHER_COMPANY = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const POLAND = '1418087751743574';
const GERMANY = '1026991374010112';
const AUSTRIA = '654520554683416';
const GERMAN_CENTER = '1014780055265237';

function withBindings(
    messenger: string | undefined,
    leadAds: string | undefined,
    run: () => void,
) {
    const oldMessenger = process.env.META_PAGE_BINDINGS;
    const oldLeadAds = process.env.META_ADS_PAGE_BINDINGS;
    if (messenger === undefined) delete process.env.META_PAGE_BINDINGS;
    else process.env.META_PAGE_BINDINGS = messenger;
    if (leadAds === undefined) delete process.env.META_ADS_PAGE_BINDINGS;
    else process.env.META_ADS_PAGE_BINDINGS = leadAds;
    try {
        run();
    } finally {
        if (oldMessenger === undefined) delete process.env.META_PAGE_BINDINGS;
        else process.env.META_PAGE_BINDINGS = oldMessenger;
        if (oldLeadAds === undefined) delete process.env.META_ADS_PAGE_BINDINGS;
        else process.env.META_ADS_PAGE_BINDINGS = oldLeadAds;
    }
}

test('META_ADS_PAGE_BINDINGS adds the four approved Pages without replacing Messenger bindings', () => {
    withBindings(
        JSON.stringify([{ page: '111111111111111', company: COMPANY, tokenEnv: 'META_PAGE_OLD_TOKEN', name: 'Existing Messenger Page' }]),
        JSON.stringify([
            { page: POLAND, company: COMPANY, tokenEnv: 'META_PAGE_POLAND_TOKEN', name: 'Ba Lan' },
            { page: GERMANY, company: COMPANY, tokenEnv: 'META_PAGE_GERMANY_TOKEN', name: 'Đức' },
            { page: AUSTRIA, company: COMPANY, tokenEnv: 'META_PAGE_AUSTRIA_TOKEN', name: 'Áo' },
            { page: GERMAN_CENTER, company: COMPANY, tokenEnv: 'META_PAGE_GERMAN_CENTER_TOKEN', name: 'Trung tâm Tiếng Đức' },
        ]),
        () => {
            const pages = new Map(leadAdsPageBindings().map(item => [item.page, item]));
            assert.equal(pages.size, 4);
            assert.equal(bindingsForCompany(COMPANY).length, 1);
            assert.equal(binding('111111111111111').tokenEnv, 'META_PAGE_OLD_TOKEN');
            assert.throws(() => binding(POLAND), /NOT_FOUND/);
            assert.equal(pages.get(POLAND)?.company, COMPANY);
            assert.equal(pages.get(POLAND)?.leadAdsEnabled, true);
            assert.equal(pages.get(POLAND)?.tokenEnv, 'META_PAGE_POLAND_TOKEN');
            assert.equal(pages.get(GERMANY)?.name, 'Đức');
            assert.equal(pages.get(AUSTRIA)?.name, 'Áo');
            assert.equal(pages.get(GERMAN_CENTER)?.name, 'Trung tâm Tiếng Đức');
        },
    );
});

test('duplicate Page bindings merge only when they retain the same tenant', () => {
    withBindings(
        JSON.stringify([{ page: POLAND, company: COMPANY, tokenEnv: 'META_PAGE_POLAND_TOKEN' }]),
        JSON.stringify([{ page: POLAND, company: COMPANY, tokenEnv: 'META_PAGE_POLAND_NEW_TOKEN', name: 'Ba Lan' }]),
        () => {
            const pages = leadAdsPageBindings();
            assert.equal(pageBindings().length, 1);
            assert.equal(pages.length, 1);
            assert.equal(pages[0].tokenEnv, 'META_PAGE_POLAND_TOKEN');
            assert.equal(pages[0].name, 'Ba Lan');
            assert.equal(pages[0].leadAdsEnabled, true);
        },
    );
});

test('a Page cannot be rebound to a different tenant through the additive configuration', () => {
    withBindings(
        JSON.stringify([{ page: POLAND, company: COMPANY, tokenEnv: 'META_PAGE_POLAND_TOKEN' }]),
        JSON.stringify([{ page: POLAND, company: OTHER_COMPANY, tokenEnv: 'META_PAGE_POLAND_OTHER_TOKEN' }]),
        () => assert.throws(() => leadAdsPageBindings()),
    );
});

test('malformed legacy token environment names fail closed even for a same-tenant Page', () => {
    withBindings(
        JSON.stringify([{ page: POLAND, company: COMPANY, tokenEnv: 'META_PAGE_POLAND_TOKEN' }]),
        JSON.stringify([{ page: POLAND, company: COMPANY, tokenEnv: 'META_PAGE_POLAND_TOKEN_NEW' }]),
        () => assert.throws(() => leadAdsPageBindings()),
    );
});

test('release tenant rejects extra Pages and Ad Accounts and requires six scoped Form IDs', () => {
    const row = { page: AUSTRIA, company: COMPANY, tokenEnv: 'META_PAGE_AUSTRIA_TOKEN', leadAdsEnabled: true } as const;
    withBindings(undefined, JSON.stringify([{ ...row, page: '999' }]), () => {
        assert.throws(() => leadAdsPageBindings(), /CHANNEL_NOT_CONFIGURED/);
    });
    withBindings(undefined, JSON.stringify([{ ...row, company: OTHER_COMPANY }]), () => {
        assert.throws(() => leadAdsPageBindings(), /CHANNEL_NOT_CONFIGURED/);
    });
    withBindings(undefined, JSON.stringify([{ ...row, page: '999', company: COMPANY.toUpperCase() }]), () => {
        assert.throws(() => leadAdsPageBindings(), /CHANNEL_NOT_CONFIGURED/);
    });
    assert.equal(isLeadAdsAdAccountAllowed(OTHER_COMPANY, 'act_996324396811261'), false);
    assert.equal(isLeadAdsAdAccountAllowed(COMPANY, 'act_996324396811261'), true);
    assert.equal(isLeadAdsAdAccountAllowed(COMPANY, 'act_999'), false);
    const saved = process.env.META_ADS_APPROVED_FORMS;
    try {
        delete process.env.META_ADS_APPROVED_FORMS;
        assert.throws(() => assertApprovedLeadAdsForm(row, '5'), /LEAD_ADS_FORMS_NOT_CONFIGURED/);
        // The Form IDs here are synthetic, never a Production inventory.
        process.env.META_ADS_APPROVED_FORMS = JSON.stringify({
            [POLAND]: ['1', '2'], [GERMANY]: ['3', '4'], [AUSTRIA]: ['5'], [GERMAN_CENTER]: ['6'],
        });
        assert.doesNotThrow(() => assertApprovedLeadAdsForm(row, '5'));
        assert.throws(() => assertApprovedLeadAdsForm(row, '6'), /FORM_NOT_ALLOWED/);
    } finally {
        if (saved === undefined) delete process.env.META_ADS_APPROVED_FORMS;
        else process.env.META_ADS_APPROVED_FORMS = saved;
    }
});
