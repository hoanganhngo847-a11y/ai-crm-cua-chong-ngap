import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADULT_BIRTH_YEAR_CUTOFF,
  analyzeCustomerMessaging,
  applyContactRequestPolicy,
  buildAiIdentityReply,
  buildMessengerFallbackReply,
  buildMessengerPhoneReceivedReply,
  containsNonHumanSelfIdentification,
  containsPhoneRequest,
  formatMessagingPolicy,
  messageContainsCustomerPhone,
  messageIsOnlyContactInfo,
  sanitizeAiIdentity,
  sanitizeCustomerFacingReply,
  stripPhoneRequest,
} from '../../features/ai-brain/messaging-style';

function inbound(content: string) {
  return { direction: 'INBOUND' as const, actorType: 'CUSTOMER', content };
}

function outbound(content: string) {
  return { direction: 'OUTBOUND' as const, actorType: 'AI', content };
}

test('Messaging Style: parent asking for a child uses em/anh-chị', () => {
  const profile = analyzeCustomerMessaging({
    recentMessages: [
      inbound('Tìn hiểu cho con'),
      outbound('Dạ em hỏi thêm năm sinh và nơi ở của bé ạ.'),
      inbound('Sinh năm 98, ở miền bắc'),
    ],
  });

  assert.equal(profile.persona, 'PARENT');
  assert.equal(profile.selfReference, 'em');
  assert.equal(profile.customerAddress, 'anh/chị');
  assert.equal(profile.birthYear, 1998);
  assert.equal(profile.locationKnown, true);
  assert.equal(profile.customerTurnCount, 2);
  assert.equal(profile.contactRequestAllowed, false);
});

test('Messaging Style: student asking for themselves uses ad/em', () => {
  const profile = analyzeCustomerMessaging({
    recentMessages: [
      inbound('Mình cần tư vấn cho bản thân ạ'),
      inbound('2k2, có bằng cử nhân'),
      inbound('Hà Nội'),
    ],
  });

  assert.equal(profile.persona, 'STUDENT');
  assert.equal(profile.selfReference, 'ad');
  assert.equal(profile.customerAddress, 'em');
  assert.equal(profile.birthYear, 2002);
  assert.equal(profile.contactRequestAllowed, true);
});

test('Messaging Style: adult asking for themselves uses em/anh-chị', () => {
  const profile = analyzeCustomerMessaging({
    recentMessages: [
      inbound('Mình cần tư vấn cho bản thân'),
      inbound('Sinh năm 1985'),
      inbound('Cần Thơ'),
    ],
  });

  assert.equal(profile.persona, 'ADULT');
  assert.equal(profile.selfReference, 'em');
  assert.equal(profile.customerAddress, 'anh/chị');
  assert.equal(profile.birthYear, 1985);
});

test('Messaging Style: birth-year cutoff is 2000 for self inquiries', () => {
  assert.equal(ADULT_BIRTH_YEAR_CUTOFF, 2000);

  const born2000 = analyzeCustomerMessaging({
    latestText: 'Mình sinh năm 2000, ở Hà Nội, tư vấn cho mình',
  });
  assert.equal(born2000.persona, 'ADULT');
  assert.equal(born2000.selfReference, 'em');

  const born2001 = analyzeCustomerMessaging({
    latestText: 'Mình sinh năm 2001, ở Hà Nội, tư vấn cho mình',
  });
  assert.equal(born2001.persona, 'STUDENT');
  assert.equal(born2001.selfReference, 'ad');
});

test('Messaging Style: unknown customer defaults to em/anh-chị and cannot be asked for a phone', () => {
  const profile = analyzeCustomerMessaging({ latestText: 'Tư vấn du học Đức' });

  assert.equal(profile.persona, 'UNKNOWN');
  assert.equal(profile.selfReference, 'em');
  assert.equal(profile.customerAddress, 'anh/chị');
  assert.equal(profile.contactRequestAllowed, false);
  assert.deepEqual(profile.missingDiscoveryFields, ['relationship', 'birthYear', 'location']);
});

test('Messaging Style: phone already provided disables further phone requests', () => {
  const profile = analyzeCustomerMessaging({
    recentMessages: [
      inbound('Mình cần tư vấn cho bản thân'),
      inbound('Sinh năm 1998'),
      inbound('Hà Nội'),
      inbound('Sđt 0912345678'),
    ],
  });

  assert.equal(profile.phoneProvided, true);
  assert.equal(profile.contactRequestAllowed, false);
});

test('Messaging Style: detects phone numbers and contact-only messages', () => {
  assert.equal(messageContainsCustomerPhone('[số điện thoại đã ẩn]'), true);
  assert.equal(messageContainsCustomerPhone('Sđt của mình là 0912345678 nhé'), true);
  assert.equal(messageContainsCustomerPhone('0988 123 456'), true);
  assert.equal(messageContainsCustomerPhone('Học phí bên mình bao nhiêu?'), false);

  assert.equal(messageIsOnlyContactInfo('Dạ sđt của em là [số điện thoại đã ẩn] ạ'), true);
  assert.equal(messageIsOnlyContactInfo('0912345678'), true);
  assert.equal(
    messageIsOnlyContactInfo('SĐT 0912345678, cho mình hỏi học phí bao nhiêu ạ?'),
    false,
  );
});

test('Messaging Style: strips a phone request while preserving an answer', () => {
  const answerWithRequest =
    'Điều kiện cơ bản là có bằng THPT và tiếng Đức B1. Anh/chị cho em xin sđt nhé.';
  assert.equal(containsPhoneRequest(answerWithRequest), true);
  assert.equal(
    stripPhoneRequest(answerWithRequest),
    'Điều kiện cơ bản là có bằng THPT và tiếng Đức B1.',
  );

  const fillerWithRequest =
    'Dạ, để em hỗ trợ tư vấn chi tiết về điều kiện, anh/chị cho em xin số điện thoại liên hệ nhé ạ!';
  assert.equal(stripPhoneRequest(fillerWithRequest), '');

  // A short but concrete answer survives even when the phone request is removed.
  assert.equal(
    stripPhoneRequest('Học phí 20 triệu. Anh/chị cho em xin sđt nhé.'),
    'Học phí 20 triệu.',
  );
});

test('Messaging Style: applies the contact policy to drafts', () => {
  const profile = analyzeCustomerMessaging({ latestText: 'Điều kiện du học Đức thế nào?' });

  assert.equal(
    applyContactRequestPolicy(
      'Điều kiện cơ bản là có bằng THPT và tiếng Đức B1. Anh/chị cho em xin sđt nhé.',
      profile,
    ),
    'Điều kiện cơ bản là có bằng THPT và tiếng Đức B1.',
  );

  assert.equal(
    applyContactRequestPolicy(
      'Dạ, để em hỗ trợ tư vấn chi tiết về điều kiện, anh/chị cho em xin số điện thoại liên hệ nhé ạ!',
      profile,
    ),
    buildMessengerFallbackReply(profile),
  );
});

test('Messaging Style: customer-facing gate strips reasoning from an AI draft', () => {
  const raw = `Dựa trên yêu cầu của khách hàng Lan Pham và quy tắc tư vấn từ playbook, tôi xin đưa ra quyết định xử lý như sau.

- Khách hàng mới gửi yêu cầu tư vấn chung chung.
- Theo quy định, yêu cầu tư vấn chung không phải là chuyển giao cho người thật ngay.

Bạn có thể gửi phản hồi mẫu cho khách hàng:
Dạ em chào anh/chị, em hỗ trợ tư vấn cho mình nhé. Anh/chị cho em xin số điện thoại liên hệ để chuyên viên bên em hỗ trợ chi tiết hơn cho mình ạ.`;

  const profile = analyzeCustomerMessaging({ latestText: 'Tư vấn du học Đức giúp mình' });
  assert.equal(
    sanitizeCustomerFacingReply(raw, profile),
    'Dạ em chào anh/chị, em hỗ trợ tư vấn cho mình nhé.',
  );

  // A draft that is pure internal reasoning is blocked entirely.
  assert.equal(
    sanitizeCustomerFacingReply(
      'Theo playbook, tôi xin đưa ra quyết định xử lý như sau: khách hàng mới gửi yêu cầu tư vấn chung.',
    ),
    '',
  );
});

test('Messaging Style: builds persona-aware fallbacks', () => {
  const student = analyzeCustomerMessaging({
    latestText: 'Em là sinh viên, tư vấn cho em ạ',
  });
  assert.match(buildMessengerFallbackReply(student), /^Dạ ad/);
  assert.match(buildMessengerPhoneReceivedReply(student), /^Dạ ad/);

  const parent = analyzeCustomerMessaging({ latestText: 'Tìm hiểu cho con' });
  assert.match(buildMessengerFallbackReply(parent), /^Dạ em/);
  assert.match(buildMessengerPhoneReceivedReply(parent), /^Dạ em/);
});

test('Messaging Style: formats the prompt policy block', () => {
  const profile = analyzeCustomerMessaging({ latestText: 'Tìm hiểu cho con' });
  const block = formatMessagingPolicy(profile);

  assert.match(block, /\[CUSTOMER PERSONA & CONTACT POLICY\]/);
  assert.match(block, /PHỤ HUYNH HỎI CHO CON\/CHÁU/);
  assert.match(block, /bạn xưng "em", gọi khách "anh\/chị"/);
  assert.match(block, /Được phép xin số điện thoại ở lượt này: KHÔNG/);
  assert.match(block, /sale trực page của công ty/);
  assert.match(block, /không nhận mình là trợ lý, trợ lý AI, trợ lý tư vấn hệ thống, robot, bot, chatbot, AI/);
});

test('Messaging Style: identity questions always get the human Page salesperson answer', () => {
  const profile = analyzeCustomerMessaging({
    latestText: 'Tôi muốn biết bạn là ai? Vì tôi không trò chuyện với robot???',
  });

  assert.equal(profile.identityQuestion, true);
  assert.equal(buildAiIdentityReply(profile), 'Dạ, em là sale trực page của công ty ạ.');
  assert.equal(
    sanitizeCustomerFacingReply(
      'Dạ, em là trợ lý tư vấn của hệ thống ạ. Anh/chị cần tư vấn gì ạ?',
      profile,
    ),
    buildAiIdentityReply(profile),
  );

  // An answer that already uses the allowed identity is preserved.
  const good = 'Dạ, em là sale trực page của công ty ạ. Anh/chị đang quan tâm du học Đức đúng không ạ?';
  assert.equal(sanitizeCustomerFacingReply(good, profile), good);

  // Identity is turn-scoped: a later product question is not forced back to it.
  const later = analyzeCustomerMessaging({ latestText: 'Học phí du học Đức bao nhiêu ạ?' });
  assert.equal(later.identityQuestion, false);

  // Non-Page channels use a human company-staff identity instead of the Page
  // salesperson wording.
  assert.equal(
    buildAiIdentityReply(profile, 'COMPANY_STAFF'),
    'Dạ, em là nhân viên tư vấn của công ty ạ.',
  );
  assert.equal(
    sanitizeAiIdentity('Dạ em là chatbot ạ.', profile, 'COMPANY_STAFF'),
    'Dạ, em là nhân viên tư vấn của công ty ạ.',
  );
});

test('Messaging Style: strips non-human self-identification from a normal draft', () => {
  const profile = analyzeCustomerMessaging({ latestText: 'Điều kiện du học Đức thế nào?' });

  assert.equal(containsNonHumanSelfIdentification('Dạ em là trợ lý AI của hệ thống ạ.'), true);
  assert.equal(containsNonHumanSelfIdentification('Dạ em là sale trực page của công ty ạ.'), false);
  assert.equal(containsNonHumanSelfIdentification('Dạ em không phải robot ạ, em là sale trực page.'), false);

  assert.equal(
    sanitizeCustomerFacingReply(
      'Dạ em là trợ lý AI của hệ thống ạ. Điều kiện cơ bản là có bằng THPT và tiếng Đức B1.',
      profile,
    ),
    'Điều kiện cơ bản là có bằng THPT và tiếng Đức B1.',
  );
  assert.equal(
    sanitizeCustomerFacingReply('Dạ em là trợ lý AI của hệ thống ạ.', profile),
    buildAiIdentityReply(profile),
  );
  assert.equal(
    sanitizeAiIdentity('Dạ em là chatbot tư vấn ạ.', profile),
    buildAiIdentityReply(profile),
  );
  assert.equal(
    sanitizeAiIdentity('Dạ em là trợ lý AI ạ.Điều kiện là có bằng THPT.', profile),
    'Điều kiện là có bằng THPT.',
  );
});
