import 'server-only';

/**
 * Shared messaging-style policy for Facebook Page / Messenger sales turns.
 *
 * The LLM receives the derived profile as a prompt block, and the live-delivery
 * engine uses the same profile for deterministic fallbacks and a final phone
 * request guard. Keeping one implementation avoids the prompt and the fallback
 * disagreeing about pronouns or contact-request timing.
 */

export type CustomerPersona = 'PARENT' | 'STUDENT' | 'ADULT' | 'UNKNOWN';
export type AiSelfReference = 'em' | 'ad';
export type CustomerAddress = 'anh/chị' | 'em';
export type DiscoveryField = 'relationship' | 'birthYear' | 'location';

export interface MessagingHistoryItem {
  readonly direction: 'INBOUND' | 'OUTBOUND';
  readonly actorType?: string;
  readonly content: string;
}

export interface CustomerMessagingInput {
  readonly latestText?: string | null;
  readonly recentMessages?: readonly MessagingHistoryItem[] | null;
}

export interface CustomerMessagingProfile {
  readonly persona: CustomerPersona;
  readonly selfReference: AiSelfReference;
  readonly customerAddress: CustomerAddress;
  readonly asksForChild: boolean;
  readonly asksForSelf: boolean;
  readonly isStudent: boolean;
  readonly birthYear: number | null;
  readonly locationKnown: boolean;
  readonly phoneProvided: boolean;
  readonly customerTurnCount: number;
  readonly contactRequestAllowed: boolean;
  readonly customerRequestedContact: boolean;
  readonly missingDiscoveryFields: readonly DiscoveryField[];
}

/**
 * The customer's birth-year cutoff for the adult/self address form.
 *
 * The business rule is "born in 2000 or earlier -> anh/chị". A literal 1900
 * cutoff would make the rule almost unreachable and would address adults born
 * in the 1980s as students, so 2000 is the practical interpretation.
 */
export const ADULT_BIRTH_YEAR_CUTOFF = 2000;

/** A phone number is requested only after this many inbound customer turns. */
export const MIN_CUSTOMER_TURNS_BEFORE_PHONE_REQUEST = 3;

export const MESSENGER_FALLBACK_REPLY =
  'Dạ em đã ghi nhận câu hỏi của anh/chị. Em đang kiểm tra thông tin để tư vấn chính xác hơn; anh/chị cho em biết thêm mình đang quan tâm nội dung nào cụ thể nhé ạ.';

export const MESSENGER_PHONE_RECEIVED_REPLY =
  'Dạ em đã nhận số điện thoại của anh/chị. Anh/chị nhớ mở chặn người lạ ở Zalo và để ý điện thoại giúp em ạ.';

const STUDENT_FALLBACK_REPLY =
  'Dạ ad đã ghi nhận câu hỏi của em. Ad đang kiểm tra thông tin để tư vấn chính xác hơn; em cho ad biết thêm mình đang quan tâm nội dung nào cụ thể nhé ạ.';

const STUDENT_PHONE_RECEIVED_REPLY =
  'Dạ ad đã nhận số điện thoại của em. Em nhớ mở chặn người lạ ở Zalo và để ý điện thoại giúp ad ạ.';

const VN_PHONE_REGEX =
  /(?:(?:\+|00)84|0)\s*(?:3[2-9]|5[25689]|7[06789]|8[1-9]|9[0-46-9])(?:[\s()./_,:\-]*\d){7}\b/;

const PHONE_TAG_REGEX =
  /\[(?:số\s*điện\s*thoại\s*đã\s*ẩn|phone\s*number\s*hidden)\]|số\s*điện\s*thoại\s*đã\s*ẩn|đã\s*ghi\s*nhận\s*một\s*số\s*hợp\s*lệ/iu;

export function messageContainsCustomerPhone(text: string): boolean {
  if (!text || typeof text !== 'string') return false;

  // 1. CRM phone intake redaction tag or status
  if (PHONE_TAG_REGEX.test(text)) return true;

  // 2. Vietnamese mobile or landline number
  if (VN_PHONE_REGEX.test(text)) return true;

  // 3. Phone intent with digits (e.g. "sđt: 091...", "zalo 09...")
  return /(?:sđt|sdt|số\s*(?:điện\s*thoại|dt)|phone|zalo)[\s:]*(?:(?:\+|00)84|0)?\s*[1-9](?:[\s()./_,:\-]*\d){7,9}\b/iu.test(text);
}

/**
 * True when a message only supplies contact information. Such a message can
 * use the instant acknowledgement path. A message that also asks a question
 * must go through the model so the question is answered first.
 */
export function messageIsOnlyContactInfo(text: string): boolean {
  if (!messageContainsCustomerPhone(text)) return false;
  const remainder = text
    .replace(VN_PHONE_REGEX, ' ')
    .replace(PHONE_TAG_REGEX, ' ')
    .replace(
      /(?<!\p{L})(?:sđt|sdt|số|điện|thoại|phone|zalo|liên|hệ|gọi|là|của|em|mình|tôi|anh|chị|dạ|vâng|ạ|nhé|nha|cho|gửi|giúp|với)(?!\p{L})/giu,
      ' ',
    )
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return remainder.length < 6;
}

const PARENT_PATTERNS: readonly RegExp[] = [
  /(?:cho|về|tìm\s*hiểu\s*cho|cần\s*tư\s*vấn\s*cho)\s+(?:con|con\s*trai|con\s*gái|cháu|bé|em\s*bé)(?!\p{L})/iu,
  /(?<!\p{L})(?:con|cháu|bé)\s+(?:tôi|mình|em|nhà|của\s+(?:tôi|mình|em|anh|chị))(?!\p{L})/iu,
  /(?<!\p{L})(?:phụ\s*huynh|bố|mẹ|ba|má)\s+(?:của\s+)?(?:cháu|bé|con)(?!\p{L})/iu,
  /(?<!\p{L})(?:con|cháu|bé)\s+(?:đang|học|sinh|sn)(?!\p{L})/iu,
];

const SELF_PATTERNS: readonly RegExp[] = [
  /(?:cho|về)\s+(?:bản\s*thân|chính\s*mình|mình|tôi|em)(?!\p{L})/iu,
  /(?<!\p{L})(?:bản\s*thân|chính\s*mình)(?!\p{L})/iu,
  /(?<!\p{L})(?:mình|tôi|em)\s+(?:cần|muốn|đang|hỏi|tìm\s*hiểu|định|sinh|sn|ở)(?!\p{L})/iu,
  /(?:tư\s*vấn|hỏi)\s+(?:cho\s+)?(?:mình|tôi|em)(?!\p{L})/iu,
];

const STUDENT_PATTERNS: readonly RegExp[] = [
  /(?<!\p{L})(?:học\s*sinh|sinh\s*viên|du\s*học\s*sinh|sv|hs)(?!\p{L})/iu,
  /(?<!\p{L})(?:đang\s+)?học\s+(?:lớp\s+)?(?:1[0-2]|[6-9])(?!\p{L})/iu,
  /(?<!\p{L})(?:năm\s+(?:nhất|hai|ba|tư)|thpt|thcs)(?!\p{L})/iu,
];

const LOCATION_HINTS: readonly RegExp[] = [
  /(?<!\p{L})(?:hà\s*nội|ha\s*noi|hồ\s*chí\s*minh|ho\s*chi\s*minh|tp\.?\s*hcm|sài\s*gòn|sai\s*gon|đà\s*nẵng|da\s*nang|hải\s*phòng|hai\s*phong|cần\s*thơ|can\s*tho|huế|nghệ\s*an|thanh\s*hóa|quảng\s*ninh|bắc\s*ninh|hải\s*dương|nam\s*định|thái\s*nguyên|vĩnh\s*phúc|đồng\s*nai|bình\s*dương|quảng\s*nam|khánh\s*hòa|lâm\s*đồng|đắk\s*lắk|gia\s*lai|an\s*giang|kiên\s*giang|đồng\s*tháp|vũng\s*tàu|bà\s*rịa)(?!\p{L})/iu,
  /(?<!\p{L})miền\s+(?:bắc|trung|nam)(?!\p{L})/iu,
];

const LOCATION_PREFIX =
  /(?<!\p{L})(?:ở|tại|sống\s+(?:ở|tại)|quê\s+(?:ở|tại)|đang\s+(?:ở|sống|sinh\s*sống))\s+([\p{L}\s]{2,40})/iu;

const CONTACT_REQUEST_PATTERNS: readonly RegExp[] = [
  /(?<!\p{L})(?:gọi\s*lại|liên\s*hệ\s*lại|gọi\s*cho|nhờ\s*(?:anh|chị|em|mình)\s*gọi)(?!\p{L})/iu,
  /(?<!\p{L})(?:cho|gửi)\s+(?:mình|tôi|em)\s+(?:số|sđt|sdt|zalo)(?!\p{L})/iu,
];

const PHONE_REQUEST_PATTERNS: readonly RegExp[] = [
  /(?:(?<!\p{L})(?:anh\/chị|anh\s*chị|em|mình|bạn)\s+)?(?<!\p{L})(?:cho|gửi|cung\s*cấp|để\s*lại)\s+(?:em|ad|mình|bên\s*em)?\s*(?:xin\s+)?(?:số\s*(?:điện\s*thoại|dt)|sđt|sdt|zalo|email)(?:\s*liên\s*hệ)?[^.!?\n]*[.!?]?/giu,
  /(?<!\p{L})(?:xin|cho)\s+(?:em|ad)?\s*(?:số\s*(?:điện\s*thoại|dt)|sđt|sdt)(?:\s*liên\s*hệ)?[^.!?\n]*[.!?]?/giu,
  /(?<!\p{L})(?:số\s*(?:điện\s*thoại|dt)|sđt|sdt)\s+(?:liên\s*hệ|của\s+(?:anh|chị|em|mình|bạn))[^.!?\n]*[.!?]?/giu,
];

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isCustomerInbound(item: MessagingHistoryItem): boolean {
  return item.direction === 'INBOUND' && item.actorType !== 'AI' && Boolean(item.content?.trim());
}

function customerTexts(input: CustomerMessagingInput): string[] {
  const texts = (input.recentMessages ?? [])
    .filter(isCustomerInbound)
    .map((item) => item.content.trim());
  const latest = input.latestText?.trim();
  if (latest && texts[texts.length - 1] !== latest) texts.push(latest);
  return texts;
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function expandTwoDigitYear(year: number): number {
  return year <= 26 ? 2000 + year : 1900 + year;
}

function plausibleBirthYear(year: number): boolean {
  return year >= 1930 && year <= new Date().getFullYear();
}

function birthYearCandidates(text: string): number[] {
  const candidates: number[] = [];

  // Explicit birth context accepts any plausible four-digit year.
  const explicitFull = text.match(
    /(?:sinh\s*(?:năm|ngày)?|sn|năm\s*sinh|born|date\s*of\s*birth|dob)\D{0,12}((?:19|20)\d{2})(?!\d)/iu,
  );
  if (explicitFull) {
    const year = Number(explicitFull[1]);
    if (plausibleBirthYear(year)) candidates.push(year);
  }

  // Two-digit year in birth context: 98 -> 1998, 02 -> 2002.
  const explicitShort = text.match(
    /(?:sinh\s*(?:năm|ngày)?|sn|năm\s*sinh|born|date\s*of\s*birth|dob)\D{0,12}(\d{2})(?!\d)/iu,
  );
  if (explicitShort) {
    const year = expandTwoDigitYear(Number(explicitShort[1]));
    if (plausibleBirthYear(year)) candidates.push(year);
  }

  // "2k2", "2k", "2k07".
  const twoK = text.match(/(?<!\p{L})2k(\d{1,2})?(?!\p{L})/iu);
  if (twoK) {
    const year = twoK[1] ? 2000 + Number(twoK[1]) : 2000;
    if (plausibleBirthYear(year)) candidates.push(year);
  }

  // A four-digit year with no explicit label is accepted only in a plausible
  // learner-age range (e.g. "Sinh viên 2007 Hà Nội"), never a future study year.
  if (candidates.length === 0) {
    const bareYears = [...text.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/gu)];
    for (const match of bareYears) {
      const year = Number(match[1]);
      if (year >= 1950 && year <= 2010) candidates.push(year);
    }
  }

  // A short standalone reply such as "98" after the birth-year question.
  if (candidates.length === 0 && text.trim().length <= 12 && !messageContainsCustomerPhone(text)) {
    const standalone = text.trim().match(/^(\d{2})$/u);
    if (standalone) {
      const year = expandTwoDigitYear(Number(standalone[1]));
      if (plausibleBirthYear(year)) candidates.push(year);
    }
  }

  return candidates;
}

function extractBirthYear(texts: readonly string[]): number | null {
  let year: number | null = null;
  for (const text of texts) {
    const candidates = birthYearCandidates(text);
    if (candidates.length > 0) year = candidates[candidates.length - 1];
  }
  return year;
}

function detectLocation(texts: readonly string[]): boolean {
  return texts.some((text) => {
    if (matchesAny(text, LOCATION_HINTS)) return true;
    const prefix = text.match(LOCATION_PREFIX);
    if (!prefix) return false;
    return !/^(?:đâu|nào|đây|chưa|vậy|ạ|nhỉ|gì)/iu.test(prefix[1].trim());
  });
}

function pronounsFor(persona: CustomerPersona): {
  selfReference: AiSelfReference;
  customerAddress: CustomerAddress;
} {
  if (persona === 'STUDENT') return { selfReference: 'ad', customerAddress: 'em' };
  return { selfReference: 'em', customerAddress: 'anh/chị' };
}

export function analyzeCustomerMessaging(input: CustomerMessagingInput = {}): CustomerMessagingProfile {
  const texts = customerTexts(input);
  const allText = normalized(texts.join('\n'));

  const asksForChild = matchesAny(allText, PARENT_PATTERNS);
  const asksForSelf = matchesAny(allText, SELF_PATTERNS);
  const isStudent = matchesAny(allText, STUDENT_PATTERNS);
  const birthYear = extractBirthYear(texts);
  const locationKnown = detectLocation(texts);
  const phoneProvided = texts.some((text) => messageContainsCustomerPhone(text));
  const customerRequestedContact = matchesAny(allText, CONTACT_REQUEST_PATTERNS);
  const customerTurnCount = texts.length;

  let persona: CustomerPersona = 'UNKNOWN';
  if (asksForChild) {
    persona = 'PARENT';
  } else if (isStudent) {
    persona = 'STUDENT';
  } else if (asksForSelf && birthYear !== null) {
    persona = birthYear <= ADULT_BIRTH_YEAR_CUTOFF ? 'ADULT' : 'STUDENT';
  }

  const relationshipKnown = asksForChild || asksForSelf;
  const missingDiscoveryFields: DiscoveryField[] = [];
  if (!relationshipKnown) missingDiscoveryFields.push('relationship');
  if (birthYear === null) missingDiscoveryFields.push('birthYear');
  if (!locationKnown) missingDiscoveryFields.push('location');

  const contactRequestAllowed = !phoneProvided
    && (customerRequestedContact
      || (missingDiscoveryFields.length === 0
        && customerTurnCount >= MIN_CUSTOMER_TURNS_BEFORE_PHONE_REQUEST));

  return Object.freeze({
    persona,
    ...pronounsFor(persona),
    asksForChild,
    asksForSelf,
    isStudent,
    birthYear,
    locationKnown,
    phoneProvided,
    customerTurnCount,
    contactRequestAllowed,
    customerRequestedContact,
    missingDiscoveryFields: Object.freeze(missingDiscoveryFields),
  });
}

function personaLabel(profile: CustomerMessagingProfile): string {
  switch (profile.persona) {
    case 'PARENT':
      return 'PHỤ HUYNH HỎI CHO CON/CHÁU';
    case 'STUDENT':
      return 'HỌC SINH/SINH VIÊN HỎI CHO BẢN THÂN';
    case 'ADULT':
      return `KHÁCH HỎI CHO BẢN THÂN (SINH NĂM ${profile.birthYear ?? ADULT_BIRTH_YEAR_CUTOFF} HOẶC TRƯỚC ĐÓ)`;
    default:
      return 'CHƯA XÁC ĐỊNH';
  }
}

function discoveryLabel(field: DiscoveryField): string {
  switch (field) {
    case 'relationship':
      return 'quan hệ người cần tư vấn (bản thân/con/cháu)';
    case 'birthYear':
      return 'năm sinh của người đi học';
    case 'location':
      return 'nơi ở hiện tại';
  }
}

export function formatMessagingPolicy(profile: CustomerMessagingProfile): string {
  const known: string[] = [];
  if (profile.asksForChild) known.push('khách hỏi cho con/cháu');
  else if (profile.asksForSelf) known.push('khách hỏi cho bản thân');
  if (profile.birthYear !== null) known.push(`năm sinh ${profile.birthYear}`);
  if (profile.locationKnown) known.push('đã có nơi ở');
  if (profile.phoneProvided) known.push('đã có số điện thoại');

  const missing = profile.missingDiscoveryFields.map(discoveryLabel);
  const phonePermission = profile.contactRequestAllowed ? 'CÓ' : 'KHÔNG';

  return [
    '[CUSTOMER PERSONA & CONTACT POLICY]',
    `- Persona: ${personaLabel(profile)}`,
    `- Xưng hô bắt buộc: AI xưng "${profile.selfReference}", gọi khách "${profile.customerAddress}".`,
    `- Thông tin đã biết: ${known.length > 0 ? known.join('; ') : 'chưa có'}.`,
    `- Thông tin còn thiếu: ${missing.length > 0 ? missing.join('; ') : 'không còn'}.`,
    `- Số điện thoại: ${profile.phoneProvided ? 'khách đã cung cấp' : 'chưa có'}.`,
    `- Được phép xin số điện thoại ở lượt này: ${phonePermission}.`,
    '- Quy tắc trả lời: trả lời trực tiếp câu hỏi của khách trước bằng 1-2 câu; chỉ hỏi tối đa 1 thông tin còn thiếu; không hỏi số điện thoại khi mục "Được phép" là KHÔNG; không hỏi số điện thoại cùng lúc với thông tin khác.',
  ].join('\n');
}

export function buildMessengerFallbackReply(
  profile?: Pick<CustomerMessagingProfile, 'selfReference'> | null,
): string {
  return profile?.selfReference === 'ad' ? STUDENT_FALLBACK_REPLY : MESSENGER_FALLBACK_REPLY;
}

export function buildMessengerPhoneReceivedReply(
  profile?: Pick<CustomerMessagingProfile, 'selfReference'> | null,
): string {
  return profile?.selfReference === 'ad' ? STUDENT_PHONE_RECEIVED_REPLY : MESSENGER_PHONE_RECEIVED_REPLY;
}

export function containsPhoneRequest(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return PHONE_REQUEST_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function isFillerOnly(text: string): boolean {
  const value = normalized(text).replace(/[.,;:!?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!value) return true;

  // Concrete content (prices, dates, scores) or a clarifying question is a
  // real answer even when the sentence is short.
  if (/\d/u.test(value) || text.includes('?')) return false;

  if (value.length < 20) return true;

  const withoutGreeting = value
    .replace(/^(?:dạ|vâng|ừ|ok|em|ad|anh\/chị|anh\s*chị|chào)\s*/u, '')
    .trim();
  if (withoutGreeting.length < 20) return true;

  return /^(?:để\s+)?(?:em|ad)?\s*(?:đã\s+)?(?:hỗ\s*trợ|tư\s*vấn|ghi\s*nhận|kiểm\s*tra|cảm\s*ơn)(?:\s+tư\s*vấn)?(?:\s+(?:thông\s*tin|chi\s*tiết|cụ\s*thể|yêu\s*cầu))?(?:\s+về\s+[^.!?]+)?$/u.test(
    withoutGreeting,
  );
}

/**
 * Removes a phone/contact request from a draft while preserving any answer or
 * genuine discovery question around it. Returns '' when nothing substantive is
 * left (the caller then uses a non-phone fallback).
 */
export function stripPhoneRequest(draft: string): string {
  if (!draft || typeof draft !== 'string') return '';
  let text = draft;
  for (const pattern of PHONE_REQUEST_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, ' ');
  }
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/([,;])\s*([.!?])/g, '$2')
    .replace(/[,;]\s*$/u, '')
    .replace(/\.\s*\./g, '.')
    .trim();
  if (!text || isFillerOnly(text)) return '';
  return text;
}

/**
 * Final safety net: never send a phone-only draft, and never ask for a phone
 * before the discovery policy allows it. A substantive answer is preserved.
 */
export function applyContactRequestPolicy(
  draft: string,
  profile: CustomerMessagingProfile,
): string {
  if (!draft || typeof draft !== 'string') return '';
  if (!containsPhoneRequest(draft)) return draft;

  if (profile.contactRequestAllowed && !profile.phoneProvided) {
    // A phone request is allowed, but it must not be the whole message.
    return stripPhoneRequest(draft) === '' ? buildMessengerFallbackReply(profile) : draft;
  }

  return stripPhoneRequest(draft) || buildMessengerFallbackReply(profile);
}
