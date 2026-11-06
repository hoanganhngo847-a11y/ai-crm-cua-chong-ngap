import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { Customer360EditableCellProps } from '../../features/customer-360/editable-cell';

type Input = { customerId: string; field: string; value: string | null };
type Result = { ok: boolean; value?: string | null; message?: string };
let save: (input: Input) => Promise<Result>;
let Cell: typeof import('../../features/customer-360/editable-cell').Customer360EditableCell;
let root: Root;
let host: HTMLDivElement;
let calls: Input[];
const initial: Customer360EditableCellProps = {
  customerId: 'synthetic-customer-a', field: 'assigned_sale_name', value: 'Original sale',
};

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true },
    document: { value: dom.window.document, configurable: true },
    navigator: { value: dom.window.navigator, configurable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
  });
  // Load the actual component with only its server action replaced. This avoids
  // importing server-only modules or giving a UI fixture access to a database.
  const filename = path.resolve('features/customer-360/editable-cell.tsx');
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const require = createRequire(filename);
  const componentModule = { exports: {} as { Customer360EditableCell: typeof Cell } };
  const load = runInThisContext(`(function(require, module, exports) { ${source}\n})`, { filename });
  load((name: string) => name === '../../app/actions/customer-dossier'
    ? { updateCustomerDossierField: (input: Input) => { calls.push(input); return save(input); } }
    : require(name), componentModule, componentModule.exports);
  Cell = componentModule.exports.Customer360EditableCell;
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});

async function mount(props = initial) {
  calls = [];
  save = async input => ({ ok: true, value: input.value });
  host = document.createElement('div');
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
  await render(props);
}
async function render(props: Customer360EditableCellProps) {
  await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Cell, props))));
}
async function click(element: Element | null) {
  assert.ok(element);
  await act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}
async function edit() {
  await click(host.querySelector('[title="Nhấn để chỉnh sửa"]'));
}
function input() {
  const element = host.querySelector('input,textarea') as HTMLInputElement | HTMLTextAreaElement | null;
  assert.ok(element);
  return element;
}
async function change(value: string) {
  const element = input();
  const prototype = element.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
async function key(key: string, options: KeyboardEventInit = {}) {
  await act(async () => input().dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })));
}
function deferred() {
  let resolve!: (result: Result) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Result>((yes, no) => { resolve = yes; reject = no; });
  save = () => promise;
  return { resolve, reject };
}

test('input Enter saves once, trims, shows loading and uses the returned canonical value', async () => {
  await mount({ ...initial, ownerSuggestions: ['Original sale', 'New sale'] });
  await edit();
  assert.equal(document.activeElement, input());
  assert.equal((input() as HTMLInputElement).selectionEnd, 'Original sale'.length);
  assert.equal(host.querySelectorAll('datalist option').length, 2);
  await change('  New sale  ');
  const pending = deferred();
  await key('Enter');
  assert.deepEqual(calls, [{ customerId: initial.customerId, field: initial.field, value: 'New sale' }]);
  assert.equal(input().disabled, true);
  assert.equal(host.querySelector<HTMLButtonElement>('[title="Lưu (Enter)"]')?.disabled, true);
  await key('Enter');
  await key('Escape');
  assert.equal(calls.length, 1);
  assert.ok(host.querySelector('input'));
  await act(async () => pending.resolve({ ok: true, value: 'Canonical sale' }));
  assert.equal(host.querySelector('input'), null);
  assert.match(host.textContent!, /Canonical sale/);
  await edit();
  assert.equal(input().value, 'Canonical sale');
});

test('Escape and cancel restore the original; blur keeps the unsaved draft without submitting', async () => {
  await mount();
  await edit();
  await change('Unsaved');
  await act(async () => input().dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })));
  assert.equal(input().value, 'Unsaved');
  assert.equal(calls.length, 0);
  await key('Escape');
  assert.match(host.textContent!, /Original sale/);
  await edit();
  assert.equal(input().value, 'Original sale');
  await change('Another draft');
  await click(host.querySelector('[title="Hủy (Esc)"]'));
  await edit();
  assert.equal(input().value, 'Original sale');
  assert.equal(calls.length, 0);
});

for (const modifier of ['ctrlKey', 'metaKey'] as const) {
  test(`textarea Enter keeps multiline editing; ${modifier}+Enter saves`, async () => {
    await mount({ ...initial, field: 'sale_notes', value: 'Original note' });
    await edit();
    assert.equal(input().tagName, 'TEXTAREA');
    await change('Line one\nLine two');
    await key('Enter');
    assert.equal(calls.length, 0);
    await key('Enter', { [modifier]: true });
    assert.equal(calls[0].value, 'Line one\nLine two');
    assert.equal(host.querySelector('textarea'), null);
  });
}

test('null/undefined remain controlled strings and clearing saves null', async () => {
  await mount({ ...initial, value: undefined });
  await edit();
  assert.equal(input().value, '');
  await change('   ');
  await click(host.querySelector('[title="Lưu (Enter)"]'));
  assert.equal(calls[0].value, null);
  await render({ ...initial, value: null });
  await edit();
  assert.equal(input().value, '');
});

for (const failure of ['server', 'network'] as const) {
  test(`${failure} failure retains draft, permits retry and clears on cancel`, async () => {
    await mount();
    await edit();
    await change('Retry draft');
    save = async () => {
      if (failure === 'network') throw new Error('synthetic network failure');
      return { ok: false, message: 'Synthetic validation error' };
    };
    await key('Enter');
    assert.equal(input().value, 'Retry draft');
    assert.equal(input().disabled, false);
    assert.match(host.textContent!, failure === 'server' ? /Synthetic validation error/ : /Lỗi mạng/);
    save = async input => ({ ok: true, value: input.value });
    await key('Enter');
    assert.match(host.textContent!, /Retry draft/);
    await edit();
    await key('Escape');
    assert.doesNotMatch(host.textContent!, /Synthetic validation error|Lỗi mạng/);
  });
}

test('new server props replace an unsaved edit and become the cancel/reopen baseline', async () => {
  await mount();
  await edit();
  await change('Stale draft');
  await render({ ...initial, value: 'New server value' });
  assert.equal(host.querySelector('input'), null);
  assert.match(host.textContent!, /New server value/);
  await edit();
  assert.equal(input().value, 'New server value');
  await change('Cancelled');
  await key('Escape');
  assert.match(host.textContent!, /New server value/);
});

for (const result of ['success', 'error', 'network'] as const) {
  test(`late ${result} cannot overwrite newer server props`, async () => {
    await mount();
    await edit();
    await change('Old save');
    const pending = deferred();
    await key('Enter');
    await render({ ...initial, value: 'Newer server value' });
    await act(async () => result === 'network'
      ? pending.reject(new Error('late synthetic error'))
      : pending.resolve(result === 'success' ? { ok: true, value: 'Old save' } : { ok: false, message: 'Old error' }));
    assert.match(host.textContent!, /Newer server value/);
    assert.doesNotMatch(host.textContent!, /Old save|Old error|Lỗi mạng/);
    await edit();
    assert.equal(input().value, 'Newer server value');
  });
}

for (const changed of [{ customerId: 'synthetic-customer-b' }, { field: 'marketing_notes' as const }]) {
  test(`switching ${Object.keys(changed)[0]} with the same value resets draft/pending/errors`, async () => {
    await mount();
    await edit();
    await change('Old record draft');
    const pending = deferred();
    await key('Enter');
    await render({ ...initial, ...changed });
    assert.equal(host.querySelector('input,textarea'), null);
    await edit();
    assert.equal(input().value, initial.value);
    await act(async () => pending.resolve({ ok: true, value: 'Old record result' }));
    assert.equal(input().value, initial.value);
    assert.equal(input().disabled, false);
  });
}

test('saving/cancelling does not trigger the enclosing table-row click', async () => {
  await mount();
  let rowClicks = 0;
  const countRowClick = () => rowClicks++;
  document.body.addEventListener('click', countRowClick);
  await edit();
  await change('New sale');
  await click(host.querySelector('[title="Lưu (Enter)"]'));
  await edit();
  await click(host.querySelector('[title="Hủy (Esc)"]'));
  document.body.removeEventListener('click', countRowClick);
  assert.equal(rowClicks, 0);
});
