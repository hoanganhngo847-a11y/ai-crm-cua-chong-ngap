import assert from 'node:assert/strict';
import test from 'node:test';

import { binding, bindingsForCompany, pageBindings } from '../../features/omnichannel/facebook/binding';

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
            { page: POLAND, company: COMPANY, name: 'Ba Lan' },
            { page: GERMANY, company: COMPANY, name: 'Đức' },
            { page: AUSTRIA, company: COMPANY, name: 'Áo' },
            { page: GERMAN_CENTER, company: COMPANY, name: 'Trung tâm Tiếng Đức' },
        ]),
        () => {
            const pages = pageBindings();
            assert.equal(pages.length, 5);
            assert.equal(bindingsForCompany(COMPANY).length, 5);
            assert.equal(binding('111111111111111').tokenEnv, 'META_PAGE_OLD_TOKEN');
            assert.equal(binding('111111111111111').leadAdsOnly, false);
            assert.equal(binding(POLAND).company, COMPANY);
            assert.equal(binding(POLAND).leadAdsOnly, true);
            assert.equal(binding(POLAND).tokenEnv, undefined);
            assert.equal(binding(GERMANY).name, 'Đức');
            assert.equal(binding(AUSTRIA).name, 'Áo');
            assert.equal(binding(GERMAN_CENTER).name, 'Trung tâm Tiếng Đức');
        },
    );
});

test('duplicate Page bindings merge only when they retain the same tenant', () => {
    withBindings(
        JSON.stringify([{ page: POLAND, company: COMPANY, tokenEnv: 'META_PAGE_POLAND_TOKEN' }]),
        JSON.stringify([{ page: POLAND, company: COMPANY, name: 'Ba Lan' }]),
        () => {
            const pages = pageBindings();
            assert.equal(pages.length, 1);
            assert.equal(pages[0].tokenEnv, 'META_PAGE_POLAND_TOKEN');
            assert.equal(pages[0].name, 'Ba Lan');
            assert.equal(pages[0].leadAdsOnly, false);
        },
    );
});

test('a Page cannot be rebound to a different tenant through the additive configuration', () => {
    withBindings(
        JSON.stringify([{ page: POLAND, company: COMPANY }]),
        JSON.stringify([{ page: POLAND, company: OTHER_COMPANY }]),
        () => assert.throws(() => pageBindings()),
    );
});
