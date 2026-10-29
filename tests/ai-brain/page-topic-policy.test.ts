import 'server-only';

import assert from 'node:assert';
import test from 'node:test';

import { builtInPagePlaybook } from '../../features/ai-brain/grounding/page-playbook';
import {
  CUA_CHONG_NGAP_PAGE_ID,
  DU_HOC_PAGE_ID,
  formatPageTopicPolicy,
  hasOutOfScopeTopic,
  pageTopicContext,
  sanitizePageScopedReply,
} from '../../features/ai-brain/page-topic-policy';

test('Page Topic Policy: study-abroad playbook never mentions flood barriers', () => {
  const playbook = builtInPagePlaybook('MESSENGER', DU_HOC_PAGE_ID);
  assert.ok(playbook);
  assert.equal(playbook.pageId, DU_HOC_PAGE_ID);
  assert.equal(playbook.title, 'Playbook tư vấn du học');
  assert.doesNotMatch(
    `${playbook.title}\n${playbook.content}`,
    /chống ngập|flood barrier|ngăn nước|thoát nước|hầm xe|gara/i,
  );
  assert.match(playbook.title, /du học/i);
  assert.match(playbook.content, /năm sinh/i);
  assert.match(playbook.content, /người đi học/i);
});

test('Page Topic Policy: flood page keeps its own playbook', () => {
  const playbook = builtInPagePlaybook('MESSENGER', CUA_CHONG_NGAP_PAGE_ID);
  assert.ok(playbook);
  assert.equal(playbook.pageId, CUA_CHONG_NGAP_PAGE_ID);
  assert.match(playbook.title, /Cửa chống ngập/i);
  assert.doesNotMatch(playbook.content, /du học|học tiếng/i);
});

test('Page Topic Policy: study-abroad Page rejects the leaked flood-barrier draft', () => {
  const context = pageTopicContext(DU_HOC_PAGE_ID);
  assert.equal(context.topic, 'DU_HOC');
  assert.equal(context.pageName, 'Du học Đức và Học tiếng Đức CHD');

  const leaked = 'Dạ em chào anh/chị, không rõ từ "lib" anh/chị đang muốn nhắc đến sản phẩm của chống ngập hay tài liệu nào ạ? Anh/chị có thể chia sẻ thêm để em hỗ trợ thông tin chính xác cho mình nhé.';
  assert.equal(hasOutOfScopeTopic(leaked, context), true);
  assert.equal(sanitizePageScopedReply(leaked, context), '');

  const valid = 'Dạ em tư vấn du học Đức và học tiếng Đức cho mình nhé.';
  assert.equal(hasOutOfScopeTopic(valid, context), false);
  assert.equal(sanitizePageScopedReply(valid, context), valid);

  const policy = formatPageTopicPolicy(context);
  assert.match(policy, /du học Đức và học tiếng Đức/i);
  assert.match(policy, /TUYỆT ĐỐI KHÔNG nhắc đến cửa chống ngập/i);
});

test('Page Topic Policy: flood Page allows flood-barrier drafts', () => {
  const context = pageTopicContext(CUA_CHONG_NGAP_PAGE_ID);
  assert.equal(context.topic, 'CUA_CHONG_NGAP');
  const draft = 'Dạ em tư vấn cửa chống ngập cho anh/chị ạ.';
  assert.equal(hasOutOfScopeTopic(draft, context), false);
  assert.equal(sanitizePageScopedReply(draft, context), draft);
});

test('Page Topic Policy: unknown Page stays generic and does not invent a scope', () => {
  const context = pageTopicContext('999999999999999');
  assert.equal(context.topic, 'GENERIC');
  assert.equal(context.pageId, '999999999999999');
  assert.match(formatPageTopicPolicy(context), /CHỈ tư vấn đúng sản phẩm\/dịch vụ thuộc lĩnh vực của trang này/i);
});
